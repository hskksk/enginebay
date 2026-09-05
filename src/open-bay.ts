import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExists, readCommandVersion } from "./command.js";
import {
  buildChildEnv,
  extraEnvGitToken,
  extraEnvHasGitToken,
  resolveHostHome,
} from "./env.js";
import { writeIsolatedGitconfig } from "./gitconfig.js";
import {
  attachOpencodeAuth,
  buildOpencodeArgs,
  buildOpencodeMcpConfig,
  hostOpencodeShareDir,
  OPENCODE_COMMAND,
  opencodeAuthPresent,
} from "./opencode.js";
import { parseOpencodeLine, redactBayEvent } from "./opencode-parse.js";
import { openClaudeBay } from "./claude-bay.js";
import { openCursorBay } from "./cursor-bay.js";
import {
  CLAUDE_COMMAND,
  CLAUDE_COMMAND_ALIASES,
  claudeAuthPresent,
} from "./claude.js";
import {
  CURSOR_COMMAND,
  CURSOR_COMMAND_ALIASES,
  cursorAuthPresent,
} from "./cursor.js";
import { spawnLineProcess, type SpawnedRun } from "./spawn.js";
import type { Bay, BayEvent, EngineId, OpenBayOptions } from "./types.js";
import type { PreparedWorkspace } from "./workspace.js";
import { prepareWorkspace } from "./workspace.js";

const RM_OPTS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
} as const;

class OpencodeBay implements Bay {
  readonly engine: EngineId = "opencode";
  readonly workDir: string;
  readonly workspace: PreparedWorkspace;
  private readonly runtimeDir: string;
  private readonly dataDir: string;
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly hostHome: string;
  private readonly model: string | undefined;
  private extraEnv: Record<string, string>;
  private committerName: string;
  private readonly instructionsPath: string | undefined;
  private readonly mcpConfig: Record<string, unknown>;
  private readonly gitconfigPath: string;
  private running: SpawnedRun | undefined;
  private closed = false;

  constructor(input: {
    workspace: PreparedWorkspace;
    runtimeDir: string;
    dataDir: string;
    hostEnv: NodeJS.ProcessEnv;
    hostHome: string;
    model: string | undefined;
    extraEnv: Record<string, string>;
    committerName: string;
    instructionsPath: string | undefined;
    mcpConfig: Record<string, unknown>;
    gitconfigPath: string;
  }) {
    this.workDir = input.workspace.path;
    this.workspace = input.workspace;
    this.runtimeDir = input.runtimeDir;
    this.dataDir = input.dataDir;
    this.hostEnv = input.hostEnv;
    this.hostHome = input.hostHome;
    this.model = input.model;
    this.extraEnv = input.extraEnv;
    this.committerName = input.committerName;
    this.instructionsPath = input.instructionsPath;
    this.mcpConfig = input.mcpConfig;
    this.gitconfigPath = input.gitconfigPath;
  }

  async updateExtraEnv(
    extraEnv: Record<string, string>,
    git?: { committerName?: string },
  ): Promise<void> {
    this.extraEnv = extraEnv;
    if (git?.committerName && git.committerName.length > 0) {
      this.committerName = git.committerName;
    }
    await this.syncGitconfig();
  }

  async abort(): Promise<void> {
    await this.running?.kill("SIGTERM");
    this.running = undefined;
  }

  async close(): Promise<void> {
    await this.abort();
    this.closed = true;
    const jobs = [
      rm(this.runtimeDir, RM_OPTS),
      rm(this.dataDir, RM_OPTS),
    ];
    if (this.workspace.ephemeral) {
      jobs.push(rm(this.workDir, RM_OPTS));
    }
    await Promise.all(jobs);
  }

