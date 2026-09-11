#!/usr/bin/env node
// ADLC agents-cli event dispatcher.
//
// This file is COPIED to <project>/.agents/dispatcher.mjs by adlc-skills-cli.
// It is self-contained (zero runtime deps) and survives CLI uninstall.
//
// Usage: node .agents/dispatcher.mjs <event> <skill> <skills_dir> [timeout] [envelope]
//   event       — canonical event name (session_start, user_prompt_submit, ...)
//   skill       — skill name (matches SKILL.md frontmatter `name`)
//   skills_dir  — project-relative skills directory (e.g. .agents/skills)
//   timeout     — per-handler timeout in seconds (default 60)
//   envelope    — stdout wrapper for the agent's context-injection protocol:
//                 "hookSpecificOutput" | "additionalContext" |
//                 "additional_context" | "suppress" (default: plain passthrough)
//
// Payload is read from stdin (JSON for user_prompt_submit, "{}" otherwise).
// Output goes to stdout → captured by the agent's native hook → injected as
// session context (for JSON-protocol agents, wrapped in the envelope the
// agent's hook schema requires).
//
// Two execution paths (both first-class), dispatched by `scripts:` presence:
//   1. Script path (spec-kit model): run the skill's declared script
//      (sh/ps/py variant) → stdout. Deterministic code for deterministic logic.
//   2. Body path (superpowers model): output the skill's markdown body
//      (frontmatter stripped). LLM-interpreted orientation/instructions.

import { readFileSync, readSync, existsSync, readdirSync, statSync, accessSync, constants, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isatty } from "node:tty";
import { join, resolve, dirname, sep, delimiter, relative, isAbsolute, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT = 60;

// Bound the hook payload read from stdin (spec-kit #3857): an unbounded
// readFileSync(0) lets a hostile or buggy agent exhaust memory on every fire.
const MAX_STDIN_BYTES = 1024 * 1024; // 1 MiB

const BODY_INJECTION_EVENTS = new Set(["session_start", "user_prompt_submit"]);

function main() {
  const [,, event, skillName, skillsDirArg, timeoutArg, envelopeArg] = process.argv;

  if (!event || !skillName) {
    process.stderr.write("dispatcher: missing event or skill name\n");
    process.exit(0); // fail-open for lifecycle events
  }

  const timeout = parseTimeout(timeoutArg);
  const envelope = parseEnvelope(envelopeArg);
  const projectRoot = findProjectRoot();
  const skillsDir = skillsDirArg
    ? resolve(projectRoot, skillsDirArg)
    : findSkillsDir(projectRoot);

  if (!skillsDir || !existsSync(skillsDir)) {
    process.stderr.write(`dispatcher: skills directory not found\n`);
    process.exit(0); // fail-open
  }

  const skillPath = findSkill(skillsDir, skillName);
  if (!skillPath) {
    process.stderr.write(`dispatcher: skill "${skillName}" not found in ${skillsDir}\n`);
    process.exit(0); // fail-open
  }

  let content;
  try {
    content = readFileSync(skillPath, "utf-8");
  } catch {
    process.stderr.write(`dispatcher: skill "${skillName}" is unreadable — skipping\n`);
    process.exit(0); // fail-open
  }
  const { frontmatter, body } = parseFrontmatter(content);
  const payload = readPayload();

  // Path 1: script execution (spec-kit model) — applies to ALL events.
  if (frontmatter && frontmatter.scripts) {
    const argv = resolveScriptArgv(frontmatter.scripts, dirname(skillPath), projectRoot);
    if (argv) {
      try {
        const result = spawnSync(argv[0], argv.slice(1), {
          input: payload,
          encoding: "utf-8",
          timeout: timeout * 1000,
          cwd: projectRoot,
        });
        if (result.stdout) writeOutput(result.stdout, envelope);
        if (result.status !== 0 && result.stderr) {
          process.stderr.write(result.stderr);
        }
        process.exit(result.status || 0);
      } catch (e) {
        process.stderr.write(`dispatcher: script error: ${e.message}\n`);
        process.exit(0); // fail-open
      }
    }
    // Script declared but unresolvable — fall through to body if applicable.
    process.stderr.write(`dispatcher: script for "${skillName}" unresolvable, falling back\n`);
  }

  // Path 2: body injection (superpowers model) — applies to orientation events.
  if (BODY_INJECTION_EVENTS.has(event)) {
    if (content.includes("\uFFFD")) {
      // Non-UTF-8 skill file (spec-kit #3895 class): Node's utf-8 decode
      // substitutes U+FFFD, so injecting the body would push mojibake into
      // the agent's context. Skip instead — fail-open, with a warning.
      process.stderr.write(`dispatcher: skill "${skillName}" is not valid UTF-8 — skipping body injection\n`);
      process.exit(0);
    }
    writeOutput(body, envelope);
    process.exit(0);
  }

  // No script and not a body-injection event → fail-open (spec-kit behavior).
  process.stderr.write(`dispatcher: skill "${skillName}" has no script for event "${event}"\n`);
  process.exit(0);
}

// ── Output wrapping (context-injection envelopes) ───────────────────────

// Write handler output to stdout, wrapped in the JSON envelope the target
// agent's hook protocol requires (see registry.mjs CONTEXT_ENVELOPES).
//   - plain (no envelope): passthrough (Claude/Codex inject plain stdout).
//   - "suppress": emit nothing (strict-JSON agents on non-injectable events).
//   - JSON envelopes: emit a single-line JSON object, only when text is
//     non-empty (an empty additionalContext is useless noise).
function writeOutput(text, envelope) {
  if (!text) return;
  if (envelope === "suppress") return;
  if (envelope === "hookSpecificOutput") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: text } }) + "\n");
    return;
  }
  if (envelope === "additionalContext") {
    process.stdout.write(JSON.stringify({ additionalContext: text }) + "\n");
    return;
  }
  if (envelope === "additional_context") {
    process.stdout.write(JSON.stringify({ additional_context: text }) + "\n");
    return;
  }
  process.stdout.write(text);
}

