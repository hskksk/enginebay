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

export class BayProcessControl {
  private seq = 0;
  private running: { seq: number; child: SpawnedRun } | undefined;
  closed = false;

  async abort(): Promise<void> {
    this.seq += 1;
    const current = this.running;
    this.running = undefined;
    await current?.child.kill("SIGTERM");
  }

  async beginRun(): Promise<{
    isStopped: () => boolean;
    setRunning: (run: SpawnedRun | undefined) => void;
  }> {
    const seq = ++this.seq;
    const previous = this.running;
    this.running = undefined;
    await previous?.child.kill("SIGTERM");
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
}

type RecoverableRunInput = {
  spawn: (resumeSessionId: string | undefined) => SpawnedRun;
  parseLine: (line: string, insight: RunInsight) => BayEvent[];
  resetParser?: () => void;
  setRunning: (run: SpawnedRun | undefined) => void;
  isStopped: () => boolean;
  recoveryAttempts?: number;
  recoveryBackoffMs?: number;
};

export function startBayRun(
  control: BayProcessControl,
  input: Omit<RecoverableRunInput, "isStopped" | "setRunning">,
): AsyncIterable<BayEvent> {
  let started: Promise<AsyncIterator<BayEvent>> | undefined;
  const getInner = (): Promise<AsyncIterator<BayEvent>> => {
    started ??= (async () => {
      if (control.closed) {
        throw new Error("enginebay: bay is closed");
      }
      const { isStopped, setRunning } = await control.beginRun();
      return iterateRecoverableRun({
        ...input,
        isStopped,
        setRunning,
      })[Symbol.asyncIterator]();
    })();
    return started;
  };
  return {
    [Symbol.asyncIterator](): AsyncIterator<BayEvent> {
      return {
        async next() {
          return (await getInner()).next();
        },
        async return() {
          const inner = await getInner();
          return inner.return
            ? inner.return(undefined)
            : { done: true, value: undefined };
        },
        async throw(error) {
          const inner = await getInner();
          return inner.throw
            ? inner.throw(error)
            : Promise.reject(error);
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
      let wakeSleep: (() => void) | undefined;
      const inner = recoverLoop({
        ...input,
        isStopped: () => cancelled || input.isStopped(),
        setRunning: (run) => {
          current = run;
          input.setRunning(run);
        },
        sleep: (ms) => {
          if (ms <= 0) {
            return Promise.resolve();
          }
          return new Promise((resolve) => {
            const timer = setTimeout(() => {
              wakeSleep = undefined;
              resolve();
            }, ms);
            wakeSleep = () => {
              clearTimeout(timer);
              wakeSleep = undefined;
              resolve();
            };
          });
        },
      })[Symbol.asyncIterator]();

      const stop = async (): Promise<void> => {
        cancelled = true;
        wakeSleep?.();
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
  input: RecoverableRunInput & { sleep: (ms: number) => Promise<void> },
): AsyncGenerator<BayEvent> {
  const extra = resolveRecoveryAttempts(input.recoveryAttempts);
  const maxAttempts = 1 + extra;
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
    input.resetParser?.();
    const resumeSessionId = attempt > 1 ? sessionId : undefined;
    const spawned = input.spawn(resumeSessionId);
    input.setRunning(spawned);
    const insight: RunInsight = { sessionId };
    try {
      for await (const line of spawned.stdout) {
        for (const event of input.parseLine(line, insight)) {
          yield redactBayEvent(event);
        }
      }
      const finished = await spawned.wait();
      if (insight.sessionId) {
        sessionId = insight.sessionId;
      }
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
      const success =
        finished.code === 0 &&
        !insight.engineErrorMessage &&
        !finished.spawnError &&
        !stopped;
      if (success) {
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
        Boolean(sessionId);
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
        await input.sleep(backoffMs * attempt);
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
