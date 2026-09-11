import { join } from "node:path";
import { existsSync } from "node:fs";
import type { McpStdio } from "./types.js";

export const CLAUDE_COMMAND = "claude";
export const CLAUDE_COMMAND_ALIASES = ["claude", "claude-code"] as const;

export function hostClaudeCredentialsPath(hostHome: string): string {
  return join(hostHome, ".claude", ".credentials.json");
}

export function buildClaudeArgs(options: {
  prompt: string;
  mcpConfigPath: string;
  appendSystemPrompt?: string;
  model?: string;
  sessionId?: string;
}): string[] {
  // Do not pass --bare: it skips OAuth / Keychain credentials.
  const args = [
    "-p",
    options.prompt,
    "--mcp-config",
    options.mcpConfigPath,
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (options.sessionId && options.sessionId.length > 0) {
    args.push("--resume", options.sessionId);
  }
  if (options.model && options.model.length > 0) {
    args.push("--model", options.model);
  }
  if (options.appendSystemPrompt && options.appendSystemPrompt.length > 0) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  return args;
}

export function buildClaudeMcpConfig(mcp?: McpStdio): Record<string, unknown> {
  if (!mcp) {
    return { mcpServers: {} };
  }
  const name = mcp.name ?? "enginebay";
  return {
    mcpServers: {
      [name]: {
        command: mcp.command,
        args: mcp.args,
        env: mcp.env,
        alwaysLoad: true as const,
      },
    },
  };
}

/**
 * Point the child at the host login without namespacing macOS Keychain.
 * Never set CLAUDE_CONFIG_DIR on the child.
 */
export function applyClaudeCredentialEnv(
  env: NodeJS.ProcessEnv,
  hostEnv: NodeJS.ProcessEnv,
  hostHome: string,
): NodeJS.ProcessEnv {
  let pin = "";
  if (
    Object.prototype.hasOwnProperty.call(hostEnv, "CLAUDE_SECURESTORAGE_CONFIG_DIR")
  ) {
    pin = hostEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? "";
  } else if (
    typeof hostEnv.CLAUDE_CONFIG_DIR === "string" &&
    hostEnv.CLAUDE_CONFIG_DIR.length > 0 &&
    hostEnv.CLAUDE_CONFIG_DIR !== join(hostHome, ".claude")
  ) {
    pin = hostEnv.CLAUDE_CONFIG_DIR;
  }
  delete env.CLAUDE_CONFIG_DIR;
  if (pin.length > 0) {
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = pin;
  } else {
    delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  }
  return env;
}

export function claudeAuthPresent(
  hostHome: string,
  hostEnv: NodeJS.ProcessEnv,
): { found: boolean; detail: string } {
  if (
    typeof hostEnv.ANTHROPIC_API_KEY === "string" &&
    hostEnv.ANTHROPIC_API_KEY.length > 0
  ) {
    return { found: true, detail: "ANTHROPIC_API_KEY is set (overrides claude login)" };
  }
  if (
    typeof hostEnv.CLAUDE_CODE_OAUTH_TOKEN === "string" &&
    hostEnv.CLAUDE_CODE_OAUTH_TOKEN.length > 0
  ) {
    return { found: true, detail: "CLAUDE_CODE_OAUTH_TOKEN is set" };
  }
  const credentials = hostClaudeCredentialsPath(hostHome);
  if (existsSync(credentials)) {
    return {
      found: true,
      detail: `Claude credentials file present at ${credentials}`,
    };
  }
  return {
    found: false,
    detail:
      "Claude login not found (no credentials file, API key, or OAuth token). Run claude login on the host. macOS Keychain logins still work at runtime because HOME is kept.",
  };
}
