import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iterateRecoverableRun } from "./bay-run.js";
import {
  applyClaudeCredentialEnv,
  buildClaudeArgs,
  buildClaudeMcpConfig,
  CLAUDE_COMMAND,
} from "./claude.js";
import { parseClaudeLine } from "./claude-parse.js";
import {
  buildChildEnv,
  extraEnvGitToken,
  extraEnvHasGitToken,
} from "./env.js";
import { writeIsolatedGitconfig } from "./gitconfig.js";
import {
  DEFAULT_RECOVERY_ATTEMPTS,
  RECOVERY_CONTINUE_PROMPT,
} from "./process-error.js";
import { spawnLineProcess, type SpawnedRun } from "./spawn.js";
import type { Bay, BayEvent, EngineId, OpenBayOptions } from "./types.js";
import type { PreparedWorkspace } from "./workspace.js";

const RM_OPTS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
} as const;

class ClaudeBay implements Bay {
  readonly engine: EngineId = "claude-code";
  readonly workDir: string;
  readonly workspace: PreparedWorkspace;
  private readonly runtimeDir: string;
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly hostHome: string;
  private readonly model: string | undefined;
  private extraEnv: Record<string, string>;
  private committerName: string;
  private readonly instructions: string | undefined;
  private readonly mcpConfigPath: string;
  private readonly gitconfigPath: string;
  private readonly recoveryAttempts: number;
  private running: SpawnedRun | undefined;
  private closed = false;
  private aborted = false;
  private readonly toolById = new Map<string, string>();

  constructor(input: {
    workspace: PreparedWorkspace;
    runtimeDir: string;
    hostEnv: NodeJS.ProcessEnv;
    hostHome: string;
    model: string | undefined;
    extraEnv: Record<string, string>;
    committerName: string;
    instructions: string | undefined;
    mcpConfigPath: string;
    gitconfigPath: string;
    recoveryAttempts?: number;
  }) {
    this.workDir = input.workspace.path;
    this.workspace = input.workspace;
    this.runtimeDir = input.runtimeDir;
    this.hostEnv = input.hostEnv;
    this.hostHome = input.hostHome;
    this.model = input.model;
    this.extraEnv = input.extraEnv;
    this.committerName = input.committerName;
    this.instructions = input.instructions;
    this.mcpConfigPath = input.mcpConfigPath;
    this.gitconfigPath = input.gitconfigPath;
    this.recoveryAttempts =
      input.recoveryAttempts ?? DEFAULT_RECOVERY_ATTEMPTS;
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
    this.aborted = true;
    await this.running?.kill("SIGTERM");
    this.running = undefined;
  }

  async close(): Promise<void> {
    await this.abort();
    this.closed = true;
    const jobs = [rm(this.runtimeDir, RM_OPTS)];
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
    this.aborted = false;
    yield* iterateRecoverableRun({
      recoveryAttempts: this.recoveryAttempts,
      isStopped: () => this.closed || this.aborted,
      setRunning: (run) => {
        this.running = run;
      },
      resetParser: () => {
        this.toolById.clear();
      },
      parseLine: (line, insight) =>
        parseClaudeLine(line, this.toolById, insight),
      spawn: (resumeSessionId) =>
        spawnLineProcess({
          command: CLAUDE_COMMAND,
          args: buildClaudeArgs({
            prompt: resumeSessionId ? RECOVERY_CONTINUE_PROMPT : prompt,
            mcpConfigPath: this.mcpConfigPath,
            appendSystemPrompt: this.instructions,
            model: this.model,
            sessionId: resumeSessionId,
          }),
          cwd: this.workDir,
          env: this.childEnv(),
        }),
    });
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env = buildChildEnv({
      hostEnv: this.hostEnv,
      extraEnv: this.extraEnv,
      overrides: {
        HOME: this.hostHome,
        GIT_CONFIG_GLOBAL: extraEnvHasGitToken(this.extraEnv)
          ? this.gitconfigPath
          : "/dev/null",
        MCP_CONNECTION_NONBLOCKING: "0",
        CLAUDE_CONFIG_DIR: undefined,
      },
    });
    return applyClaudeCredentialEnv(env, this.hostEnv, this.hostHome);
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

export async function openClaudeBay(
  options: OpenBayOptions,
  hostEnv: NodeJS.ProcessEnv,
  hostHome: string,
  workspace: PreparedWorkspace,
): Promise<Bay> {
  const runtimeDir = await mkdtemp(join(tmpdir(), "enginebay-claude-runtime-"));
  const isolatedHome = join(runtimeDir, "home");
  await mkdir(isolatedHome, { recursive: true });
  const mcpConfigPath = join(runtimeDir, "mcp-config.json");
  await writeFile(
    mcpConfigPath,
    `${JSON.stringify(buildClaudeMcpConfig(options.mcp))}\n`,
    "utf8",
  );
  const gitconfigPath = join(isolatedHome, ".gitconfig");
  const extraEnv = options.extraEnv ?? {};
  const bay = new ClaudeBay({
    workspace,
    runtimeDir,
    hostEnv,
    hostHome,
    model: options.model,
    extraEnv,
    committerName: options.git?.committerName ?? "enginebay",
    instructions:
      options.instructions && options.instructions.length > 0
        ? options.instructions
        : undefined,
    mcpConfigPath,
    gitconfigPath,
    recoveryAttempts: options.recoveryAttempts,
  });
  await bay.syncGitconfig();
  return bay;
}
