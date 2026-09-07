import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BayProcessControl, startBayRun } from "./bay-run.js";
import {
  attachCursorAuth,
  buildCursorArgs,
  buildCursorCliConfig,
  buildCursorMcpConfig,
  hostCursorConfigDir,
  resolveCursorCommand,
} from "./cursor.js";
import { parseCursorLine } from "./cursor-parse.js";
import {
  extraEnvGitToken,
  extraEnvHasGitToken,
  buildChildEnv,
} from "./env.js";
import { writeIsolatedGitconfig } from "./gitconfig.js";
import {
  RECOVERY_CONTINUE_PROMPT,
  resolveRecoveryAttempts,
  resolveRecoveryBackoffMs,
} from "./process-error.js";
import { spawnLineProcess } from "./spawn.js";
import type { Bay, BayEvent, EngineId, OpenBayOptions } from "./types.js";
import type { PreparedWorkspace } from "./workspace.js";

const RM_OPTS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
} as const;

class CursorBay implements Bay {
  readonly engine: EngineId = "cursor-agent";
  readonly workDir: string;
  readonly workspace: PreparedWorkspace;
  private readonly runtimeDir: string;
  private readonly configDir: string;
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly hostHome: string;
  private readonly command: string;
  private readonly model: string | undefined;
  private extraEnv: Record<string, string>;
  private committerName: string;
  private readonly instructions: string | undefined;
  private readonly gitconfigPath: string;
  private readonly recoveryAttempts: number;
  private readonly recoveryBackoffMs: number;
  private readonly control = new BayProcessControl();
  private readonly toolById = new Map<string, string>();

  constructor(input: {
    workspace: PreparedWorkspace;
    runtimeDir: string;
    configDir: string;
    hostEnv: NodeJS.ProcessEnv;
    hostHome: string;
    command: string;
    model: string | undefined;
    extraEnv: Record<string, string>;
    committerName: string;
    instructions: string | undefined;
    gitconfigPath: string;
    recoveryAttempts?: number;
    recoveryBackoffMs?: number;
  }) {
    this.workDir = input.workspace.path;
    this.workspace = input.workspace;
    this.runtimeDir = input.runtimeDir;
    this.configDir = input.configDir;
    this.hostEnv = input.hostEnv;
    this.hostHome = input.hostHome;
    this.command = input.command;
    this.model = input.model;
    this.extraEnv = input.extraEnv;
    this.committerName = input.committerName;
    this.instructions = input.instructions;
    this.gitconfigPath = input.gitconfigPath;
    this.recoveryAttempts = resolveRecoveryAttempts(input.recoveryAttempts);
    this.recoveryBackoffMs = resolveRecoveryBackoffMs(input.recoveryBackoffMs);
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
    await this.control.abort();
  }

  async close(): Promise<void> {
    this.control.closed = true;
    await this.control.abort();
    const jobs = [rm(this.runtimeDir, RM_OPTS)];
    if (this.workspace.ephemeral) {
      jobs.push(rm(this.workDir, RM_OPTS));
    }
    await Promise.all(jobs);
  }

  run(prompt: string): AsyncIterable<BayEvent> {
    return startBayRun(this.control, {
      recoveryAttempts: this.recoveryAttempts,
      recoveryBackoffMs: this.recoveryBackoffMs,
      resetParser: () => {
        this.toolById.clear();
      },
      parseLine: (line, insight) =>
        parseCursorLine(line, this.toolById, insight),
      spawn: (resumeSessionId) =>
        spawnLineProcess({
          command: this.command,
          args: buildCursorArgs({
            prompt: resumeSessionId ? RECOVERY_CONTINUE_PROMPT : prompt,
            workDir: this.workDir,
            model: this.model,
            instructions: resumeSessionId ? undefined : this.instructions,
            sessionId: resumeSessionId,
          }),
          cwd: this.workDir,
          env: this.childEnv(),
        }),
    });
  }

  private childEnv(): NodeJS.ProcessEnv {
    return buildChildEnv({
      hostEnv: this.hostEnv,
      extraEnv: this.extraEnv,
      overrides: {
        HOME: this.hostHome,
        CURSOR_CONFIG_DIR: this.configDir,
        GIT_CONFIG_GLOBAL: extraEnvHasGitToken(this.extraEnv)
          ? this.gitconfigPath
          : "/dev/null",
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

export async function openCursorBay(
  options: OpenBayOptions,
  hostEnv: NodeJS.ProcessEnv,
  hostHome: string,
  workspace: PreparedWorkspace,
): Promise<Bay> {
  const runtimeDir = await mkdtemp(join(tmpdir(), "enginebay-cursor-runtime-"));
  const isolatedHome = join(runtimeDir, "home");
  const configDir = join(runtimeDir, "cursor");
  await mkdir(isolatedHome, { recursive: true });
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
  const gitconfigPath = join(isolatedHome, ".gitconfig");
  const extraEnv = options.extraEnv ?? {};
  const bay = new CursorBay({
    workspace,
    runtimeDir,
    configDir,
    hostEnv,
    hostHome,
    command: resolveCursorCommand(hostEnv),
    model: options.model,
    extraEnv,
    committerName: options.git?.committerName ?? "enginebay",
    instructions:
      options.instructions && options.instructions.length > 0
        ? options.instructions
        : undefined,
    gitconfigPath,
    recoveryAttempts: options.recoveryAttempts,
    recoveryBackoffMs: options.recoveryBackoffMs,
  });
  await bay.syncGitconfig();
  return bay;
}