  async *run(prompt: string): AsyncIterable<BayEvent> {
    if (this.closed) {
      throw new Error("enginebay: bay is closed");
    }
    if (this.running) {
      await this.abort();
    }
    const args = buildOpencodeArgs({
      workDir: this.workDir,
      prompt,
      model: this.model,
    });
    const env = this.childEnv();
    const spawned = spawnLineProcess({
      command: OPENCODE_COMMAND,
      args,
      cwd: this.workDir,
      env,
    });
    this.running = spawned;
    const seenToolCalls = new Set<string>();
    try {
      for await (const line of spawned.stdout) {
        for (const event of parseOpencodeLine(line, seenToolCalls)) {
          yield redactBayEvent(event);
        }
      }
      const finished = await spawned.wait();
      const stderr = finished.stderr.trim();
      if (stderr.length > 0) {
        yield redactBayEvent({
          kind: "diagnostic",
          stream: "stderr",
          text: stderr,
        });
      }
      yield { kind: "exit", code: finished.code };
    } finally {
      this.running = undefined;
    }
  }

  private childEnv(): NodeJS.ProcessEnv {
    const xdgConfig = join(this.runtimeDir, "config");
    const xdgState = join(this.dataDir, "state");
    const xdgCache = join(this.dataDir, "cache");
    const xdgData = join(this.dataDir, "share");
    const isolatedHome = join(this.runtimeDir, "home");
    const hasGit = extraEnvHasGitToken(this.extraEnv);
    return buildChildEnv({
      hostEnv: this.hostEnv,
      extraEnv: this.extraEnv,
      overrides: {
        HOME: isolatedHome,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_STATE_HOME: xdgState,
        XDG_CACHE_HOME: xdgCache,
        XDG_DATA_HOME: xdgData,
        XDG_CONFIG_DIRS: "",
        OPENCODE_DISABLE_GLOBAL_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(this.mcpConfig),
        GIT_CONFIG_GLOBAL: hasGit ? this.gitconfigPath : "/dev/null",
      },
    });
  }

  async syncGitconfig(): Promise<void> {
    const token = extraEnvGitToken(this.extraEnv);
    if (!token) {
      return;
    }
    await writeIsolatedGitconfig(this.gitconfigPath, {
      token,
      committerName: this.committerName,
    });
  }
}

export async function openBay(options: OpenBayOptions): Promise<Bay> {
  const isolation = options.isolation?.kind ?? "env";
  if (isolation !== "env") {
    throw new Error(`enginebay: isolation ${isolation} is not implemented`);
  }
  const hostEnv = options.hostEnv ?? process.env;
  const hostHome = resolveHostHome(hostEnv, options.hostHome);
  if (
    options.engine !== "claude-code" &&
    options.engine !== "opencode" &&
    options.engine !== "cursor-agent"
  ) {
    throw new Error(
      `enginebay: engine "${options.engine}" is not implemented yet`,
    );
  }
  if (options.workDir !== undefined && options.workspaceId !== undefined) {
    throw new Error("enginebay: set either workDir or workspaceId, not both");
  }
  const workspace = await prepareWorkspace({
    path: options.workDir,
    id: options.workspaceId,
    hostEnv,
    hostHome,
  });
  if (options.engine === "claude-code") {
    return openClaudeBay(options, hostEnv, hostHome, workspace);
  }
  if (options.engine === "cursor-agent") {
    return openCursorBay(options, hostEnv, hostHome, workspace);
  }

  const runtimeDir = await mkdtemp(join(tmpdir(), "enginebay-runtime-"));
  const dataDir = await mkdtemp(join(tmpdir(), "enginebay-data-"));
  const isolatedHome = join(runtimeDir, "home");
  const xdgConfig = join(runtimeDir, "config");
  const xdgState = join(dataDir, "state");
  const xdgCache = join(dataDir, "cache");
  const xdgData = join(dataDir, "share");
  await mkdir(isolatedHome, { recursive: true });
  await mkdir(xdgConfig, { recursive: true });
  await mkdir(xdgState, { recursive: true });
  await mkdir(xdgCache, { recursive: true });
  await mkdir(xdgData, { recursive: true });

  let instructionsPath: string | undefined;
  if (options.instructions && options.instructions.length > 0) {
    instructionsPath = join(runtimeDir, "instructions.md");
    await writeFile(instructionsPath, options.instructions, "utf8");
  }

  const mcpConfig = buildOpencodeMcpConfig({
    mcp: options.mcp,
    instructionsPath,
  });

  await attachOpencodeAuth({
    hostShareDir: hostOpencodeShareDir(hostHome),
    isolatedShareDir: xdgData,
  });

  const gitconfigPath = join(isolatedHome, ".gitconfig");
  const extraEnv = options.extraEnv ?? {};
  const bay = new OpencodeBay({
    workspace,
    runtimeDir,
    dataDir,
    hostEnv,
    hostHome,
    model: options.model,
    extraEnv,
    committerName: options.git?.committerName ?? "enginebay",
    instructionsPath,
    mcpConfig,
    gitconfigPath,
  });
  await bay.syncGitconfig();
  return bay;
}

