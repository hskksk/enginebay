import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyClaudeCredentialEnv,
  buildClaudeMcpConfig,
  CLAUDE_COMMAND,
} from "./claude.js";
import {
  attachCodexAuth,
  buildCodexConfig,
  CODEX_COMMAND,
  hostCodexHome,
} from "./codex.js";
import {
  attachCursorAuth,
  buildCursorCliConfig,
  buildCursorMcpConfig,
  hostCursorConfigDir,
  resolveCursorCommand,
} from "./cursor.js";
import {
  buildChildEnv,
  extraEnvGitToken,
  extraEnvHasGitToken,
  resolveHostHome,
} from "./env.js";
import { writeIsolatedGitconfig } from "./gitconfig.js";
import {
  attachOpencodeAuth,
  buildOpencodeMcpConfig,
  hostOpencodeShareDir,
  OPENCODE_COMMAND,
} from "./opencode.js";
import type { McpStdio } from "./types.js";

export const LAUNCH_ENGINE_IDS = [
  "codex",
  "opencode",
  "claude-code",
  "cursor-agent",
] as const;
export type LaunchEngineId = (typeof LAUNCH_ENGINE_IDS)[number];

export type LaunchEngineOptions = {
  engine: LaunchEngineId;
  /** Arguments forwarded to the engine CLI without interpretation. */
  args?: string[];
  /** Child cwd. Defaults to the current working directory. */
  workDir?: string;
  /** Optional session-scoped MCP server. */
  mcp?: McpStdio;
  /** Merged last. Host GitHub tokens are otherwise stripped. */
  extraEnv?: Record<string, string>;
  git?: { committerName?: string };
  /** Override host process.env / home in tests. */
  hostEnv?: NodeJS.ProcessEnv;
  hostHome?: string;
};

type PreparedLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
};

const RM_OPTS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
} as const;

