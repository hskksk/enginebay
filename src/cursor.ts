import { existsSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { commandExists } from "./command.js";
import type { McpStdio } from "./types.js";

export const CURSOR_COMMAND = "cursor-agent";
export const CURSOR_COMMAND_ALIASES = ["cursor-agent", "agent"] as const;

const AUTH_FILES = ["auth.json"] as const;

export function hostCursorConfigDir(hostHome: string): string {
  return join(hostHome, ".cursor");
}

export function resolveCursorCommand(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const candidate of CURSOR_COMMAND_ALIASES) {
    if (commandExists(candidate, env)) {
      return candidate;
    }
  }
  return CURSOR_COMMAND;
}

export function buildCursorArgs(options: {
  prompt: string;
  workDir: string;
  model?: string;
  instructions?: string;
}): string[] {
  const prompt =
    options.instructions && options.instructions.length > 0
      ? `${options.instructions}\n\n${options.prompt}`
      : options.prompt;
  const args = [
    "-p",
    "--force",
    "--trust",
    "--approve-mcps",
    "--sandbox",
    "disabled",
    "--output-format",
    "stream-json",
    "--workspace",
    options.workDir,
  ];
  if (options.model && options.model.length > 0) {
    args.push("--model", options.model);
  }
  args.push(prompt);
  return args;
}

export function buildCursorMcpConfig(mcp?: McpStdio): Record<string, unknown> {
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
      },
    },
  };
}

export function buildCursorCliConfig(): Record<string, unknown> {
  return {
    version: 1,
    editor: { vimMode: false },
    permissions: { allow: [], deny: [] },
    approvalMode: "unrestricted",
  };
}

/**
 * Point the child at host login without inheriting global MCP / cli-config.
 * Auth files are symlinked into the isolated CURSOR_CONFIG_DIR.
 */
export async function attachCursorAuth(options: {
  hostConfigDir: string;
  isolatedConfigDir: string;
}): Promise<{ attached: string[] }> {
  await mkdir(options.isolatedConfigDir, { recursive: true });
  const attached: string[] = [];
  if (!existsSync(options.hostConfigDir)) {
    return { attached };
  }
  for (const fileName of AUTH_FILES) {
    const source = join(options.hostConfigDir, fileName);
    if (!existsSync(source)) {
      continue;
    }
    const dest = join(options.isolatedConfigDir, fileName);
    if (existsSync(dest)) {
      continue;
    }
    await symlink(source, dest);
    attached.push(fileName);
  }
  return { attached };
}

export function cursorAuthPresent(
  hostHome: string,
  hostEnv: NodeJS.ProcessEnv,
): { found: boolean; detail: string } {
  if (
    typeof hostEnv.CURSOR_API_KEY === "string" &&
    hostEnv.CURSOR_API_KEY.length > 0
  ) {
    return {
      found: true,
      detail: "CURSOR_API_KEY is set (overrides agent login)",
    };
  }
  const authFile = join(hostCursorConfigDir(hostHome), "auth.json");
  if (existsSync(authFile)) {
    return {
      found: true,
      detail: `Cursor auth file present at ${authFile}`,
    };
  }
  return {
    found: false,
    detail:
      "Cursor login not found (no auth.json or CURSOR_API_KEY). Run agent login on the host, or set CURSOR_API_KEY. macOS Keychain logins still work at runtime because HOME is kept.",
  };
}
