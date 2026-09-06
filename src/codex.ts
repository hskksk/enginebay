import { existsSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { McpStdio } from "./types.js";

export const CODEX_COMMAND = "codex";

const AUTH_FILES = ["auth.json"] as const;

export function hostCodexHome(hostHome: string): string {
  return join(hostHome, ".codex");
}

export async function attachCodexAuth(options: {
  hostCodexHome: string;
  isolatedCodexHome: string;
}): Promise<{ attached: string[] }> {
  await mkdir(options.isolatedCodexHome, { recursive: true });
  const attached: string[] = [];
  for (const fileName of AUTH_FILES) {
    const source = join(options.hostCodexHome, fileName);
    if (!existsSync(source)) {
      continue;
    }
    const dest = join(options.isolatedCodexHome, fileName);
    if (existsSync(dest)) {
      continue;
    }
    await symlink(source, dest);
    attached.push(fileName);
  }
  return { attached };
}

export function buildCodexConfig(options: {
  mcp?: McpStdio;
  instructions?: string;
} = {}): string {
  const lines: string[] = [];
  if (options.instructions && options.instructions.length > 0) {
    lines.push(`developer_instructions = ${tomlString(options.instructions)}`);
  }
  if (options.mcp) {
    if (lines.length > 0) {
      lines.push("");
    }
    const name = options.mcp.name ?? "enginebay";
    lines.push(
      `[mcp_servers.${tomlString(name)}]`,
      `command = ${tomlString(options.mcp.command)}`,
      `args = [${options.mcp.args.map(tomlString).join(", ")}]`,
    );
    const envEntries = Object.entries(options.mcp.env).map(
      ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`,
    );
    if (envEntries.length > 0) {
      lines.push(`env = { ${envEntries.join(", ")} }`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function tomlString(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
