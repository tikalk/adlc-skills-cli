import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  installDispatcher,
  installEvents,
  removeEvents,
  resolveEvents,
  readLocalEventsManifest,
  fetchEventsManifest,
} from "../src/events.mjs";
import {
  EVENT_AGENTS,
  getEventAgentConfig,
  CANONICAL_EVENTS,
  BODY_INJECTION_EVENTS,
  EVENT_MARKER,
  DISPATCHER_REL,
  CONTEXT_ENVELOPES,
  resolveEnvelope,
} from "../src/registry.mjs";

const SAMPLE_MANIFEST = {
  events: {
    session_start: [
      { skill: "team-boot", description: "Bootstrap session", timeout: 60 },
    ],
    user_prompt_submit: [
      { skill: "team-discover", description: "Fetch context", timeout: 30 },
    ],
  },
};

const SESSION_START_ONLY_MANIFEST = {
  events: {
    session_start: [
      { skill: "team-boot", description: "Bootstrap session", timeout: 60 },
    ],
  },
};

function createTestProject(withSkills = true) {
  const dir = mkdtempSync(join(tmpdir(), "adlc-test-"));
  if (withSkills) {
    const skillsDir = join(dir, ".agents", "skills");
    mkdirSync(join(skillsDir, "team-boot"), { recursive: true });
    writeFileSync(
      join(skillsDir, "team-boot", "SKILL.md"),
      `---
name: team-boot
description: Bootstrap session with team context
---

# team-boot

Read .adlc/init-options.json then load constitution.`,
      "utf-8",
    );
    mkdirSync(join(skillsDir, "team-discover"), { recursive: true });
    writeFileSync(
      join(skillsDir, "team-discover", "SKILL.md"),
      `---
name: team-discover
description: Fetch relevant team context
---

# team-discover

Match the prompt against CDR index.`,
      "utf-8",
    );
  }
  return dir;
}