const FORWARDED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
const SIGNAL_EXIT_CODES: Record<(typeof FORWARDED_SIGNALS)[number], number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export function isLaunchEngineId(value: string): value is LaunchEngineId {
  return (LAUNCH_ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * Launch an engine in a disposable bay while keeping its terminal interactive.
 * The engine's argv is forwarded verbatim; enginebay only adds isolation
 * through environment variables and engine-specific config.
 */
export async function launchEngine(
  options: LaunchEngineOptions,
): Promise<number> {
  const prepared = await prepareLaunch(options);
  try {
    return await runInteractive(prepared);
  } finally {
    await prepared.cleanup();
  }
}

async function prepareLaunch(
  options: LaunchEngineOptions,
): Promise<PreparedLaunch> {
  const hostEnv = options.hostEnv ?? process.env;
  const hostHome = resolveHostHome(hostEnv, options.hostHome);
  const cwd = resolve(options.workDir ?? process.cwd());
  await mkdir(cwd, { recursive: true });
  const runtimeDir = await mkdtemp(join(tmpdir(), "enginebay-launch-"));
  const extraEnv = options.extraEnv ?? {};
  const gitconfigPath = join(runtimeDir, "gitconfig");
  const hasGitToken = extraEnvHasGitToken(extraEnv);
  const token = extraEnvGitToken(extraEnv);
  if (token) {
    await writeIsolatedGitconfig(gitconfigPath, {
      token,
      committerName: options.git?.committerName ?? "enginebay",
    });
  }

  const common = {
    args: [...(options.args ?? [])],
    cwd,
    cleanup: () => rm(runtimeDir, RM_OPTS),
  };

  if (options.engine === "codex") {
    const codexHome = join(runtimeDir, "codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      buildCodexConfig(options.mcp),
      "utf8",
    );
    await attachCodexAuth({
      hostCodexHome: hostCodexHome(hostHome),
      isolatedCodexHome: codexHome,
    });
    return {
      ...common,
      command: CODEX_COMMAND,
      env: buildChildEnv({
        hostEnv,
        extraEnv,
        overrides: {
          HOME: hostHome,
          CODEX_HOME: codexHome,
          GIT_CONFIG_GLOBAL: hasGitToken ? gitconfigPath : "/dev/null",
        },
      }),
    };
  }

  if (options.engine === "opencode") {
    const isolatedHome = join(runtimeDir, "home");
    const xdgConfig = join(runtimeDir, "config");
    const xdgState = join(runtimeDir, "state");
    const xdgCache = join(runtimeDir, "cache");
    const xdgData = join(runtimeDir, "share");
    await Promise.all(
      [isolatedHome, xdgConfig, xdgState, xdgCache, xdgData].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    await attachOpencodeAuth({
      hostShareDir: hostOpencodeShareDir(hostHome),
      isolatedShareDir: xdgData,
    });
    return {
      ...common,
      command: OPENCODE_COMMAND,
      env: buildChildEnv({
        hostEnv,
        extraEnv,
        overrides: {
          HOME: isolatedHome,
          XDG_CONFIG_HOME: xdgConfig,
          XDG_STATE_HOME: xdgState,
          XDG_CACHE_HOME: xdgCache,
          XDG_DATA_HOME: xdgData,
          XDG_CONFIG_DIRS: "",
          OPENCODE_DISABLE_GLOBAL_CONFIG: "1",
          OPENCODE_DISABLE_CLAUDE_CODE: "1",
          OPENCODE_CONFIG_CONTENT: JSON.stringify(
            buildOpencodeMcpConfig({ mcp: options.mcp }),
          ),
          GIT_CONFIG_GLOBAL: hasGitToken ? gitconfigPath : "/dev/null",
        },
      }),
    };
  }

  if (options.engine === "claude-code") {
    const mcpConfigPath = join(runtimeDir, "mcp-config.json");
    await writeFile(
      mcpConfigPath,
      `${JSON.stringify(buildClaudeMcpConfig(options.mcp))}\n`,
      "utf8",
    );
    const env = buildChildEnv({
      hostEnv,
      extraEnv,
      overrides: {
        HOME: hostHome,
        GIT_CONFIG_GLOBAL: hasGitToken ? gitconfigPath : "/dev/null",
        MCP_CONNECTION_NONBLOCKING: "0",
        CLAUDE_CONFIG_DIR: undefined,
      },
    });
    return {
      ...common,
      command: CLAUDE_COMMAND,
      args: [
        ...(options.args ?? []),
        "--mcp-config",
        mcpConfigPath,
        "--strict-mcp-config",
        "--setting-sources",
        "project,local",
      ],
      env: applyClaudeCredentialEnv(env, hostEnv, hostHome),
    };
  }

  const configDir = join(runtimeDir, "cursor");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "mcp.json"),
    `${JSON.stringify(buildCursorMcpConfig(options.mcp))}\n`,
    "utf8",
  );
  await writeFile(
    join(configDir, "cli-config.json"),
    `${JSON.stringify(buildCursorCliConfig())}\n`,
    "utf8",
  );
  await attachCursorAuth({
    hostConfigDir: hostCursorConfigDir(hostHome),
    isolatedConfigDir: configDir,
  });
  return {
    ...common,
    command: resolveCursorCommand(hostEnv),
    env: buildChildEnv({
      hostEnv,
      extraEnv,
      overrides: {
        HOME: hostHome,
        CURSOR_CONFIG_DIR: configDir,
        GIT_CONFIG_GLOBAL: hasGitToken ? gitconfigPath : "/dev/null",
      },
    }),
  };
}

async function runInteractive(prepared: PreparedLaunch): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(prepared.command, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
      stdio: "inherit",
    });
    let settled = false;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const removeHandlers = (): void => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    };
    const settle = (outcome: { code?: number; error?: Error }): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeHandlers();
      if (outcome.error) {
        reject(outcome.error);
      } else {
        resolvePromise(outcome.code ?? 1);
      }
    };

    for (const signal of FORWARDED_SIGNALS) {
      const handler = (): void => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill(signal);
        }
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }

    child.once("error", (error) => {
      settle({
        error: new Error(
          `enginebay: could not launch ${prepared.command}: ${error.message}`,
          { cause: error },
        ),
      });
    });
    child.once("close", (code, signal) => {
      settle({
        code:
          code ??
          (signal && signal in SIGNAL_EXIT_CODES
            ? SIGNAL_EXIT_CODES[signal as keyof typeof SIGNAL_EXIT_CODES]
            : 1),
      });
    });
  });
}
