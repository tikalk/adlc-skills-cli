// Command generation — converts SKILL.md files to slash-command files
// in the target agent's native format (markdown, toml, yaml).
// Supports inline mode (embeds full skill body) and wrapper mode (references skill).

import { existsSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_HEADER, GENERATED_TEXT, SOURCE_MARKER } from "./registry.mjs";

// Delete every CLI-generated command file in a directory (marker-matched only;
// user-created files are preserved). Shared by `remove` and `upgrade`. Returns
// the number of files removed.
export function removeGeneratedCommands(absCommandsDir) {
  let removed = 0;
  if (!absCommandsDir || !existsSync(absCommandsDir)) return removed;
  for (const entry of readdirSync(absCommandsDir)) {
    const filepath = join(absCommandsDir, entry);
    if (!statSync(filepath).isFile()) continue;
    if (isGenerated(readFileSync(filepath, "utf-8"))) {
      rmSync(filepath);
      removed++;
    }
  }
  return removed;
}

export function commandFilename(skill, agent, opts = {}) {
  const prefix = opts.prefix ? `${opts.prefix}.` : "";
  return `${prefix}${skill.name}${agent.commands_ext}`;
}

export function generateCommand(skill, agent, opts = {}) {
  const mode = resolveMode(skill, agent, opts);
  const source = opts.source || "unknown";

  switch (agent.format) {
    case "markdown":
      return generateMarkdown(skill, agent, mode, source, opts);
    case "toml":
      return generateToml(skill, agent, mode, source, opts);
    case "yaml":
      return generateYaml(skill, agent, mode, source, opts);
    default:
      return generateMarkdown(skill, agent, mode, source, opts);
  }
}

function resolveMode(skill, agent, opts) {
  if (opts.mode) return opts.mode;
  // User-invoked skills (disable-model-invocation: true) get a special command
  // body on wrapper-default agents. `user_invoked_mode` picks the strategy:
  // "wrapper" (opencode ignores the flag → skill is in <available_skills> →
  // model calls skill({name})) or "execution" (claude-code respects the flag
  // → skill hidden from model → inline the body as imperative steps).
  if (skill.invocation === "user" && agent.default_mode === "wrapper") {
    return agent.user_invoked_mode || "execution";
  }
  return agent.default_mode || "inline";
}

function buildTomlHeader(source) {
  return `# ${GENERATED_TEXT}; ${SOURCE_MARKER} ${source} — do not edit`;
}

function buildYamlHeader(source) {
  return `# ${GENERATED_TEXT}; ${SOURCE_MARKER} ${source} — do not edit`;
}

function buildInlineBody(skill, agent) {
  const baseDir = skill.dir || ".";
  const note = `Base directory for this skill: ${baseDir}\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.`;
  return `${note}\n\n---\n\n${skill.body}`;
}

// Execution-script body for user-invoked skills. Framing the full skill body
// as an imperative workflow forces the model to EXECUTE it (not summarize it
// as documentation). Used when the agent respects disable-model-invocation
// (e.g. claude-code hides such skills from the model, so a skill-tool call
// would fail) — the inlined body is the only working path.
function buildExecutionBody(skill, agent) {
  const baseDir = skill.dir || ".";
  const note = `Base directory for this skill: ${baseDir}\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.`;
  const userInput = buildUserInputBlock(agent);
  return `<EXTREMELY_IMPORTANT>
Execute the following workflow for the user. Do not summarize, explain, or describe it — carry out the steps directly, starting with the first step.
</EXTREMELY_IMPORTANT>

${userInput}

${note}

---

${skill.body}`;
}

function buildWrapperBody(skill, agent) {
  const summary = extractSkillSummary(skill.body);
  const lead = `Invoke the \`${skill.name}\` skill.`;
  const userInput = buildUserInputBlock(agent);
  if (summary) {
    return `${lead}\n\n${summary}\n\n${userInput}`;
  }
  return `${lead}\n\n${userInput}`;
}

// Shared "## User Input" framing block for wrapper and execution modes.
// Presents the agent's args placeholder as workflow input the model should
// consume directly, with an explicit empty-case fallback so the model doesn't
// stall when the user supplied no arguments.
function buildUserInputBlock(agent) {
  const placeholder = agent && agent.args_placeholder;
  if (!placeholder) return "";
  return `## User Input\n\nThe arguments supplied when invoking this command appear below. Read them and use them as input to the skill workflow — do not ask the user to repeat or rephrase what they already provided. If this section is empty, proceed with the skill's default first step.\n\n${placeholder}`;
}

