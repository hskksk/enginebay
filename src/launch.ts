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
  assertProductExtraEnv,
  buildChildEnv,
  extraEnvGitToken,
  extraEnvHasGitToken,
  resolveHostHome,
} from "./env.js";
import { writeIsolatedGitconfig } from "./gitconfig.js";
import {
  attachOpencodeAuth,
  buildOpencodeConfigContent,
  buildOpencodeLaunchArgs,
  hostOpencodeShareDir,
  OPENCODE_COMMAND,
  resetOpencodeSession,
  argsHaveFlag,
} from "./opencode.js";
import type { EngineConfig, IsolationKind, McpStdio } from "./types.js";
import { prepareWorkspace } from "./workspace.js";

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
  /** Named persistent workspace under enginebay's XDG data directory. */
  workspaceId?: string;
  isolation?: { kind: IsolationKind };
  /** Optional session-scoped MCP server. */
  mcp?: McpStdio;
  /** Engine-level instructions applied without writing into the workspace. */
  instructions?: string;
  /** Engine model override. */
  model?: string;
  /** OpenCode `--agent`. Other engines ignore this for now. */
  agent?: string;
  /** OpenCode plugin / extra config merged with session MCP. */
  config?: EngineConfig;
  /**
   * OpenCode `XDG_DATA_HOME`. Omit for a temp dir deleted after launch.
   * When set, the directory survives so sessions can be resumed later.
   */
  dataDir?: string;
  /** Delete engine session DB files while keeping auth links. */
  resetSession?: boolean;
  /** Override the host auth directory used for allowlisted attach. */
  auth?: { sourceDir?: string };
  /** Resume this OpenCode session. Exclusive with `continueLast`. */
  sessionId?: string;
  /** OpenCode `--continue`. Exclusive with `sessionId`. */
  continueLast?: boolean;
  /** Merged after host env strip; isolation overrides still win. */
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
 * Isolation is applied through environment variables and engine-specific config.
 * OpenCode defaults to `run --interactive --dir`; a full subcommand in `args`
 * is still forwarded as-is.
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
  if (!isLaunchEngineId(options.engine)) {
    throw new Error(`enginebay: unknown launch engine "${options.engine}"`);
  }
  if ((options.isolation?.kind ?? "env") !== "env") {
    throw new Error(
      `enginebay: isolation ${options.isolation?.kind} is not implemented`,
    );
  }
  if (options.workDir !== undefined && options.workspaceId !== undefined) {
    throw new Error("enginebay: set either workDir or workspaceId, not both");
  }
  assertProductExtraEnv(options.extraEnv, {
    rejectConfigContent: options.dataDir !== undefined,
  });
  const hostEnv = options.hostEnv ?? process.env;
  const hostHome = resolveHostHome(hostEnv, options.hostHome);
  const cwd =
    options.workspaceId !== undefined
      ? (
          await prepareWorkspace({
            id: options.workspaceId,
            hostEnv,
            hostHome,
          })
        ).path
      : resolve(options.workDir ?? process.cwd());
  await mkdir(cwd, { recursive: true });
  const runtimeDir = await mkdtemp(join(tmpdir(), "enginebay-launch-"));
  try {
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
      args: withModel(options.args ?? [], options.model),
      cwd,
      cleanup: () => rm(runtimeDir, RM_OPTS),
    };

    if (options.engine === "codex") {
      const codexHome = join(runtimeDir, "codex");
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, "config.toml"),
        buildCodexConfig({
          mcp: options.mcp,
          instructions: options.instructions,
        }),
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
      const xdgData =
        options.dataDir ?? join(runtimeDir, "share");
      await Promise.all(
        [isolatedHome, xdgConfig, xdgState, xdgCache, xdgData].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      let instructionsPath: string | undefined;
      if (options.instructions && options.instructions.length > 0) {
        instructionsPath = join(runtimeDir, "instructions.md");
        await writeFile(instructionsPath, options.instructions, "utf8");
      }
      await attachOpencodeAuth({
        hostShareDir: options.auth?.sourceDir ?? hostOpencodeShareDir(hostHome),
        isolatedShareDir: xdgData,
      });
      if (options.resetSession) {
        await resetOpencodeSession(xdgData);
      }
      return {
        command: OPENCODE_COMMAND,
        args: buildOpencodeLaunchArgs({
          workDir: cwd,
          model: options.model,
          agent: options.agent,
          sessionId: options.sessionId,
          continueLast: options.continueLast,
          args: options.args ?? [],
        }),
        cwd,
        cleanup: () => rm(runtimeDir, RM_OPTS),
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
            OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent({
              mcp: options.mcp,
              instructionsPath,
              config: options.config,
              extraEnv,
            }),
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
      const args = [
        ...common.args,
        "--mcp-config",
        mcpConfigPath,
        "--strict-mcp-config",
        "--setting-sources",
        "project,local",
      ];
      if (options.instructions && options.instructions.length > 0) {
        args.push("--append-system-prompt", options.instructions);
      }
      return {
        ...common,
        command: CLAUDE_COMMAND,
        args,
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
    const args = [...common.args];
    if (options.mcp) {
      args.push("--approve-mcps");
    }
    if (options.instructions && options.instructions.length > 0) {
      args.push(options.instructions);
    }
    return {
      ...common,
      command: resolveCursorCommand(hostEnv),
      args,
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
  } catch (error) {
    await rm(runtimeDir, RM_OPTS);
    throw error;
  }
}

function withModel(args: string[], model: string | undefined): string[] {
  if (!model || model.length === 0 || argsHaveFlag(args, "--model")) {
    return [...args];
  }
  return ["--model", model, ...args];
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
