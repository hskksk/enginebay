import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { redactBayEvent } from "./opencode-parse.js";
import { spawnLineProcess, type SpawnedRun } from "./spawn.js";
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
  private running: SpawnedRun | undefined;
  private closed = false;
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
    this.toolById.clear();
    const spawned = spawnLineProcess({
      command: this.command,
      args: buildCursorArgs({
        prompt,
        workDir: this.workDir,
        model: this.model,
        instructions: this.instructions,
      }),
      cwd: this.workDir,
      env: this.childEnv(),
    });
    this.running = spawned;
    try {
      for await (const line of spawned.stdout) {
        for (const event of parseCursorLine(line, this.toolById)) {
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
  });
  await bay.syncGitconfig();
  return bay;
}
