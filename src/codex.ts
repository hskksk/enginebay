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

export function buildCodexConfig(mcp?: McpStdio): string {
  if (!mcp) {
    return "";
  }
  const name = mcp.name ?? "enginebay";
  const lines = [
    `[mcp_servers.${tomlString(name)}]`,
    `command = ${tomlString(mcp.command)}`,
    `args = [${mcp.args.map(tomlString).join(", ")}]`,
  ];
  const envEntries = Object.entries(mcp.env).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`,
  );
  if (envEntries.length > 0) {
    lines.push(`env = { ${envEntries.join(", ")} }`);
  }
  return `${lines.join("\n")}\n`;
}

function tomlString(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