describe("Events: manifest discovery", () => {
  it("reads local .events.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "adlc-manifest-"));
    try {
      writeFileSync(join(dir, ".events.json"), JSON.stringify(SAMPLE_MANIFEST), "utf-8");
      const manifest = readLocalEventsManifest(dir);
      assert.deepEqual(Object.keys(manifest.events), ["session_start", "user_prompt_submit"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no .events.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "adlc-none-"));
    try {
      assert.equal(readLocalEventsManifest(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Events: fetchEventsManifest source resolution", () => {
  it("resolves bare local directory name (no ./ prefix) — git clone <dir> parity", async () => {
    const parent = mkdtempSync(join(tmpdir(), "adlc-bare-"));
    const origCwd = process.cwd();
    try {
      process.chdir(parent);
      const dirName = "adlc-team-skills";
      mkdirSync(join(parent, dirName), { recursive: true });
      writeFileSync(join(parent, dirName, ".events.json"), JSON.stringify(SAMPLE_MANIFEST), "utf-8");

      const manifest = await fetchEventsManifest(dirName);
      assert.ok(manifest, "manifest resolved for bare directory name");
      assert.deepEqual(Object.keys(manifest.events), ["session_start", "user_prompt_submit"]);
    } finally {
      process.chdir(origCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("returns null for non-existent bare name", async () => {
    const parent = mkdtempSync(join(tmpdir(), "adlc-noexist-"));
    const origCwd = process.cwd();
    try {
      process.chdir(parent);
      const manifest = await fetchEventsManifest("does-not-exist");
      assert.equal(manifest, null);
    } finally {
      process.chdir(origCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("explicit ./ prefix still resolves (existing behavior preserved)", async () => {
    const parent = mkdtempSync(join(tmpdir(), "adlc-dotprefix-"));
    const origCwd = process.cwd();
    try {
      process.chdir(parent);
      const dirName = "my-skills";
      mkdirSync(join(parent, dirName), { recursive: true });
      writeFileSync(join(parent, dirName, ".events.json"), JSON.stringify(SESSION_START_ONLY_MANIFEST), "utf-8");

      const manifest = await fetchEventsManifest(`./${dirName}`);
      assert.ok(manifest, "manifest resolved with ./ prefix");
      assert.deepEqual(Object.keys(manifest.events), ["session_start"]);
    } finally {
      process.chdir(origCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("Events: resolution", () => {
  it("resolves events for an event-capable agent", () => {
    const agentConfig = getEventAgentConfig("opencode");
    const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
    assert.ok(resolved.session_start);
    assert.ok(resolved.user_prompt_submit);
    assert.equal(resolved.session_start[0].skill, "team-boot");
    assert.equal(resolved.session_start[0].timeout, 60);
  });

  it("returns empty for empty manifest", () => {
    const agentConfig = getEventAgentConfig("opencode");
    const resolved = resolveEvents(null, agentConfig);
    assert.deepEqual(resolved, {});
  });
});

describe("Events: dispatcher installation", () => {
  it("installs dispatcher to .agents/dispatcher.mjs", () => {
    const projectRoot = createTestProject(false);
    try {
      const path = installDispatcher(projectRoot);
      assert.ok(path.replace(/\\/g, "/").endsWith(".agents/dispatcher.mjs"), `Path: ${path}`);
      assert.ok(existsSync(path));
      const content = readFileSync(path, "utf-8");
      assert.ok(content.includes("Script path") || content.includes("script"));
      assert.ok(content.includes("Body path") || content.includes("body"));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: opencode plugin generation", () => {
  it("generates TS plugin with event hooks", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("opencode", projectRoot, resolved, ".agents/skills");
      assert.equal(result.path, ".opencode/plugin/adlc-skills-events.ts");
      const content = readFileSync(join(projectRoot, result.path), "utf-8");
      assert.ok(content.includes("AdlcEventsPlugin"));
      assert.ok(content.includes("runEvent"));
      assert.ok(content.includes("team-boot"));
      assert.ok(content.includes("team-discover"));
      assert.ok(content.includes("experimental.chat.messages.transform"), "session_start → messages.transform hook");
      assert.ok(content.includes("chat.message"), "user_prompt_submit → chat.message hook");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("chat.message builds a schema-valid TextPart (id/sessionID/messageID)", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("opencode", projectRoot, resolved, ".agents/skills");
      const content = readFileSync(join(projectRoot, ".opencode/plugin/adlc-skills-events.ts"), "utf-8");

      const chatMessage = content.match(/"chat\.message": async \(input, output\) => \{([\s\S]*?)\n    \}/);
      assert.ok(chatMessage, "chat.message handler present");
      assert.ok(chatMessage[1].includes("output.parts.push"), "pushes to output.parts");
      assert.ok(chatMessage[1].includes("sessionID: input.sessionID"), "sessionID from input");
      assert.ok(chatMessage[1].includes("messageID: output.message.id"), "messageID from output.message");
      assert.ok(chatMessage[1].includes('type: "text"'), "type is text");
      assert.ok(chatMessage[1].includes("synthetic: true"), "synthetic flag set");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("chat.message part id is runtime-derived, not a fixed prt_ literal", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("opencode", projectRoot, resolved, ".agents/skills");
      const content = readFileSync(join(projectRoot, ".opencode/plugin/adlc-skills-events.ts"), "utf-8");

      const chatMessage = content.match(/"chat\.message": async \(input, output\) => \{([\s\S]*?)\n    \}/);
      assert.ok(chatMessage, "chat.message handler present");
      // Derives base from the last existing part so the prt brand survives
      // opencode prefix changes; "prt_" only as the empty-parts fallback.
      assert.ok(chatMessage[1].includes("output.parts[output.parts.length - 1]?.id"), "base derived from last part");
      assert.ok(chatMessage[1].includes('?? "prt_"'), "prt_ kept as fallback");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("both hooks degrade gracefully with try/catch, never rethrow", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("opencode", projectRoot, resolved, ".agents/skills");
      const content = readFileSync(join(projectRoot, ".opencode/plugin/adlc-skills-events.ts"), "utf-8");

      const messagesTransform = content.match(/"experimental\.chat\.messages\.transform": async \(_input, output\) => \{([\s\S]*?)\n    \}/);
      assert.ok(messagesTransform, "messages.transform handler present");
      assert.ok(messagesTransform[1].includes("try {"), "messages.transform wrapped in try");
      assert.ok(messagesTransform[1].includes("console.error"), "messages.transform catches and logs");
      assert.ok(!messagesTransform[1].includes("throw"), "messages.transform never rethrows");

      const chatMessage = content.match(/"chat\.message": async \(input, output\) => \{([\s\S]*?)\n    \}/);
      assert.ok(chatMessage, "chat.message handler present");
      assert.ok(chatMessage[1].includes("try {"), "chat.message wrapped in try");
      assert.ok(chatMessage[1].includes("console.error"), "chat.message catches and logs");
      assert.ok(!chatMessage[1].includes("throw"), "chat.message never rethrows");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("session_start handler uses _sessionStartCache to avoid re-spawning on every step", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("opencode", projectRoot, resolved, ".agents/skills");
      const content = readFileSync(join(projectRoot, ".opencode/plugin/adlc-skills-events.ts"), "utf-8");

      // Cache variable declared at module level
      assert.ok(content.includes("_sessionStartCache"), "cache variable present");
      assert.ok(content.includes("Record<string, string>"), "cache typed as Record");

      // messages.transform handler checks cache before running dispatcher
      const messagesTransform = content.match(/"experimental\.chat\.messages\.transform": async \(_input, output\) => \{([\s\S]*?)\n    \}/);
      assert.ok(messagesTransform, "messages.transform handler present");
      assert.ok(messagesTransform[1].includes("_sessionStartCache"), "handler references cache");
      assert.ok(messagesTransform[1].includes("!(_key in _sessionStartCache)"), "handler checks cache before spawn");
      assert.ok(messagesTransform[1].includes("runEvent"), "handler still calls runEvent on cache miss");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("session_start handler invalidates cache when init-options.json changes", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("opencode", projectRoot, resolved, ".agents/skills");
      const content = readFileSync(join(projectRoot, ".opencode/plugin/adlc-skills-events.ts"), "utf-8");

      // statSync import for mtime tracking
      assert.ok(content.includes("statSync"), "statSync imported from node:fs");

      // State tracking variable
      assert.ok(content.includes("_sessionStartState"), "state tracking variable present");

      // messages.transform handler invalidates on state change
      const messagesTransform = content.match(/"experimental\.chat\.messages\.transform": async \(_input, output\) => \{([\s\S]*?)\n    \}/);
      assert.ok(messagesTransform, "messages.transform handler present");
      assert.ok(messagesTransform[1].includes("statSync"), "handler uses statSync to check mtime");
      assert.ok(messagesTransform[1].includes(".adlc/init-options.json"), "handler checks init-options.json");
      assert.ok(messagesTransform[1].includes("_sessionStartState"), "handler references state variable");
      assert.ok(messagesTransform[1].includes("delete _sessionStartCache"), "handler clears cache on state change");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("messages.transform handler injects into first user message with guard", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("opencode", projectRoot, resolved, ".agents/skills");
      const content = readFileSync(join(projectRoot, ".opencode/plugin/adlc-skills-events.ts"), "utf-8");

      const messagesTransform = content.match(/"experimental\.chat\.messages\.transform": async \(_input, output\) => \{([\s\S]*?)\n    \}/);
      assert.ok(messagesTransform, "messages.transform handler present");
      // Injects into first user message (not system prompt)
      assert.ok(messagesTransform[1].includes("firstUser"), "finds first user message");
      assert.ok(messagesTransform[1].includes("unshift"), "unshifts into parts");
      // Guard against double-injection
      assert.ok(messagesTransform[1].includes("EXTREMELY_IMPORTANT"), "guard checks for EXTREMELY_IMPORTANT marker");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("session_start-only manifest generates no chat.message hook", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SESSION_START_ONLY_MANIFEST, agentConfig);
      installEvents("opencode", projectRoot, resolved, ".agents/skills");
      const content = readFileSync(join(projectRoot, ".opencode/plugin/adlc-skills-events.ts"), "utf-8");

      assert.ok(content.includes("experimental.chat.messages.transform"), "messages.transform hook present");
      assert.ok(!content.includes('"chat.message"'), "no chat.message hook for session_start-only manifest");
      assert.ok(!content.includes("team-discover"), "no team-discover reference");
      assert.ok(content.includes("team-boot"), "team-boot present");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Claude Code JSON merge", () => {
  it("merges hooks into existing settings.json preserving user content", () => {
    const projectRoot = createTestProject(false);
    try {
      // Pre-existing settings with user content
      mkdirSync(join(projectRoot, ".claude"));
      writeFileSync(
        join(projectRoot, ".claude", "settings.json"),
        JSON.stringify({ someSetting: true }, null, 2),
        "utf-8",
      );

      const agentConfig = getEventAgentConfig("claude-code");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("claude-code", projectRoot, resolved, ".agents/skills");
      assert.ok(result.merged);

      const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.json"), "utf-8"));
      assert.ok(settings.someSetting, "Pre-existing setting preserved");
      assert.ok(settings.hooks, "Hooks added");
      assert.ok(settings.hooks.SessionStart, "SessionStart hook added");
      assert.ok(settings.hooks.UserPromptSubmit, "UserPromptSubmit hook added");
      assert.equal(settings.hooks.SessionStart[0][EVENT_MARKER], true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("idempotent merge: re-install does not duplicate entries", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("claude-code");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("claude-code", projectRoot, resolved, ".agents/skills");
      installEvents("claude-code", projectRoot, resolved, ".agents/skills");

      const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.json"), "utf-8"));
      assert.equal(settings.hooks.SessionStart.length, 1, "No duplicate SessionStart entries");
      assert.equal(settings.hooks.UserPromptSubmit.length, 1, "No duplicate UserPromptSubmit entries");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("JSONC preservation: malformed JSON aborts, does not reset", () => {
    const projectRoot = createTestProject(false);
    try {
      mkdirSync(join(projectRoot, ".claude"));
      const badJson = '{ "hooks": { broken';
      writeFileSync(join(projectRoot, ".claude", "settings.json"), badJson, "utf-8");

      const agentConfig = getEventAgentConfig("claude-code");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("claude-code", projectRoot, resolved, ".agents/skills");
      assert.equal(result.error, "parse-failed-preserved");

      // File should be UNCHANGED
      const content = readFileSync(join(projectRoot, ".claude", "settings.json"), "utf-8");
      assert.equal(content, badJson, "Malformed file preserved, not reset");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Copilot JSON generation", () => {
  it("generates dedicated hooks file", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("github-copilot");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("github-copilot", projectRoot, resolved, ".agents/skills");
      assert.equal(result.path, ".github/hooks/adlc-skills.json");

      const content = JSON.parse(readFileSync(join(projectRoot, result.path), "utf-8"));
      assert.ok(content.sessionStart);
      assert.ok(content.userPromptSubmitted);
      assert.equal(content.sessionStart[0].type, "command");
      assert.ok(content.sessionStart[0].bash);
      assert.ok(content.sessionStart[0].powershell);
      assert.ok(content.sessionStart[0].bash.includes("/"), "bash uses POSIX paths");
      assert.ok(content.sessionStart[0].powershell.includes("\\"), "powershell uses Windows paths");
      assert.equal(content.sessionStart[0][EVENT_MARKER], true);
      // Context-injection envelope: sessionStart carries top-level
      // additionalContext on BOTH platform variants; userPromptSubmitted
      // (output not processed by Copilot) carries none.
      assert.ok(
        content.sessionStart[0].bash.endsWith(" additionalContext"),
        "sessionStart bash carries additionalContext envelope",
      );
      assert.ok(
        content.sessionStart[0].powershell.endsWith(" additionalContext"),
        "sessionStart powershell carries additionalContext envelope",
      );
      assert.ok(
        !content.userPromptSubmitted[0].bash.includes("additionalContext"),
        "userPromptSubmitted carries no envelope",
      );
      assert.ok(
        !content.userPromptSubmitted[0].powershell.includes("additionalContext"),
        "userPromptSubmitted powershell carries no envelope",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: surgical teardown", () => {
  it("removes marker entries from Claude settings, preserves user hooks", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("claude-code");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("claude-code", projectRoot, resolved, ".agents/skills");

      // Add a user-created hook manually
      const settingsPath = join(projectRoot, ".claude", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      settings.hooks.SessionStart.push({ type: "command", command: "echo user-hook" });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

      // Remove our events
      const result = removeEvents("claude-code", projectRoot);
      assert.equal(result.action, "cleaned");

      const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.equal(after.hooks.SessionStart.length, 1, "Only user hook remains");
      assert.equal(after.hooks.SessionStart[0].command, "echo user-hook");
      assert.equal(after.hooks.UserPromptSubmit, undefined, "Our entries removed");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("deletes opencode plugin file (marker present)", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("opencode", projectRoot, resolved, ".agents/skills");

      const pluginPath = join(projectRoot, ".opencode/plugin/adlc-skills-events.ts");
      assert.ok(existsSync(pluginPath));

      const result = removeEvents("opencode", projectRoot);
      assert.equal(result.action, "deleted");
      assert.ok(!existsSync(pluginPath));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: read-failure preservation (spec-kit #3861)", () => {
  it("unreadable .codex/config.toml aborts install, does not overwrite", () => {
    const projectRoot = createTestProject(false);
    try {
      // A directory at the config path makes readFileSync fail (EISDIR) on
      // every platform — a robust stand-in for EACCES.
      mkdirSync(join(projectRoot, ".codex", "config.toml"), { recursive: true });

      const agentConfig = getEventAgentConfig("codex");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("codex", projectRoot, resolved, ".agents/skills");
      assert.equal(result.error, "read-failed-preserved");
      assert.equal(result.merged, false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("unreadable .codex/config.toml → teardown reports manual, never crashes", () => {
    const projectRoot = createTestProject(false);
    try {
      mkdirSync(join(projectRoot, ".codex", "config.toml"), { recursive: true });
      const result = removeEvents("codex", projectRoot);
      assert.equal(result.action, "manual");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("unreadable opencode plugin → teardown reports manual", () => {
    const projectRoot = createTestProject(false);
    try {
      mkdirSync(join(projectRoot, ".opencode", "plugin", "adlc-skills-events.ts"), { recursive: true });
      const result = removeEvents("opencode", projectRoot);
      assert.equal(result.action, "manual");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: teardown safe-destination (spec-kit R3)", () => {
  it("symlinked .codex/config.toml → teardown refuses, outside file untouched", () => {
    const projectRoot = createTestProject(false);
    const outside = mkdtempSync(join(tmpdir(), "adlc-outside-"));
    try {
      const outsideFile = join(outside, "config.toml");
      writeFileSync(outsideFile, "# user toml\n", "utf-8");
      mkdirSync(join(projectRoot, ".codex"), { recursive: true });
      symlinkSync(outsideFile, join(projectRoot, ".codex", "config.toml"));

      assert.throws(() => removeEvents("codex", projectRoot), /Unsafe destination/);
      assert.equal(readFileSync(outsideFile, "utf-8"), "# user toml\n", "Outside file untouched");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("symlinked .claude/settings.json → teardown refuses, outside file untouched", () => {
    const projectRoot = createTestProject(false);
    const outside = mkdtempSync(join(tmpdir(), "adlc-outside-"));
    try {
      const outsideFile = join(outside, "settings.json");
      writeFileSync(outsideFile, '{"hooks":{}}\n', "utf-8");
      mkdirSync(join(projectRoot, ".claude"), { recursive: true });
      symlinkSync(outsideFile, join(projectRoot, ".claude", "settings.json"));

      assert.throws(() => removeEvents("claude-code", projectRoot), /Unsafe destination/);
      assert.equal(readFileSync(outsideFile, "utf-8"), '{"hooks":{}}\n', "Outside file untouched");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("Events: non-UTF-8 tolerance (spec-kit #3900)", () => {
  it("non-UTF-8 .events.json → null with a warning, not silent", () => {
    const dir = mkdtempSync(join(tmpdir(), "adlc-latin1-"));
    try {
      // Latin-1 encoded: {"events": {}, "note": "café"} with raw 0xE9 for é.
      const latin1 = Buffer.concat([
        Buffer.from('{"events": {}, "note": "caf', "utf-8"),
        Buffer.from([0xe9]),
        Buffer.from('"}', "utf-8"),
      ]);
      writeFileSync(join(dir, ".events.json"), latin1);

      const warnings = [];
      const origWarn = console.warn;
      console.warn = (msg) => warnings.push(String(msg));
      try {
        assert.equal(readLocalEventsManifest(dir), null);
      } finally {
        console.warn = origWarn;
      }
      assert.ok(warnings.some((w) => w.includes("UTF-8")), "warning printed, not silent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("valid UTF-8 .events.json → no warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "adlc-utf8-"));
    try {
      writeFileSync(join(dir, ".events.json"), JSON.stringify(SAMPLE_MANIFEST), "utf-8");
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (msg) => warnings.push(String(msg));
      try {
        assert.ok(readLocalEventsManifest(dir));
      } finally {
        console.warn = origWarn;
      }
      assert.equal(warnings.length, 0, "no warning for valid UTF-8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Events: opencode plugin TS literal escaping (spec-kit S1)", () => {
  it("skill names with quotes are JSON-serialized, not interpolated raw", () => {
    const projectRoot = createTestProject(false);
    try {
      const manifest = {
        events: {
          session_start: [{ skill: 'te"am', timeout: 60 }],
        },
      };
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(manifest, agentConfig);
      installEvents("opencode", projectRoot, resolved, ".agents/skills");
      const content = readFileSync(join(projectRoot, ".opencode/plugin/adlc-skills-events.ts"), "utf-8");

      assert.ok(content.includes(JSON.stringify('te"am')), "skill name serialized as JSON string literal");
      assert.ok(!content.includes('"te"am"'), "no raw interpolation that would break the TS literal");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("skillsDir with backslashes is JSON-serialized in the plugin", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("opencode", projectRoot, resolved, ".agents\\skills");
      const content = readFileSync(join(projectRoot, ".opencode/plugin/adlc-skills-events.ts"), "utf-8");

      assert.ok(
        content.includes(`let SKILLS_DIR = ${JSON.stringify(".agents\\skills")}`),
        "Windows-style skills dir serialized safely",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Dispatcher: execution paths", () => {
  it("body path: outputs skill body when no scripts:", () => {
    const projectRoot = createTestProject(true);
    try {
      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);
      const skillsDir = join(projectRoot, ".agents", "skills");

      const result = spawnSync("node", [dispatcher, "session_start", "team-boot", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      assert.ok(result.stdout.includes("Read .adlc/init-options.json"), "Body output present");
      assert.ok(!result.stdout.startsWith("---"), "Frontmatter stripped");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("script path: runs skill's script when scripts: present", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adlc-script-"));
    try {
      // Create skill with a script
      const skillsDir = join(projectRoot, ".agents", "skills");
      mkdirSync(join(skillsDir, "boot-skill"), { recursive: true });
      writeFileSync(
        join(skillsDir, "boot-skill", "SKILL.md"),
        `---
name: boot-skill
description: Bootstrap with a script
scripts:
  sh: scripts/boot.sh
---

# boot-skill

Body should NOT be output when script runs.`,
        "utf-8",
      );
      mkdirSync(join(skillsDir, "boot-skill", "scripts"), { recursive: true });
      writeFileSync(
        join(skillsDir, "boot-skill", "scripts", "boot.sh"),
        `#!/bin/bash
echo "SCRIPT_OUTPUT: constitution loaded"`,
        "utf-8",
      );
      const scriptPath = join(skillsDir, "boot-skill", "scripts", "boot.sh");
      try { chmodSync(scriptPath, 0o755); } catch {}

      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);

      const result = spawnSync("node", [dispatcher, "session_start", "boot-skill", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      assert.ok(result.stdout.includes("SCRIPT_OUTPUT: constitution loaded"), "Script output present");
      assert.ok(!result.stdout.includes("Body should NOT"), "Body NOT output when script runs");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("ps variant with no pwsh/powershell on PATH → degrades to 'no argv' (fail-open), not ENOENT (spec-kit #4340)", () => {
    const projectRoot = createTestProject(false);
    try {
      const skillsDir = join(projectRoot, ".agents", "skills");
      mkdirSync(join(skillsDir, "ps-skill"), { recursive: true });
      writeFileSync(
        join(skillsDir, "ps-skill", "SKILL.md"),
        `---
name: ps-skill
description: ps-only skill
scripts:
  ps: scripts/boot.ps1
---

# ps-skill

Body injected when script unresolvable.`,
        "utf-8",
      );
      mkdirSync(join(skillsDir, "ps-skill", "scripts"), { recursive: true });
      writeFileSync(join(skillsDir, "ps-skill", "scripts", "boot.ps1"), "exit 0\n", "utf-8");

      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);

      // Scrub PATH so neither pwsh nor powershell can be resolved, regardless
      // of what the host machine has installed. Use process.execPath (absolute)
      // for node itself so the parent spawnSync doesn't need PATH to launch it;
      // the child only needs PATH for its own launcher probe, which must find
      // nothing here.
      const result = spawnSync(process.execPath, [dispatcher, "session_start", "ps-skill", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
        env: { ...process.env, PATH: "" },
      });

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      assert.ok(
        result.stderr.includes("unresolvable"),
        `clean "unresolvable, falling back" logged, got: ${result.stderr}`,
      );
      assert.ok(
        !result.stderr.includes("ENOENT") && !/script error/i.test(result.stderr),
        `no confusing pwsh ENOENT, got: ${result.stderr}`,
      );
      assert.ok(
        result.stdout.includes("Body injected when script unresolvable"),
        "degraded to body injection instead of crashing spawn",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("fail-open: missing skill logs and exits 0", () => {
    const projectRoot = createTestProject(true);
    try {
      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);
      const skillsDir = join(projectRoot, ".agents", "skills");

      const result = spawnSync("node", [dispatcher, "session_start", "nonexistent", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, "fail-open exits 0");
      assert.ok(result.stderr.includes("not found"), "Error logged to stderr");
      assert.equal(result.stdout, "", "No stdout output");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("stdin payload is capped at 1 MiB — truncated with a warning, still runs (spec-kit #3857)", { skip: process.env.CI === "true" }, () => {
    const projectRoot = createTestProject(true);
    try {
      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);
      const skillsDir = join(projectRoot, ".agents", "skills");

      const bigInput = "x".repeat(2 * 1024 * 1024); // 2 MiB
      const result = spawnSync("node", [dispatcher, "session_start", "team-boot", skillsDir, "10"], {
        input: bigInput,
        encoding: "utf-8",
        cwd: projectRoot,
        maxBuffer: 4 * 1024 * 1024,
      });

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      assert.ok(result.stderr.includes("exceeded"), "truncation warning on stderr");
      assert.ok(result.stdout.includes("Read .adlc/init-options.json"), "body still output");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("non-UTF-8 SKILL.md → body injection skipped with a warning (fail-open)", { skip: process.env.CI === "true" }, () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adlc-latin1-skill-"));
    try {
      const skillsDir = join(projectRoot, ".agents", "skills");
      mkdirSync(join(skillsDir, "legacy-skill"), { recursive: true });
      const latin1 = Buffer.concat([
        Buffer.from("---\nname: legacy-skill\ndescription: Legacy\n---\n\n# caf", "utf-8"),
        Buffer.from([0xe9]),
      ]);
      writeFileSync(join(skillsDir, "legacy-skill", "SKILL.md"), latin1);

      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);

      const result = spawnSync("node", [dispatcher, "session_start", "legacy-skill", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, "fail-open exits 0");
      assert.ok(result.stderr.includes("UTF-8"), "warning on stderr");
      assert.equal(result.stdout, "", "no mojibake injected into context");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("envelope: hookSpecificOutput wraps body output as single-line JSON", () => {
    const projectRoot = createTestProject(true);
    try {
      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);
      const skillsDir = join(projectRoot, ".agents", "skills");

      const result = spawnSync(
        "node",
        [dispatcher, "session_start", "team-boot", skillsDir, "10", "hookSpecificOutput"],
        { encoding: "utf-8", cwd: projectRoot },
      );

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(parsed.hookSpecificOutput, "hookSpecificOutput wrapper present");
      assert.ok(
        parsed.hookSpecificOutput.additionalContext.includes("Read .adlc/init-options.json"),
        "Body content inside additionalContext",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("envelope: additionalContext and additional_context use top-level fields", () => {
    const projectRoot = createTestProject(true);
    try {
      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);
      const skillsDir = join(projectRoot, ".agents", "skills");

      const camel = spawnSync(
        "node",
        [dispatcher, "session_start", "team-boot", skillsDir, "10", "additionalContext"],
        { encoding: "utf-8", cwd: projectRoot },
      );
      const camelParsed = JSON.parse(camel.stdout.trim());
      assert.ok(camelParsed.additionalContext.includes("Read .adlc/init-options.json"));

      const snake = spawnSync(
        "node",
        [dispatcher, "session_start", "team-boot", skillsDir, "10", "additional_context"],
        { encoding: "utf-8", cwd: projectRoot },
      );
      const snakeParsed = JSON.parse(snake.stdout.trim());
      assert.ok(snakeParsed.additional_context.includes("Read .adlc/init-options.json"));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("envelope: suppress emits nothing; invalid envelope falls back to plain", () => {
    const projectRoot = createTestProject(true);
    try {
      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);
      const skillsDir = join(projectRoot, ".agents", "skills");

      const suppressed = spawnSync(
        "node",
        [dispatcher, "session_start", "team-boot", skillsDir, "10", "suppress"],
        { encoding: "utf-8", cwd: projectRoot },
      );
      assert.equal(suppressed.status, 0);
      assert.equal(suppressed.stdout, "", "suppress emits no stdout");

      const bogus = spawnSync(
        "node",
        [dispatcher, "session_start", "team-boot", skillsDir, "10", "not-an-envelope"],
        { encoding: "utf-8", cwd: projectRoot },
      );
      assert.ok(bogus.stdout.includes("Read .adlc/init-options.json"), "invalid envelope → plain passthrough");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("envelope: script path output is wrapped too", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adlc-env-script-"));
    try {
      const skillsDir = join(projectRoot, ".agents", "skills");
      mkdirSync(join(skillsDir, "boot-skill"), { recursive: true });
      writeFileSync(
        join(skillsDir, "boot-skill", "SKILL.md"),
        `---
name: boot-skill
description: Script-backed skill
scripts:
  sh: scripts/boot.sh
---

# boot-skill

Body should NOT be output when script runs.`,
        "utf-8",
      );
      mkdirSync(join(skillsDir, "boot-skill", "scripts"), { recursive: true });
      writeFileSync(
        join(skillsDir, "boot-skill", "scripts", "boot.sh"),
        `#!/bin/bash\necho "SCRIPT_OUT"`,
        "utf-8",
      );
      try { chmodSync(join(skillsDir, "boot-skill", "scripts", "boot.sh"), 0o755); } catch {}

      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);

      const result = spawnSync(
        "node",
        [dispatcher, "session_start", "boot-skill", skillsDir, "10", "hookSpecificOutput"],
        { encoding: "utf-8", cwd: projectRoot },
      );

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(
        parsed.hookSpecificOutput.additionalContext.includes("SCRIPT_OUT"),
        "Script stdout wrapped in envelope",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("script path confinement: absolute token rejected (spec-kit #4133)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adlc-abs-"));
    try {
      const skillsDir = join(projectRoot, ".agents", "skills");
      mkdirSync(join(skillsDir, "evil-skill"), { recursive: true });
      const outside = join(tmpdir(), "outside-evil.sh");
      writeFileSync(outside, "#!/bin/bash\necho PWNED\n", "utf-8");
      try { chmodSync(outside, 0o755); } catch {}
      writeFileSync(
        join(skillsDir, "evil-skill", "SKILL.md"),
        `---
name: evil-skill
description: Absolute script path
scripts:
  sh: ${outside}
---

# evil-skill

Body should be injected when script is rejected.`,
        "utf-8",
      );

      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);

      const result = spawnSync("node", [dispatcher, "session_start", "evil-skill", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      assert.ok(!result.stdout.includes("PWNED"), "Host binary did NOT execute");
      assert.ok(result.stdout.includes("Body should be injected"), "Degraded to body injection");
      try { rmSync(outside, { force: true }); } catch {}
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("script path confinement: .. traversal outside project rejected (spec-kit #4133)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adlc-dotdot-"));
    try {
      const skillsDir = join(projectRoot, ".agents", "skills");
      mkdirSync(join(skillsDir, "traversal-skill"), { recursive: true });
      // File outside projectRoot (in tmpdir, one level above projectRoot)
      const outside = join(tmpdir(), "outside-traversal.sh");
      writeFileSync(outside, "#!/bin/bash\necho ESCAPED\n", "utf-8");
      try { chmodSync(outside, 0o755); } catch {}
      // skillDir is 4 levels deep: projectRoot/.agents/skills/traversal-skill
      // ../../../../ goes to parent of projectRoot = tmpdir
      writeFileSync(
        join(skillsDir, "traversal-skill", "SKILL.md"),
        `---
name: traversal-skill
description: Dot-dot traversal
scripts:
  sh: ../../../../outside-traversal.sh
---

# traversal-skill

Body should be injected when traversal is rejected.`,
        "utf-8",
      );

      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);

      const result = spawnSync("node", [dispatcher, "session_start", "traversal-skill", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      assert.ok(!result.stdout.includes("ESCAPED"), "Host binary did NOT execute");
      assert.ok(result.stdout.includes("Body should be injected"), "Degraded to body injection");
      try { rmSync(outside, { force: true }); } catch {}
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("script path confinement: symlink escape rejected (spec-kit #4133)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adlc-symlink-"));
    try {
      const skillsDir = join(projectRoot, ".agents", "skills");
      mkdirSync(join(skillsDir, "sneak-skill"), { recursive: true });
      mkdirSync(join(skillsDir, "sneak-skill", "scripts"), { recursive: true });
      const host = join(tmpdir(), "host-sneak.sh");
      writeFileSync(host, "#!/bin/bash\necho SYMLINKED\n", "utf-8");
      try { chmodSync(host, 0o755); } catch {}
      try {
        symlinkSync(host, join(skillsDir, "sneak-skill", "scripts", "sneak.sh"));
      } catch {
        // Symlinks not available — skip
        try { rmSync(host, { force: true }); } catch {}
        return;
      }

      writeFileSync(
        join(skillsDir, "sneak-skill", "SKILL.md"),
        `---
name: sneak-skill
description: Symlink escape
scripts:
  sh: scripts/sneak.sh
---

# sneak-skill

Body should be injected when symlink is rejected.`,
        "utf-8",
      );

      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);

      const result = spawnSync("node", [dispatcher, "session_start", "sneak-skill", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      assert.ok(!result.stdout.includes("SYMLINKED"), "Symlinked host binary did NOT execute");
      assert.ok(result.stdout.includes("Body should be injected"), "Degraded to body injection");
      try { rmSync(host, { force: true }); } catch {}
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("script path confinement: valid relative script still runs (spec-kit #4133 regression guard)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adlc-valid-rel-"));
    try {
      const skillsDir = join(projectRoot, ".agents", "skills");
      mkdirSync(join(skillsDir, "good-skill"), { recursive: true });
      mkdirSync(join(skillsDir, "good-skill", "scripts"), { recursive: true });
      const scriptPath = join(skillsDir, "good-skill", "scripts", "boot.sh");
      writeFileSync(scriptPath, "#!/bin/bash\necho SAFE_SCRIPT_OK\n", "utf-8");
      try { chmodSync(scriptPath, 0o755); } catch {}
      writeFileSync(
        join(skillsDir, "good-skill", "SKILL.md"),
        `---
name: good-skill
description: Valid relative script
scripts:
  sh: scripts/boot.sh
---

# good-skill

Body should NOT appear when script runs.`,
        "utf-8",
      );

      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);

      const result = spawnSync("node", [dispatcher, "session_start", "good-skill", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      assert.ok(result.stdout.includes("SAFE_SCRIPT_OK"), "Valid script ran successfully");
      assert.ok(!result.stdout.includes("Body should NOT"), "Body NOT output when script runs");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("unreadable skill file → fail-open with warning (spec-kit #3956)", { skip: process.platform === "win32" || (process.getuid && process.getuid() === 0) }, () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adlc-unread-"));
    try {
      const skillsDir = join(projectRoot, ".agents", "skills");
      mkdirSync(join(skillsDir, "perm-skill"), { recursive: true });
      const skillMd = join(skillsDir, "perm-skill", "SKILL.md");
      writeFileSync(
        skillMd,
        `---
name: perm-skill
description: Unreadable skill
---

# perm-skill

Body should NOT be injected when file is unreadable.`,
        "utf-8",
      );
      chmodSync(skillMd, 0o000);

      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);

      const result = spawnSync("node", [dispatcher, "session_start", "perm-skill", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, "fail-open exits 0");
      assert.ok(result.stderr.includes("unreadable"), "warning on stderr");
      assert.equal(result.stdout, "", "no output from unreadable skill");
      try { chmodSync(skillMd, 0o644); } catch {}
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Registry: events data", () => {
  it("has 6 canonical events", () => {
    assert.equal(CANONICAL_EVENTS.length, 6);
    assert.ok(CANONICAL_EVENTS.includes("session_start"));
    assert.ok(CANONICAL_EVENTS.includes("user_prompt_submit"));
    assert.ok(CANONICAL_EVENTS.includes("pre_tool_use"));
    assert.ok(CANONICAL_EVENTS.includes("post_tool_use"));
    assert.ok(CANONICAL_EVENTS.includes("session_end"));
    assert.ok(CANONICAL_EVENTS.includes("stop"));
  });

  it("body injection applies to session_start and user_prompt_submit only", () => {
    assert.ok(BODY_INJECTION_EVENTS.has("session_start"));
    assert.ok(BODY_INJECTION_EVENTS.has("user_prompt_submit"));
    assert.ok(!BODY_INJECTION_EVENTS.has("pre_tool_use"));
    assert.ok(!BODY_INJECTION_EVENTS.has("session_end"));
  });

  it("9 event agents configured", () => {
    const keys = Object.keys(EVENT_AGENTS).sort();
    assert.deepEqual(keys, [
      "claude-code",
      "codex",
      "cursor",
      "devin",
      "gemini-cli",
      "github-copilot",
      "opencode",
      "qwen-code",
      "tabnine-cli",
    ]);
  });

  it("every event agent has canonical_to_native entries for all 6 events (null = unsupported)", () => {
    for (const [key, config] of Object.entries(EVENT_AGENTS)) {
      for (const event of CANONICAL_EVENTS) {
        assert.ok(
          event in config.canonical_to_native,
          `Agent ${key} missing canonical_to_native entry for ${event}`,
        );
      }
    }
  });
});

describe("Events: context-injection envelopes", () => {
  it("envelope builders produce single-line JSON with the right field shape", () => {
    assert.equal(
      CONTEXT_ENVELOPES.hookSpecificOutput("ctx"),
      JSON.stringify({ hookSpecificOutput: { additionalContext: "ctx" } }),
    );
    assert.equal(
      CONTEXT_ENVELOPES.additionalContext("ctx"),
      JSON.stringify({ additionalContext: "ctx" }),
    );
    assert.equal(
      CONTEXT_ENVELOPES.additional_context("ctx"),
      JSON.stringify({ additional_context: "ctx" }),
    );
  });

  it("resolveEnvelope: event key wins, * is fallback, absent → undefined", () => {
    const cfg = { context_envelope: { "*": "suppress", session_start: "hookSpecificOutput" } };
    assert.equal(resolveEnvelope(cfg, "session_start"), "hookSpecificOutput");
    assert.equal(resolveEnvelope(cfg, "pre_tool_use"), "suppress");
    assert.equal(resolveEnvelope({}, "session_start"), undefined);
    assert.equal(resolveEnvelope({ context_envelope: {} }, "session_start"), undefined);
    assert.equal(resolveEnvelope(null, "session_start"), undefined);
  });

  it("plain-stdout agents (claude-code, codex) have no envelope", () => {
    assert.equal(resolveEnvelope(getEventAgentConfig("claude-code"), "session_start"), undefined);
    assert.equal(resolveEnvelope(getEventAgentConfig("codex"), "session_start"), undefined);
    assert.equal(resolveEnvelope(getEventAgentConfig("codex"), "user_prompt_submit"), undefined);
  });

  it("gemini/tabnine/qwen/devin envelope both injectable events, suppress the rest", () => {
    for (const key of ["gemini-cli", "tabnine-cli", "qwen-code", "devin"]) {
      const cfg = getEventAgentConfig(key);
      assert.equal(resolveEnvelope(cfg, "session_start"), "hookSpecificOutput", `${key} session_start`);
      assert.equal(resolveEnvelope(cfg, "user_prompt_submit"), "hookSpecificOutput", `${key} user_prompt_submit`);
      assert.equal(resolveEnvelope(cfg, "pre_tool_use"), "suppress", `${key} pre_tool_use suppressed`);
      assert.equal(resolveEnvelope(cfg, "session_end"), "suppress", `${key} session_end suppressed`);
      assert.equal(resolveEnvelope(cfg, "stop"), "suppress", `${key} stop suppressed`);
    }
  });

  it("copilot envelopes session_start only; cursor envelopes session_start with snake_case", () => {
    const copilot = getEventAgentConfig("github-copilot");
    assert.equal(resolveEnvelope(copilot, "session_start"), "additionalContext");
    // userPromptSubmitted output is not processed → no envelope.
    assert.equal(resolveEnvelope(copilot, "user_prompt_submit"), undefined);

    const cursor = getEventAgentConfig("cursor");
    assert.equal(resolveEnvelope(cursor, "session_start"), "additional_context");
    // beforeSubmitPrompt has no context field → suppressed (JSON parse noise).
    assert.equal(resolveEnvelope(cursor, "user_prompt_submit"), "suppress");
    assert.equal(resolveEnvelope(cursor, "pre_tool_use"), "suppress");
  });
});

describe("Events: Codex TOML generation", () => {
  it("generates TOML config with hooks blocks", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("codex");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("codex", projectRoot, resolved, ".agents/skills");
      assert.equal(result.path, ".codex/config.toml");

      const content = readFileSync(join(projectRoot, result.path), "utf-8");
      assert.ok(content.includes("[[hooks.SessionStart]]"));
      assert.ok(content.includes("[[hooks.UserPromptSubmit]]"));
      assert.ok(content.includes("type = \"command\""));
      assert.ok(content.includes("adlc_skills_marker = true"));
      assert.ok(content.includes("timeout = 60"), "Codex uses seconds");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("idempotent: re-install does not duplicate TOML blocks", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("codex");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("codex", projectRoot, resolved, ".agents/skills");
      installEvents("codex", projectRoot, resolved, ".agents/skills");

      const content = readFileSync(join(projectRoot, ".codex/config.toml"), "utf-8");
      const sessionStartCount = (content.match(/\[\[hooks\.SessionStart\]\]/g) || []).length;
      assert.equal(sessionStartCount, 1, "No duplicate SessionStart TOML blocks");
      // Codex injects plain stdout → no envelope arg appended.
      assert.ok(!content.includes("hookSpecificOutput"), "Codex has no JSON envelope");
      assert.ok(!content.includes("suppress"), "Codex is not suppressed");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("teardown strips marker blocks, preserves user TOML", () => {
    const projectRoot = createTestProject(false);
    try {
      mkdirSync(join(projectRoot, ".codex"), { recursive: true });
      writeFileSync(
        join(projectRoot, ".codex", "config.toml"),
        `# user config\nsome_setting = true\n\n[[hooks.SessionStart]]\nmatcher = "*"\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo user"\n`,
        "utf-8",
      );

      const agentConfig = getEventAgentConfig("codex");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("codex", projectRoot, resolved, ".agents/skills");

      const result = removeEvents("codex", projectRoot);
      assert.equal(result.action, "cleaned");

      const after = readFileSync(join(projectRoot, ".codex/config.toml"), "utf-8");
      assert.ok(after.includes("echo user"), "User hook preserved");
      assert.ok(after.includes("some_setting = true"), "User config preserved");
      assert.ok(!after.includes("adlc_skills_marker"), "Our marker blocks removed");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Gemini ms timeout conversion", () => {
  it("converts timeout to milliseconds", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("gemini-cli");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("gemini-cli", projectRoot, resolved, ".agents/skills");

      const content = JSON.parse(readFileSync(join(projectRoot, result.path), "utf-8"));
      assert.ok(content.hooks.SessionStart, "SessionStart present");
      assert.equal(content.hooks.SessionStart[0].timeout, 60000, "60s → 60000ms");
      assert.equal(content.hooks.BeforeAgent[0].timeout, 30000, "30s → 30000ms");
      assert.ok(content.hooks.SessionStart[0][EVENT_MARKER], "Marker present");
      // Context-injection envelope: Gemini is a JSON-only protocol, so the
      // dispatcher command carries the hookSpecificOutput envelope arg.
      assert.ok(
        content.hooks.SessionStart[0].command.endsWith(" hookSpecificOutput"),
        "SessionStart command carries hookSpecificOutput envelope",
      );
      assert.ok(
        content.hooks.BeforeAgent[0].command.endsWith(" hookSpecificOutput"),
        "BeforeAgent command carries hookSpecificOutput envelope",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses Gemini native event names (BeforeTool, AfterAgent)", () => {
    const projectRoot = createTestProject(false);
    try {
      const manifest = {
        events: {
          pre_tool_use: [{ skill: "audit", timeout: 10 }],
          stop: [{ skill: "cleanup", timeout: 5 }],
        },
      };
      const agentConfig = getEventAgentConfig("gemini-cli");
      const resolved = resolveEvents(manifest, agentConfig);
      installEvents("gemini-cli", projectRoot, resolved, ".agents/skills");

      const content = JSON.parse(readFileSync(join(projectRoot, ".gemini/settings.json"), "utf-8"));
      assert.ok(content.hooks.BeforeTool, "pre_tool_use → BeforeTool");
      assert.ok(content.hooks.AfterAgent, "stop → AfterAgent");
      assert.equal(content.hooks.BeforeTool[0].timeout, 10000, "10s → 10000ms");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Devin root-nested JSON", () => {
  it("generates hooks at root level (no hooks wrapper)", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("devin");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("devin", projectRoot, resolved, ".agents/skills");
      assert.equal(result.path, ".devin/hooks.v1.json");

      const content = JSON.parse(readFileSync(join(projectRoot, result.path), "utf-8"));
      assert.ok(content.SessionStart, "SessionStart at root");
      assert.ok(content.UserPromptSubmit, "UserPromptSubmit at root");
      assert.ok(!content.hooks, "No hooks wrapper (root-nested)");
      assert.equal(content.SessionStart[0][EVENT_MARKER], true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("teardown removes root-level marker entries", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("devin");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("devin", projectRoot, resolved, ".agents/skills");

      // Add a user hook at root
      const path = join(projectRoot, ".devin/hooks.v1.json");
      const data = JSON.parse(readFileSync(path, "utf-8"));
      data.SessionStart.push({ type: "command", command: "echo user" });
      writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");

      const result = removeEvents("devin", projectRoot);
      assert.equal(result.action, "cleaned");

      const after = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(after.SessionStart.length, 1, "User hook preserved");
      assert.equal(after.SessionStart[0].command, "echo user");
      assert.equal(after.UserPromptSubmit, undefined, "Our entries removed");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Tabnine ms timeout", () => {
  it("converts timeout to ms and uses Gemini-compatible names", () => {
    const projectRoot = createTestProject(false);
    try {
      const manifest = {
        events: {
          session_start: [{ skill: "boot", timeout: 45 }],
          post_tool_use: [{ skill: "audit", timeout: 15 }],
        },
      };
      const agentConfig = getEventAgentConfig("tabnine-cli");
      const resolved = resolveEvents(manifest, agentConfig);
      installEvents("tabnine-cli", projectRoot, resolved, ".agents/skills");

      const content = JSON.parse(readFileSync(join(projectRoot, ".tabnine/agent/settings.json"), "utf-8"));
      assert.ok(content.hooks.SessionStart, "SessionStart present");
      assert.ok(content.hooks.AfterTool, "post_tool_use → AfterTool");
      assert.equal(content.hooks.SessionStart[0].timeout, 45000, "45s → 45000ms");
      assert.equal(content.hooks.AfterTool[0].timeout, 15000, "15s → 15000ms");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Qwen ms timeout", () => {
  it("converts timeout to ms", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("qwen-code");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("qwen-code", projectRoot, resolved, ".agents/skills");

      const content = JSON.parse(readFileSync(join(projectRoot, ".qwen/settings.json"), "utf-8"));
      assert.ok(content.hooks.SessionStart, "SessionStart present");
      assert.ok(content.hooks.UserPromptSubmit, "UserPromptSubmit present");
      assert.equal(content.hooks.SessionStart[0].timeout, 60000, "60s → 60000ms");
      assert.equal(content.hooks.UserPromptSubmit[0].timeout, 30000, "30s → 30000ms");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
