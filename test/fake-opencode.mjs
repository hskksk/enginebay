#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("1.0.0-fake\n");
  process.exit(0);
}

const dumpDir = process.env.ENGINEBAY_DUMP_DIR;
let spawnCount = 0;
if (dumpDir) {
  mkdirSync(dumpDir, { recursive: true });
  const isolatedShare = join(process.env.XDG_DATA_HOME ?? "", "opencode");
  let isolatedShareFiles = [];
  try {
    isolatedShareFiles = readdirSync(isolatedShare);
  } catch {
    isolatedShareFiles = [];
  }
  const isolatedCursor = process.env.CURSOR_CONFIG_DIR ?? "";
  let isolatedCursorFiles = [];
  try {
    isolatedCursorFiles = readdirSync(isolatedCursor);
  } catch {
    isolatedCursorFiles = [];
  }
  const codexHome = process.env.CODEX_HOME ?? "";
  let codexFiles = [];
  try {
    codexFiles = readdirSync(codexHome);
  } catch {
    codexFiles = [];
  }
  const codexConfigPath = join(codexHome, "config.toml");
  const mcpConfigIndex = process.argv.indexOf("--mcp-config");
  const mcpConfigPath =
    mcpConfigIndex >= 0 ? process.argv[mcpConfigIndex + 1] : undefined;
  const gitConfigPath = process.env.GIT_CONFIG_GLOBAL;
  const countPath = join(dumpDir, "count");
  spawnCount = existsSync(countPath)
    ? Number(readFileSync(countPath, "utf8")) + 1
    : 1;
  writeFileSync(countPath, `${spawnCount}\n`);
  const argvJson = `${JSON.stringify(process.argv.slice(2), null, 2)}\n`;
  writeFileSync(join(dumpDir, "argv.json"), argvJson);
  writeFileSync(join(dumpDir, `argv-${spawnCount}.json`), argvJson);
  writeFileSync(
    join(dumpDir, "env.json"),
    `${JSON.stringify(
      {
        cwd: process.cwd(),
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        XDG_CONFIG_DIRS: process.env.XDG_CONFIG_DIRS,
        OPENCODE_DISABLE_GLOBAL_CONFIG: process.env.OPENCODE_DISABLE_GLOBAL_CONFIG,
        OPENCODE_DISABLE_CLAUDE_CODE: process.env.OPENCODE_DISABLE_CLAUDE_CODE,
        OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
        GH_TOKEN: process.env.GH_TOKEN,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        gitConfig:
          gitConfigPath &&
          gitConfigPath !== "/dev/null" &&
          existsSync(gitConfigPath)
            ? readFileSync(gitConfigPath, "utf8")
            : undefined,
        GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
        MCP_CONNECTION_NONBLOCKING: process.env.MCP_CONNECTION_NONBLOCKING,
        CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR,
        CODEX_HOME: process.env.CODEX_HOME,
        codexFiles,
        codexConfig: existsSync(codexConfigPath)
          ? readFileSync(codexConfigPath, "utf8")
          : undefined,
        mcpConfig:
          mcpConfigPath && existsSync(mcpConfigPath)
            ? readFileSync(mcpConfigPath, "utf8")
            : undefined,
        isolatedShareFiles,
        isolatedCursorFiles,
      },
      null,
      2,
    )}\n`,
  );
}

const hangFirst =
  Boolean(process.env.ENGINEBAY_FAKE_HANG) &&
  process.env.ENGINEBAY_FAKE_HANG.length > 0 &&
  spawnCount <= 1;
function sessionLine(id) {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: id,
    sessionID: id,
  });
}

if (hangFirst) {
  if (process.env.ENGINEBAY_FAKE_IGNORE_SIGTERM === "1") {
    process.on("SIGTERM", () => {
      /* only SIGKILL can stop this one */
    });
  }
  const sigtermDelayMs = Number(process.env.ENGINEBAY_FAKE_SIGTERM_DELAY_MS ?? "0");
  if (Number.isFinite(sigtermDelayMs) && sigtermDelayMs > 0) {
    process.on("SIGTERM", () => {
      setTimeout(() => process.exit(0), sigtermDelayMs);
    });
  }
  setInterval(() => {
    /* keep the event loop alive until the signal lands */
  }, 60_000);
  // Written last: the pid file is what tells the test the handlers are ready.
  if (dumpDir) {
    writeFileSync(join(dumpDir, "pid"), `${process.pid}\n`);
  }
} else {
  const argv = process.argv.slice(2);
  const isResume =
    argv.includes("--resume") ||
    argv.includes("--session") ||
    argv.includes("-s");
  const failUnlessResume = process.env.ENGINEBAY_FAKE_FAIL_UNLESS_RESUME;
  const failCount = Number(process.env.ENGINEBAY_FAKE_FAIL_COUNT ?? "0");
  const failFirstN = Number.isFinite(failCount) ? failCount : 0;
  const explicitSession = process.env.ENGINEBAY_FAKE_SESSION_EVENT;
  const skipSession =
    process.env.ENGINEBAY_FAKE_NO_SESSION === "1" || explicitSession === "";

  let sessionEvent;
  if (!skipSession) {
    if (explicitSession && explicitSession.length > 0) {
      sessionEvent = explicitSession;
    } else if (failFirstN > 0) {
      // A distinct id per process start, like a real resume does.
      sessionEvent = sessionLine(`sess-${spawnCount}`);
    } else if (failUnlessResume && failUnlessResume.length > 0) {
      sessionEvent = sessionLine("sess-recover");
    }
  }
  if (sessionEvent) {
    process.stdout.write(
      sessionEvent.endsWith("\n") ? sessionEvent : `${sessionEvent}\n`,
    );
  }

  if (failFirstN > 0 && spawnCount <= failFirstN) {
    process.stderr.write("ECONNRESET: connection reset\n");
    process.exit(1);
  }

  if (failUnlessResume && failUnlessResume.length > 0 && !isResume) {
    process.stderr.write(
      failUnlessResume.endsWith("\n")
        ? failUnlessResume
        : `${failUnlessResume}\n`,
    );
    process.exit(1);
  }

  const events = process.env.ENGINEBAY_FAKE_EVENTS;
  if (events && events.length > 0) {
    process.stdout.write(events.endsWith("\n") ? events : `${events}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({ type: "text", part: { type: "text", text: "ok" } })}\n`,
    );
  }

  if (process.env.ENGINEBAY_FAKE_STDERR) {
    process.stderr.write(process.env.ENGINEBAY_FAKE_STDERR);
  }

  const code = Number(process.env.ENGINEBAY_FAKE_EXIT ?? "0");
  process.exit(Number.isFinite(code) ? code : 0);
}
