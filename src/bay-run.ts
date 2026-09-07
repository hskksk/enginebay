import { redactBayEvent } from "./opencode-parse.js";
import {
  classifyProcessFailure,
  recoveryDiagnostic,
  resolveRecoveryAttempts,
  resolveRecoveryBackoffMs,
} from "./process-error.js";
import type { RunInsight } from "./run-insight.js";
import type { SpawnedRun } from "./spawn.js";
import type { BayError, BayEvent } from "./types.js";

/** Slice length for a backoff wait, so abort() takes effect without waiting it out. */
const BACKOFF_SLICE_MS = 50;

type RunningChild = {
  seq: number;
  child: SpawnedRun;
  stopped?: Promise<void>;
};

export class BayProcessControl {
  private seq = 0;
  private running: RunningChild | undefined;
  /** The most recent kill, so a later caller can wait for a child it no longer owns. */
  private settled: Promise<void> = Promise.resolve();
  closed = false;

  abort(): Promise<void> {
    this.seq += 1;
    return this.stopRunning();
  }

  async beginRun(): Promise<{
    isStopped: () => boolean;
    setRunning: (run: SpawnedRun | undefined) => void;
  }> {
    const seq = ++this.seq;
    await this.stopRunning();
    return {
      isStopped: () => this.closed || this.seq !== seq,
      setRunning: (run) => {
        if (this.seq !== seq) {
          void run?.kill("SIGTERM");
          return;
        }
        this.running = run ? { seq, child: run } : undefined;
      },
    };
  }

  /**
   * Kill the current child and wait for it to be gone. `running` stays set
   * until the kill resolves, so an un-awaited abort() cannot make close()
   * delete the isolation dirs while the CLI is still alive.
   */
  private stopRunning(): Promise<void> {
    const current = this.running;
    if (!current) {
      return this.settled;
    }
    current.stopped ??= (async () => {
      try {
        await current.child.kill("SIGTERM");
      } finally {
        if (this.running === current) {
          this.running = undefined;
        }
      }
    })();
    this.settled = current.stopped;
    return this.settled;
  }
}

type RecoverableRunInput = {
  spawn: (resumeSessionId: string | undefined) => SpawnedRun;
  /** Fresh parser state per process start; runs must not share dedup maps. */
  createParser: () => (line: string, insight: RunInsight) => BayEvent[];
  setRunning: (run: SpawnedRun | undefined) => void;
  isStopped: () => boolean;
  recoveryAttempts?: number;
  recoveryBackoffMs?: number;
};

export function startBayRun(
  control: BayProcessControl,
  input: Omit<RecoverableRunInput, "isStopped" | "setRunning">,
): AsyncIterable<BayEvent> {
  let inner: Promise<AsyncIterator<BayEvent>> | undefined;
  const start = (): Promise<AsyncIterator<BayEvent>> => {
    inner ??= (async () => {
      if (control.closed) {
        throw new Error("enginebay: bay is closed");
      }
      const { isStopped, setRunning } = await control.beginRun();
      return iterateRecoverableRun({ ...input, isStopped, setRunning })[
        Symbol.asyncIterator
      ]();
    })();
    return inner;
  };
  return {
    [Symbol.asyncIterator](): AsyncIterator<BayEvent> {
      return {
        async next() {
          return (await start()).next();
        },
        async return() {
          if (!inner) {
            // Closing an iterator nobody advanced must not start (and then
            // immediately abort) a run.
            return { done: true, value: undefined };
          }
          const iterator = await inner;
          return iterator.return
            ? iterator.return(undefined)
            : { done: true, value: undefined };
        },
        async throw(error) {
          if (!inner) {
            throw error;
          }
          const iterator = await inner;
          if (!iterator.throw) {
            throw error;
          }
          return iterator.throw(error);
        },
      };
    },
  };
}

/**
 * `return()` / `break` cannot interrupt a pending `for await`. Kill the child
 * first so stdout ends and the inner generator can finish.
 */
