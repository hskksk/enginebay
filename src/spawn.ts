import { spawn, type ChildProcess } from "node:child_process";
import { processLineChunk } from "./lines.js";

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
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
      child.kill(signal);
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