function parseEnvelope(arg) {
  const valid = new Set(["hookSpecificOutput", "additionalContext", "additional_context", "suppress"]);
  return arg && valid.has(arg) ? arg : null;
}

// ── Skill resolution ────────────────────────────────────────────────────

function findSkillsDir(projectRoot) {
  const candidates = [
    ".agents/skills",
    ".claude/skills",
    ".cursor/skills",
    ".github/skills",
  ];
  for (const c of candidates) {
    const p = join(projectRoot, c);
    if (existsSync(p)) return p;
  }
  return null;
}

function findSkill(skillsDir, skillName) {
  // Direct path: <skillsDir>/<skillName>/SKILL.md
  const direct = join(skillsDir, skillName, "SKILL.md");
  if (existsSync(direct)) return direct;

  // Scan: find a SKILL.md whose frontmatter `name` matches.
  try {
    for (const entry of readdirSync(skillsDir)) {
      const entryPath = join(skillsDir, entry);
      if (!statSync(entryPath).isDirectory()) continue;
      const skillMd = join(entryPath, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const content = readFileSync(skillMd, "utf-8");
      const { frontmatter } = parseFrontmatter(content);
      if (frontmatter && frontmatter.name === skillName) return skillMd;
    }
  } catch {
    // ignore scan errors
  }
  return null;
}

function findProjectRoot() {
  // The dispatcher lives at <projectRoot>/.agents/dispatcher.mjs.
  // Walk up from this file's location to find the project root.
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 5; i++) {
    // If we're inside .agents/, the parent is the project root.
    if (dir.endsWith(".agents") || dir.endsWith(`${sep}.agents`)) {
      return dirname(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume this file's grandparent is the project root.
  return dirname(dirname(here));
}

// ── Script resolution (ported from spec-kit _resolve_event_command_argv) ─

// Resolve a runnable launcher by scanning PATH (mirrors Python's
// shutil.which). Returns the absolute path of the first `names` entry that
// both exists and is executable, or null when none is found — so the ps
// variant can degrade to "no argv" (clean "unresolvable, falling back")
// instead of fabricating a bare "pwsh" that spawnSync would fail to exec
// with a confusing ENOENT (spec-kit #4340).
function findLauncher(names) {
  const pathEnv = process.env.PATH || "";
  if (!pathEnv) return null;
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  // On Windows, PATHEXT lists the executable suffixes to probe; on POSIX a
  // script name carries no extension.
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(delimiter).filter(Boolean)
    : [""];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext);
        if (!existsSync(candidate)) continue;
        try {
          // X_OK is a no-op on Windows (Node never enforces the execute bit
          // there); on POSIX it rejects files present but not executable.
          accessSync(candidate, constants.X_OK);
          return candidate;
        } catch {
          // exists but not executable — keep scanning
        }
      }
    }
  }
  return null;
}