export function iterateRecoverableRun(
  input: RecoverableRunInput,
): AsyncIterable<BayEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<BayEvent> {
      let current: SpawnedRun | undefined;
      let cancelled = false;
      let wakeBackoff: (() => void) | undefined;
      const stopped = (): boolean => cancelled || input.isStopped();
      const inner = recoverLoop({
        ...input,
        isStopped: stopped,
        setRunning: (run) => {
          current = run;
          input.setRunning(run);
        },
        backoff: async (ms) => {
          const deadline = Date.now() + ms;
          for (let left = ms; left > 0; left = deadline - Date.now()) {
            if (stopped()) {
              return;
            }
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, Math.min(BACKOFF_SLICE_MS, left));
              wakeBackoff = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wakeBackoff = undefined;
          }
        },
      })[Symbol.asyncIterator]();

      const stop = async (): Promise<void> => {
        cancelled = true;
        wakeBackoff?.();
        await current?.kill("SIGTERM");
      };

      return {
        next: () => inner.next(),
        async return() {
          await stop();
          return inner.return(undefined);
        },
        async throw(error) {
          await stop();
          return inner.throw(error);
        },
      };
    },
  };
}

async function* recoverLoop(
  input: RecoverableRunInput & { backoff: (ms: number) => Promise<void> },
): AsyncGenerator<BayEvent> {
  const maxAttempts = 1 + resolveRecoveryAttempts(input.recoveryAttempts);
  const backoffMs = resolveRecoveryBackoffMs(input.recoveryBackoffMs);
  let sessionId: string | undefined;
  let lastError: BayError | undefined;
  let lastCode = 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (input.isStopped()) {
      lastError = classifyProcessFailure({
        code: lastCode,
        stderr: "",
        aborted: true,
      });
      break;
    }
    const parseLine = input.createParser();
    const spawned = input.spawn(attempt > 1 ? sessionId : undefined);
    input.setRunning(spawned);
    const insight: RunInsight = {};
    try {
      for await (const line of spawned.stdout) {
        for (const event of parseLine(line, insight)) {
          yield redactBayEvent(event);
        }
      }
      const finished = await spawned.wait();
      // Resuming mints a new session id on Claude and Cursor, so the newest id
      // is the one that has the previous attempt's work.
      sessionId = insight.sessionId ?? sessionId;
      const stderr = finished.stderr.trim();
      if (stderr.length > 0) {
        yield redactBayEvent({
          kind: "diagnostic",
          stream: "stderr",
          text: stderr,
        });
      }
      lastCode = finished.code;
      const stopped = input.isStopped();
      const processFailed = finished.code !== 0 || Boolean(finished.spawnError);
      const engineFailed = Boolean(insight.engineErrorMessage);
      if (!processFailed && !engineFailed && !stopped) {
        yield { kind: "exit", code: 0 };
        return;
      }
      lastError = classifyProcessFailure({
        code: finished.code,
        signal: finished.signal,
        stderr,
        spawnError: finished.spawnError,
        engineErrorMessage: insight.engineErrorMessage,
        engineErrorName: insight.engineErrorName,
        engineResultSubtype: insight.engineResultSubtype,
        engineRetryable: insight.engineRetryable,
        aborted: stopped,
      });
      const canRetry =
        !lastError.critical &&
        attempt < maxAttempts &&
        !stopped &&
        Boolean(sessionId) &&
        // A clean exit means the process is not what failed, so restarting it
        // cannot help and resuming would repeat a turn the CLI finished.
        (processFailed || insight.engineTerminalError === true);
      if (canRetry) {
        yield redactBayEvent({
          kind: "diagnostic",
          stream: "stderr",
          text: recoveryDiagnostic({
            error: lastError,
            nextAttempt: attempt + 1,
            maxAttempts,
            sessionId,
          }),
        });
        await input.backoff(backoffMs * attempt);
        if (input.isStopped()) {
          lastError = classifyProcessFailure({
            code: lastCode,
            stderr: "",
            aborted: true,
          });
          break;
        }
        continue;
      }
      break;
    } finally {
      await spawned.kill("SIGTERM");
      input.setRunning(undefined);
    }
  }

  if (lastError) {
    yield redactBayEvent({
      kind: "error",
      message: lastError.message,
      critical: lastError.critical,
    });
    yield redactBayEvent({
      kind: "exit",
      code: lastCode || 1,
      error: lastError,
    });
    return;
  }
  yield { kind: "exit", code: lastCode || 1 };
}
