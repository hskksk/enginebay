import { mkdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpStdio } from "./types.js";

export const OPENCODE_COMMAND = "opencode";

const AUTH_FILES = ["auth.json", "auth-v2.json", "mcp-auth.json"] as const;

export function hostOpencodeShareDir(hostHome: string): string {
  return join(hostHome, ".local", "share", "opencode");
}

export function buildOpencodeArgs(options: {
  workDir: string;
  prompt: string;
  model?: string;
  sessionId?: string;
}): string[] {
  const args = [
    "run",
    "--format",
    "json",
    "--dangerously-skip-permissions",
    "--dir",
    options.workDir,
  ];
  if (options.sessionId && options.sessionId.length > 0) {
    args.push("--session", options.sessionId);
  }
  if (options.model && options.model.length > 0) {
    args.push("--model", options.model);
  }
  args.push(options.prompt);
  return args;
}

export function buildOpencodeMcpConfig(options: {
  mcp?: McpStdio;
  instructionsPath?: string;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (options.mcp) {
    const name = options.mcp.name ?? "enginebay";
    config.mcp = {
      [name]: {
        type: "local",
        command: [options.mcp.command, ...options.mcp.args],
        enabled: true,
        environment: options.mcp.env,
      },
    };
  }
  if (options.instructionsPath) {
    config.instructions = [options.instructionsPath];
  }
  return config;
}

export async function attachOpencodeAuth(options: {
  hostShareDir: string;
  isolatedShareDir: string;
}): Promise<{ attached: string[] }> {
  const destDir = join(options.isolatedShareDir, "opencode");
  await mkdir(destDir, { recursive: true });
  const attached: string[] = [];
  if (!existsSync(options.hostShareDir)) {
    return { attached };
  }
  for (const fileName of AUTH_FILES) {
    const source = join(options.hostShareDir, fileName);
    if (!existsSync(source)) {
      continue;
    }
    const dest = join(destDir, fileName);
    if (existsSync(dest)) {
      continue;
    }
    await symlink(source, dest);
    attached.push(fileName);
  }
  return { attached };
}

export function opencodeAuthPresent(hostShareDir: string): boolean {
  if (!existsSync(hostShareDir)) {
    return false;
  }
  return AUTH_FILES.some((fileName) =>
    existsSync(join(hostShareDir, fileName)),
  );
}
