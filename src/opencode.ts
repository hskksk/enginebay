import { mkdir, readdir, symlink, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig, McpStdio } from "./types.js";

export const OPENCODE_COMMAND = "opencode";

const AUTH_FILES = ["auth.json", "auth-v2.json", "mcp-auth.json"] as const;

const OPENCODE_SUBCOMMANDS = new Set([
  "run",
  "auth",
  "serve",
  "web",
  "acp",
  "tui",
  "stats",
  "models",
  "agent",
  "session",
  "export",
  "import",
  "github",
  "pr",
  "issue",
  "mcp",
  "plugin",
  "upgrade",
  "uninstall",
]);

export function hostOpencodeShareDir(hostHome: string): string {
  return join(hostHome, ".local", "share", "opencode");
}

export function argsHaveFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function firstNonFlag(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg === "--") {
      return undefined;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return undefined;
}

function pushFlag(args: string[], flag: string, value: string | undefined): void {
  if (!value || value.length === 0 || argsHaveFlag(args, flag)) {
    return;
  }
  args.push(flag, value);
}

export function buildOpencodeArgs(options: {
  workDir: string;
  prompt: string;
  model?: string;
  agent?: string;
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
  if (options.agent && options.agent.length > 0) {
    args.push("--agent", options.agent);
  }
  args.push(options.prompt);
  return args;
}

/**
 * Interactive OpenCode argv. Default is `run --interactive --dir`.
 * A full native subcommand in `args` is forwarded as-is (no default prepend).
 */
export function buildOpencodeLaunchArgs(options: {
  workDir: string;
  model?: string;
  agent?: string;
  sessionId?: string;
  continueLast?: boolean;
  args?: string[];
}): string[] {
  if (
    options.sessionId &&
    options.sessionId.length > 0 &&
    options.continueLast
  ) {
    throw new Error("enginebay: set either sessionId or continueLast, not both");
  }
  const extras = options.args ?? [];
  const subcommand = firstNonFlag(extras);
  const forwardSubcommand =
    subcommand !== undefined && OPENCODE_SUBCOMMANDS.has(subcommand);
  if (forwardSubcommand) {
    const args = [...extras];
    pushFlag(args, "--model", options.model);
    pushFlag(args, "--agent", options.agent);
    if (options.sessionId && options.sessionId.length > 0) {
      pushFlag(args, "--session", options.sessionId);
    } else if (options.continueLast && !argsHaveFlag(args, "--continue")) {
      args.push("--continue");
    }
    return args;
  }
  const args = ["run"];
  if (!argsHaveFlag(extras, "--interactive")) {
    args.push("--interactive");
  }
  if (!argsHaveFlag(extras, "--dir")) {
    args.push("--dir", options.workDir);
  }
  if (!argsHaveFlag(extras, "--dangerously-skip-permissions")) {
    args.push("--dangerously-skip-permissions");
  }
  if (!argsHaveFlag(extras, "--model")) {
    pushFlag(args, "--model", options.model);
  }
  if (!argsHaveFlag(extras, "--agent")) {
    pushFlag(args, "--agent", options.agent);
  }
  if (options.sessionId && options.sessionId.length > 0) {
    if (!argsHaveFlag(extras, "--session")) {
      pushFlag(args, "--session", options.sessionId);
    }
  } else if (options.continueLast && !argsHaveFlag(extras, "--continue")) {
    args.push("--continue");
  }
  args.push(...extras);
  return args;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function parseConfigJson(text: string | undefined): Record<string, unknown> {
  if (!text || text.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const rec = asRecord(parsed);
    if (!rec) {
      throw new Error("not an object");
    }
    return rec;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `enginebay: extraEnv.OPENCODE_CONFIG_CONTENT must be a JSON object (${detail})`,
    );
  }
}

export function buildOpencodeMcpConfig(options: {
  mcp?: McpStdio;
  instructionsPath?: string;
  plugins?: string[];
  extra?: Record<string, unknown>;
  extraEnvContent?: string;
}): Record<string, unknown> {
  const fromEnv = parseConfigJson(options.extraEnvContent);
  const extra = { ...fromEnv, ...(options.extra ?? {}) };
  delete extra.mcp;
  delete extra.instructions;
  const config: Record<string, unknown> = { ...extra };
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
  if (options.plugins && options.plugins.length > 0) {
    config.plugin = options.plugins;
  }
  return config;
}

export function buildOpencodeConfigContent(options: {
  mcp?: McpStdio;
  instructionsPath?: string;
  config?: EngineConfig;
  extraEnv?: Record<string, string>;
}): string {
  return JSON.stringify(
    buildOpencodeMcpConfig({
      mcp: options.mcp,
      instructionsPath: options.instructionsPath,
      plugins: options.config?.plugins,
      extra: options.config?.extra,
      extraEnvContent: options.extraEnv?.OPENCODE_CONFIG_CONTENT,
    }),
  );
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

export async function resetOpencodeSession(dataHome: string): Promise<void> {
  const dir = join(dataHome, "opencode");
  if (!existsSync(dir)) {
    return;
  }
  const entries = await readdir(dir);
  await Promise.all(
    entries
      .filter((name) => name === "opencode.db" || name.startsWith("opencode.db"))
      .map((name) => unlink(join(dir, name))),
  );
}

export function opencodeAuthPresent(hostShareDir: string): boolean {
  if (!existsSync(hostShareDir)) {
    return false;
  }
  return AUTH_FILES.some((fileName) =>
    existsSync(join(hostShareDir, fileName)),
  );
}