function extractSkillSummary(body) {
  if (!body) return "";

  // 1. Try matching ## Overview, ## Goal, or ## What this skill does
  const overviewMatch = body.match(/##\s*(?:Overview|Goal|What this skill does)[\r\n]+([\s\S]*?)(?=[\r\n]+##|\r?\n\r?\n#|$)/i);
  if (overviewMatch && overviewMatch[1].trim()) {
    const text = overviewMatch[1].trim();
    // Limit to first 2 paragraphs or ~400 chars for conciseness
    const paragraphs = text.split(/\r?\n\r?\n/);
    return paragraphs.slice(0, 2).join("\n\n").trim();
  }

  // 2. Fallback: take content after title up to next ## heading
  const lines = body.split("\n");
  const summaryLines = [];
  let pastTitle = false;
  for (const line of lines) {
    if (line.startsWith("# ")) {
      pastTitle = true;
      continue;
    }
    if (line.startsWith("## ")) {
      if (summaryLines.length > 0) break;
      continue;
    }
    if (pastTitle) {
      summaryLines.push(line);
      if (summaryLines.join("\n").length > 400) break;
    }
  }
  return summaryLines.join("\n").trim();
}

function buildArgsLine(agent) {
  if (agent.args_placeholder === "$ARGUMENTS") {
    return "\n\n$ARGUMENTS";
  }
  if (agent.args_placeholder === "{{parameters}}") {
    return "\n\n{{parameters}}";
  }
  if (agent.args_placeholder === "{{args}}") {
    return "\n\n{{args}}";
  }
  return "";
}

function generateMarkdown(skill, agent, mode, source, opts) {
  const header = `${GENERATED_HEADER}; ${SOURCE_MARKER} ${source} — do not edit -->`;
  const description = skill.description || `Invoke the ${skill.name} skill`;
  const body = buildBody(skill, agent, mode);

  let content = `---\ndescription: ${escapeYamlValue(description)}\n---\n\n${header}\n\n${body}`;

  // Wrapper and execution bodies now include the args placeholder inline via
  // buildUserInputBlock; inline appends it only if the body doesn't reference it.
  if (mode === "inline" && !skill.body.includes("$ARGUMENTS")) {
    content += buildArgsLine(agent);
  }

  return content + "\n";
}

function buildBody(skill, agent, mode) {
  if (mode === "execution") return buildExecutionBody(skill, agent);
  if (mode === "wrapper") return buildWrapperBody(skill, agent);
  return buildInlineBody(skill, agent);
}

function generateToml(skill, agent, mode, source, opts) {
  const header = buildTomlHeader(source);
  const description = skill.description || `Invoke the ${skill.name} skill`;
  const body = buildBody(skill, agent, mode);

  let promptBody = body;
  if (mode === "inline" && !body.includes("{{args}}")) {
    promptBody += buildArgsLine(agent);
  }

  const escapedDescription = escapeTomlString(description);
  const escapedPrompt = escapeTomlString(promptBody);

  return `${header}\ndescription = "${escapedDescription}"\n\nprompt = """\n${escapedPrompt}\n"""\n`;
}

function generateYaml(skill, agent, mode, source, opts) {
  const header = buildYamlHeader(source);
  const description = skill.description || `Invoke the ${skill.name} skill`;
  const body = buildBody(skill, agent, mode);

  let promptBody = body;
  if (mode === "inline" && !body.includes("{{args}}")) {
    promptBody += buildArgsLine(agent);
  }

  const indentedBody = indentYaml(promptBody);
  return `${header}\ndescription: "${escapeYamlValue(description)}"\nprompt: |\n${indentedBody}\n`;
}

function escapeYamlValue(value) {
  if (value.includes(":") || value.includes("#") || value.startsWith('"') || value.startsWith("'")) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

function escapeTomlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"').replace(/"/g, '\\"');
}

function indentYaml(text) {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export function isGenerated(content) {
  return content.includes(GENERATED_TEXT);
}

export function extractSource(content) {
  const match = content.match(new RegExp(`${SOURCE_MARKER}\\s+(\\S+)`));
  return match ? match[1] : null;
}
