import { spawn, type ChildProcess } from "node:child_process";
import { processLineChunk } from "./lines.js";

/** Grace period before a SIGTERM is escalated to SIGKILL. */
const KILL_GRACE_MS = 2000;
/** Hard cap so kill() always settles even if the child never reports close. */
const KILL_DEADLINE_MS = 5000;

export type SpawnWaitResult = {
  code: number;
  stderr: string;
  signal?: NodeJS.Signals | null;
  spawnError?: string;
};

export type SpawnedRun = {
  child: ChildProcess;
  stdout: AsyncIterable<string>;
  stderrText: () => string;
  wait: () => Promise<SpawnWaitResult>;
  kill: (signal?: NodeJS.Signals) => Promise<void>;
};

export type SpawnRequest = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type SpawnAdapter = {
  spawn?: (req: SpawnRequest) => SpawnedRun;
  mapPath?: (hostPath: string) => string;
  mapEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

const PATH_FLAGS = new Set(["--dir", "--workspace", "--mcp-config"]);

const PATH_ENV_KEYS = new Set([
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "GIT_CONFIG_GLOBAL",
  "CLAUDE_CONFIG_DIR",
  "CURSOR_CONFIG_DIR",
  "CODEX_HOME",
]);

function mapPathFlags(
  args: string[],
  mapPath: (hostPath: string) => string,
): string[] {
  const mapped = [...args];
  for (let index = 0; index < mapped.length - 1; index += 1) {
    if (PATH_FLAGS.has(mapped[index]!)) {
      mapped[index + 1] = mapPath(mapped[index + 1]!);
    }
  }
  return mapped;
}

function mapPathEnv(
  env: NodeJS.ProcessEnv,
  mapPath: (hostPath: string) => string,
): NodeJS.ProcessEnv {
  const mapped: NodeJS.ProcessEnv = { ...env };
  for (const key of PATH_ENV_KEYS) {
    const value = mapped[key];
    if (typeof value === "string" && value.length > 0 && value !== "/dev/null") {
      mapped[key] = mapPath(value);
    }
  }
  return mapped;
}

export function applySpawnAdapter(
  adapter: SpawnAdapter | undefined,
  req: SpawnRequest,
): SpawnedRun {
  const mapPath = adapter?.mapPath;
  let { args, cwd, env } = req;
  if (mapPath) {
    args = mapPathFlags(args, mapPath);
    cwd = mapPath(cwd);
    env = mapPathEnv(env, mapPath);
  }
  if (adapter?.mapEnv) {
    env = adapter.mapEnv(env);
  }
  const spawnFn = adapter?.spawn ?? spawnLineProcess;
  return spawnFn({ command: req.command, args, cwd, env });
}

export function spawnLineProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): SpawnedRun {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let exitCode: number | undefined;
  let exitSignal: NodeJS.Signals | null | undefined;
  let spawnError: string | undefined;
  const waiters: Array<() => void> = [];
  const lineQueue: string[] = [];
  let lineWait: (() => void) | undefined;
  let stdoutEnded = false;
  let stdoutBuffer = "";

  const endStdout = (): void => {
    if (stdoutEnded) {
      return;
    }
    if (stdoutBuffer.length > 0) {
      lineQueue.push(stdoutBuffer);
      stdoutBuffer = "";
    }
    stdoutEnded = true;
    lineWait?.();
  };

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.once("error", (error) => {
    spawnError = error.message;
    stderr = `${stderr}\n${error.message}`.trim();
    if (exitCode === undefined) {
      exitCode = 1;
    }
    endStdout();
    for (const wake of waiters.splice(0)) {
      wake();
    }
  });

  child.once("close", (code, signal) => {
    exitCode = code ?? 1;
    exitSignal = signal;
    endStdout();
    for (const wake of waiters.splice(0)) {
      wake();
    }
  });

  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer = processLineChunk(stdoutBuffer, chunk, (line) => {
        lineQueue.push(line);
        lineWait?.();
      });
    });
    child.stdout.on("end", () => {
      endStdout();
    });
  } else {
    stdoutEnded = true;
  }

  const stdout: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        async next() {
          for (;;) {
            const line = lineQueue.shift();
            if (line !== undefined) {
              return { value: line, done: false };
            }
            if (stdoutEnded) {
              return { value: undefined, done: true };
            }
            await new Promise<void>((resolve) => {
              lineWait = resolve;
            });
          }
        },
        async return() {
          endStdout();
          return { value: undefined, done: true };
        },
      };
    },
  };

  async function wait(): Promise<SpawnWaitResult> {
    if (exitCode === undefined) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    return {
      code: exitCode ?? 1,
      stderr,
      signal: exitSignal,
      ...(spawnError ? { spawnError } : {}),
    };
  }

  async function kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (
      child.exitCode !== null ||
      child.signalCode !== null ||
      spawnError !== undefined ||
      child.pid === undefined
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      const done = (): void => {
        for (const timer of timers) {
          clearTimeout(timer);
        }
        child.off("close", done);
        child.off("error", done);
        resolve();
      };
      const later = (ms: number, run: () => void): void => {
        const timer = setTimeout(run, ms);
        timer.unref();
        timers.push(timer);
      };
      child.once("close", done);
      child.once("error", done);
      child.kill(signal);
      if (signal !== "SIGKILL") {
        // A CLI that traps SIGTERM must not wedge abort() / close() forever.
        later(KILL_GRACE_MS, () => child.kill("SIGKILL"));
      }
      later(KILL_DEADLINE_MS, done);
    });
  }

  return {
    child,
    stdout,
    stderrText: () => stderr,
    wait,
    kill,
  };
}