// Confine a script token to the project tree (spec-kit #4133):
// Reject anchored tokens (absolute, drive, UNC) so resolve() can't
// discard the skill directory, and verify the resolved path stays
// inside the project root — including through symlink resolution so
// a relative token that resolves via a symlink out of the project
// cannot execute a host binary.
function confineScriptPath(base, token, projectRoot) {
  if (posix.isAbsolute(token) || win32.isAbsolute(token)) return null;
  const candidate = resolve(base, token);
  const root = resolve(projectRoot);
  // Resolve symlinks on both sides BEFORE comparing, so macOS /var → /private/var
  // doesn't cause a false ".." in the relative path. Return the original
  // (non-realpath) candidate for execution so the path stays consistent with
  // what the caller expects.
  let realCandidate, realRoot;
  try {
    realCandidate = realpathSync(candidate);
    realRoot = realpathSync(root);
  } catch {
    realCandidate = candidate;
    realRoot = root;
  }
  const rel = relative(realRoot, realCandidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

function resolveScriptArgv(scriptsField, skillDir, projectRoot) {
  // scripts: is either a YAML-style string ("sh: scripts/boot.sh\nps: ...")
  // already parsed by our frontmatter parser into an object, or a raw string.
  let scripts = scriptsField;
  if (typeof scripts === "string") {
    scripts = parseScriptsBlock(scriptsField);
  }
  if (!scripts || typeof scripts !== "object") return null;

  const requested = detectScriptVariant();
  const variant = selectVariant(requested, scripts);
  if (!variant) return null;

  const scriptCmd = (scripts[variant] || "").trim();
  if (!scriptCmd) return null;

  // Tokenize the command string (e.g. "scripts/boot.sh --json")
  const tokens = shlexSplit(scriptCmd);
  if (tokens.length === 0) return null;

  const scriptPath = confineScriptPath(skillDir, tokens[0], projectRoot);
  if (scriptPath === null || !existsSync(scriptPath)) return null;

  const rest = tokens.slice(1);

  if (variant === "py") {
    return [process.execPath || "python3", scriptPath, ...rest];
  }
  if (variant === "ps") {
    // Probe for a real launcher (pwsh, then powershell). When neither is on
    // PATH, return null like every other unresolvable branch — NOT a bare
    // "pwsh" argv, which would make spawnSync raise ENOENT (spec-kit #4340).
    const launcher = findLauncher(["pwsh", "powershell"]);
    if (!launcher) return null;
    return [launcher, "-File", scriptPath, ...rest];
  }
  // sh: direct on POSIX; bash launcher on Windows.
  if (process.platform === "win32") {
    // Git Bash treats backslashes as escape characters, so normalize the
    // script path to forward slashes (bash accepts D:/a/.../boot.sh).
    return ["bash", scriptPath.replace(/\\/g, "/"), ...rest];
  }
  return [scriptPath, ...rest];
}

function parseScriptsBlock(raw) {
  // Parse a simple "key: value" block (sh/ps/py) from a raw string.
  const result = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\w+)\s*:\s*(.+)$/);
    if (m) result[m[1].trim()] = m[2].trim();
  }
  return result;
}

function detectScriptVariant() {
  // Could read a project config; for now, platform default.
  return process.platform === "win32" ? "ps" : "sh";
}

function selectVariant(requested, scripts) {
  if (scripts[requested]) return requested;
  const fallbacks = ["sh", "ps", "py"];
  for (const f of fallbacks) {
    if (scripts[f]) return f;
  }
  return null;
}

function shlexSplit(str) {
  // Simple POSIX-style split (no escape edge cases for typical script paths).
  const result = [];
  let current = "";
  let inQuote = null;
  for (const ch of str) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        result.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) result.push(current);
  return result;
}

// ── Frontmatter parsing ─────────────────────────────────────────────────

function parseFrontmatter(content) {
  if (!content.startsWith("---")) return { frontmatter: null, body: content };
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter: null, body: content };

  const raw = content.slice(3, endIndex).trim();
  const bodyStart = endIndex + 4;
  const body = content.slice(bodyStart).replace(/^[\n\r]+/, "");

  const frontmatter = parseSimpleYaml(raw);
  return { frontmatter, body };
}

function parseSimpleYaml(raw) {
  const result = {};
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1];
    let value = match[2].trim();

    // Multi-line block (scripts:, etc.) — collect indented subsequent lines.
    if (value === "" || value === "|" || value === ">") {
      const folded = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].startsWith("\t") || lines[i].trim() === "")) {
        folded.push(lines[i]);
        i++;
      }
      // For scripts: keep as a sub-object; for | keep as string.
      if (key === "scripts") {
        result[key] = parseScriptsBlock(folded.join("\n"));
      } else {
        result[key] = folded.join("\n").trim();
      }
      continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
    i++;
  }
  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function parseTimeout(arg) {
  if (!arg) return DEFAULT_TIMEOUT;
  const n = parseInt(arg, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT;
}

function readPayload() {
  // Read stdin if available (non-tty), bounded at MAX_STDIN_BYTES. For
  // user_prompt_submit the agent pipes the user's prompt as JSON. Oversized
  // payloads are truncated with a warning rather than buffered whole
  // (fail-open keeps the agent session alive either way).
  //
  // NOTE: tty.isatty(0), never process.stdin.isTTY — merely referencing
  // process.stdin switches fd 0 to non-blocking mode, which makes readSync
  // throw EAGAIN instead of reading the piped payload.
  try {
    if (isatty(0)) return "{}";
    const chunks = [];
    let total = 0;
    let truncated = false;
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(0, buf, 0, buf.length, null);
      if (n === 0) break; // EOF
      const remaining = MAX_STDIN_BYTES - total;
      if (n > remaining) {
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        truncated = true;
        break;
      }
      chunks.push(buf.subarray(0, n));
      total += n;
    }
    if (truncated) {
      process.stderr.write(`dispatcher: stdin payload exceeded ${MAX_STDIN_BYTES} bytes — truncated\n`);
    }
    return Buffer.concat(chunks).toString("utf-8");
  } catch {
    // stdin not available
    return "{}";
  }
}

main();
