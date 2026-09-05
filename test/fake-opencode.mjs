#!/usr/bin/env node
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("1.0.0-fake\n");
  process.exit(0);
}

const dumpDir = process.env.ENGINEBAY_DUMP_DIR;
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
  writeFileSync(
    join(dumpDir, "argv.json"),
    `${JSON.stringify(process.argv.slice(2), null, 2)}\n`,
  );
  writeFileSync(
    join(dumpDir, "env.json"),
    `${JSON.stringify(
      {
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
        GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
        MCP_CONNECTION_NONBLOCKING: process.env.MCP_CONNECTION_NONBLOCKING,
        CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR,
        isolatedShareFiles,
        isolatedCursorFiles,
      },
      null,
      2,
    )}\n`,
  );
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