export async function doctor(
  engine: EngineId,
  host?: { env?: NodeJS.ProcessEnv; home?: string },
): Promise<import("./types.js").DoctorReport> {
  const env = host?.env ?? process.env;
  const home = resolveHostHome(env, host?.home);
  if (engine === "claude-code") {
    return doctorClaude(env, home);
  }
  if (engine === "cursor-agent") {
    return doctorCursor(env, home);
  }
  if (engine !== "opencode") {
    return {
      ok: false,
      engine,
      cli: { found: false, command: engine },
      auth: { found: false, detail: "not implemented" },
      message: `enginebay: engine "${engine}" is not implemented yet`,
    };
  }
  const found = commandExists(OPENCODE_COMMAND, env);
  const version = found ? readCommandVersion(OPENCODE_COMMAND, env) : undefined;
  const shareDir = hostOpencodeShareDir(home);
  const authFound = opencodeAuthPresent(shareDir);
  const cli = {
    found,
    command: OPENCODE_COMMAND,
    ...(version ? { version } : {}),
  };
  const auth = authFound
    ? {
        found: true,
        detail: `OpenCode auth files present under ${shareDir}`,
      }
    : {
        found: false,
        detail: `OpenCode auth not found under ${shareDir}. Run opencode auth on the host.`,
      };
  const ok = found;
  const message = !found
    ? "opencode CLI is not on PATH"
    : !authFound
      ? `opencode is on PATH; ${auth.detail}`
      : `opencode is on PATH; ${auth.detail}`;
  return { ok, engine, cli, auth, message };
}

function doctorClaude(
  env: NodeJS.ProcessEnv,
  home: string,
): import("./types.js").DoctorReport {
  let command = CLAUDE_COMMAND;
  let found = false;
  let version: string | undefined;
  for (const candidate of CLAUDE_COMMAND_ALIASES) {
    if (commandExists(candidate, env)) {
      command = candidate;
      found = true;
      version = readCommandVersion(candidate, env);
      break;
    }
  }
  const auth = claudeAuthPresent(home, env);
  const cli = {
    found,
    command,
    ...(version ? { version } : {}),
  };
  const ok = found;
  const message = !found
    ? "claude CLI is not on PATH"
    : `claude is on PATH; ${auth.detail}`;
  return { ok, engine: "claude-code", cli, auth, message };
}

function doctorCursor(
  env: NodeJS.ProcessEnv,
  home: string,
): import("./types.js").DoctorReport {
  let command = CURSOR_COMMAND;
  let found = false;
  let version: string | undefined;
  for (const candidate of CURSOR_COMMAND_ALIASES) {
    if (commandExists(candidate, env)) {
      command = candidate;
      found = true;
      version = readCommandVersion(candidate, env);
      break;
    }
  }
  const auth = cursorAuthPresent(home, env);
  const cli = {
    found,
    command,
    ...(version ? { version } : {}),
  };
  const ok = found;
  const message = !found
    ? "cursor-agent CLI is not on PATH"
    : `cursor-agent is on PATH; ${auth.detail}`;
  return { ok, engine: "cursor-agent", cli, auth, message };
}
