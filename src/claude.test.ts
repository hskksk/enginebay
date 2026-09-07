import { describe, expect, it } from "vitest";
import {
  applyClaudeCredentialEnv,
  buildClaudeArgs,
  buildClaudeMcpConfig,
  claudeAuthPresent,
} from "./claude.js";
import { join } from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("buildClaudeArgs", () => {
  it("uses isolated MCP, bypass permissions, and stream-json", () => {
    expect(
      buildClaudeArgs({
        prompt: "work on the briefing",
        mcpConfigPath: "/tmp/mcp-config.json",
      }),
    ).toEqual([
      "-p",
      "work on the briefing",
      "--mcp-config",
      "/tmp/mcp-config.json",
      "--strict-mcp-config",
      "--setting-sources",
      "project,local",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("does not pass --bare", () => {
    expect(
      buildClaudeArgs({
        prompt: "continue",
        mcpConfigPath: "/tmp/mcp.json",
      }),
    ).not.toContain("--bare");
  });

  it("omits --model when unset and appends a system prompt when given", () => {
    expect(
      buildClaudeArgs({
        prompt: "go",
        mcpConfigPath: "/tmp/mcp.json",
      }),
    ).not.toContain("--model");
    const args = buildClaudeArgs({
      prompt: "go",
      mcpConfigPath: "/tmp/mcp.json",
      appendSystemPrompt: "You are in a bay.",
      model: "claude-sonnet-5",
    });
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(
      "You are in a bay.",
    );
  });

  it("passes --resume after -p so the prompt is not swallowed", () => {
    const args = buildClaudeArgs({
      prompt: "Continue.",
      mcpConfigPath: "/tmp/mcp.json",
      sessionId: "sess-9",
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("Continue.");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-9");
  });
});

describe("buildClaudeMcpConfig", () => {
  it("names the server enginebay by default and marks alwaysLoad", () => {
    expect(
      buildClaudeMcpConfig({
        command: "/usr/bin/node",
        args: ["/tmp/mcp.js"],
        env: { BOARD_TOKEN: "tok" },
      }),
    ).toEqual({
      mcpServers: {
        enginebay: {
          command: "/usr/bin/node",
          args: ["/tmp/mcp.js"],
          env: { BOARD_TOKEN: "tok" },
          alwaysLoad: true,
        },
      },
    });
  });
});

describe("applyClaudeCredentialEnv", () => {
  it("keeps host HOME semantics by not setting CLAUDE_CONFIG_DIR", () => {
    const env = applyClaudeCredentialEnv(
      { HOME: "/Users/haru", CLAUDE_CONFIG_DIR: "/Users/haru/.claude" },
      {
        HOME: "/Users/haru",
        CLAUDE_CONFIG_DIR: "/Users/haru/.claude",
      },
      "/Users/haru",
    );
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  });

  it("pins a custom host profile as secure-storage only", () => {
    const env = applyClaudeCredentialEnv(
      { CLAUDE_CONFIG_DIR: "/host/.claude-work" },
      { CLAUDE_CONFIG_DIR: "/host/.claude-work" },
      "/Users/haru",
    );
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("/host/.claude-work");
  });
});

describe("claudeAuthPresent", () => {
  it("detects a credentials file under host HOME", async () => {
    const hostHome = await mkdtemp(join(tmpdir(), "enginebay-claude-auth-"));
    await mkdir(join(hostHome, ".claude"), { recursive: true });
    await writeFile(
      join(hostHome, ".claude", ".credentials.json"),
      '{"claudeAiOauth":{}}',
      "utf8",
    );
    const present = claudeAuthPresent(hostHome, {});
    expect(present.found).toBe(true);
    expect(present.detail).toMatch(/credentials file/);
  });
});
