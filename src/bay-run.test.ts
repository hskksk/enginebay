import { describe, expect, it } from "vitest";
import { BayProcessControl, iterateRecoverableRun } from "./bay-run.js";
import type { SpawnWaitResult, SpawnedRun } from "./spawn.js";
import type { BayEvent } from "./types.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function finishedRun(result: SpawnWaitResult, lines: string[] = []): SpawnedRun {
  return {
    child: { pid: 1 } as SpawnedRun["child"],
    stdout: {
      async *[Symbol.asyncIterator]() {
        yield* lines;
      },
    },
    stderrText: () => result.stderr,
    wait: async () => result,
    kill: async () => {},
  };
}

function hangingRun(state: { killed: boolean }): SpawnedRun {
  const wait = deferred<SpawnWaitResult>();
  let ended = false;
  let wake: (() => void) | undefined;
  const end = (result: SpawnWaitResult): void => {
    if (ended) {
      return;
    }
    ended = true;
    wake?.();
    wait.resolve(result);
  };
  return {
    child: { pid: 1 } as SpawnedRun["child"],
    stdout: {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        return {
          async next() {
            if (ended) {
              return { value: undefined, done: true };
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            return { value: undefined, done: true };
          },
          async return() {
            end({ code: 1, stderr: "", signal: "SIGTERM" });
            return { value: undefined, done: true };
          },
        };
      },
    },
    stderrText: () => "",
    wait: () => wait.promise,
    kill: async () => {
      state.killed = true;
      end({ code: 1, stderr: "", signal: "SIGTERM" });
    },
  };
}

const noParser = () => () => [];

async function collect(iterable: AsyncIterable<BayEvent>): Promise<BayEvent[]> {
  const events: BayEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function drain(
  iterator: AsyncIterator<BayEvent>,
): Promise<BayEvent[]> {
  const events: BayEvent[] = [];
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      return events;
    }
    events.push(step.value);
  }
}

describe("iterateRecoverableRun", () => {
  it("does not retry a non-critical crash when no session id was captured", async () => {
    let spawns = 0;
    const events = await collect(
      iterateRecoverableRun({
        recoveryAttempts: 2,
        recoveryBackoffMs: 0,
        isStopped: () => false,
        setRunning: () => {},
        createParser: noParser,
        spawn: () => {
          spawns += 1;
          return finishedRun({ code: 1, stderr: "ECONNRESET" });
        },
      }),
    );
    expect(spawns).toBe(1);
    expect(events.find((event) => event.kind === "error")).toEqual({
      kind: "error",
      message: "enginebay: ECONNRESET",
      critical: false,
    });
    expect(events.at(-1)).toMatchObject({
      kind: "exit",
      code: 1,
      error: { critical: false },
    });
  });

  it("does not retry a critical failure even when a session id is known", async () => {
    let spawns = 0;
    const events = await collect(
      iterateRecoverableRun({
        recoveryAttempts: 2,
        recoveryBackoffMs: 0,
        isStopped: () => false,
        setRunning: () => {},
        createParser: () => (_line, insight) => {
          insight.sessionId = "ses_auth";
          return [];
        },
        spawn: () => {
          spawns += 1;
          return finishedRun({ code: 1, stderr: "Authentication required" }, [
            "session",
          ]);
        },
      }),
    );
    expect(spawns).toBe(1);
    expect(events.find((event) => event.kind === "error")).toMatchObject({
      kind: "error",
      critical: true,
    });
  });

  it("does not retry an engine error when the process exited cleanly", async () => {
    let spawns = 0;
    const events = await collect(
      iterateRecoverableRun({
        recoveryAttempts: 2,
        recoveryBackoffMs: 0,
        isStopped: () => false,
        setRunning: () => {},
        createParser: () => (_line, insight) => {
          insight.sessionId = "ses_ok";
          insight.engineErrorMessage = "overloaded";
          insight.engineRetryable = true;
          return [];
        },
        spawn: () => {
          spawns += 1;
          return finishedRun({ code: 0, stderr: "" }, ["mid-stream error"]);
        },
      }),
    );
    expect(spawns).toBe(1);
    expect(events.find((event) => event.kind === "error")).toMatchObject({
      kind: "error",
      critical: false,
    });
  });

  it("retries a terminal engine error reported with a zero exit code", async () => {
    let spawns = 0;
    await collect(
      iterateRecoverableRun({
        recoveryAttempts: 1,
        recoveryBackoffMs: 0,
        isStopped: () => false,
        setRunning: () => {},
        createParser: () => (_line, insight) => {
          insight.sessionId = "ses_claude";
          insight.engineErrorMessage = "API error";
          insight.engineResultSubtype = "error_during_execution";
          insight.engineTerminalError = true;
          return [];
        },
        spawn: () => {
          spawns += 1;
          return finishedRun({ code: 0, stderr: "" }, ["result"]);
        },
      }),
    );
    expect(spawns).toBe(2);
  });

  it("resumes with the newest session id on every retry", async () => {
    const resumed: Array<string | undefined> = [];
    let spawns = 0;
    const events = await collect(
      iterateRecoverableRun({
        recoveryAttempts: 2,
        recoveryBackoffMs: 0,
        isStopped: () => false,
        setRunning: () => {},
        // Mirrors captureSessionId: the first id in a process stream wins.
        createParser: () => (line, insight) => {
          insight.sessionId ??= line;
          return [];
        },
        spawn: (sessionId) => {
          spawns += 1;
          resumed.push(sessionId);
          const id = `ses_${spawns}`;
          if (spawns > 2) {
            return finishedRun({ code: 0, stderr: "" }, [id]);
          }
          return finishedRun({ code: 1, stderr: "ECONNRESET" }, [id]);
        },
      }),
    );
    expect(resumed).toEqual([undefined, "ses_1", "ses_2"]);
    expect(events.at(-1)).toEqual({ kind: "exit", code: 0 });
  });

  it("kills the child when the consumer cancels the iterator", async () => {
    const state = { killed: false };
    const iter = iterateRecoverableRun({
      recoveryAttempts: 2,
      recoveryBackoffMs: 0,
      isStopped: () => false,
      setRunning: () => {},
      createParser: noParser,
      spawn: () => hangingRun(state),
    })[Symbol.asyncIterator]();
    const pending = iter.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await iter.return?.();
    await pending;
    expect(state.killed).toBe(true);
  });

  it("stops waiting out the backoff once the run is stopped", async () => {
    let stopped = false;
    let spawns = 0;
    const started = Date.now();
    const events = await collect(
      iterateRecoverableRun({
        recoveryAttempts: 2,
        recoveryBackoffMs: 30_000,
        isStopped: () => stopped,
        setRunning: () => {},
        createParser: () => (_line, insight) => {
          insight.sessionId = "ses_slow";
          return [];
        },
        spawn: () => {
          spawns += 1;
          stopped = true;
          return finishedRun({ code: 1, stderr: "ECONNRESET" }, ["session"]);
        },
      }),
    );
    expect(spawns).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(events.at(-1)).toMatchObject({ kind: "exit" });
  });
});

describe("BayProcessControl", () => {
  it("does not let a previous run retry or clear the next child", async () => {
    const control = new BayProcessControl();
    const firstState = { killed: false };
    const secondState = { killed: false };
    const first = await control.beginRun();
    const firstIter = iterateRecoverableRun({
      recoveryAttempts: 2,
      recoveryBackoffMs: 0,
      isStopped: first.isStopped,
      setRunning: first.setRunning,
      createParser: noParser,
      spawn: () => hangingRun(firstState),
    })[Symbol.asyncIterator]();
    const firstEventsPromise = drain(firstIter);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await control.beginRun();
    expect(firstState.killed).toBe(true);

    const secondIter = iterateRecoverableRun({
      recoveryAttempts: 0,
      recoveryBackoffMs: 0,
      isStopped: second.isStopped,
      setRunning: second.setRunning,
      createParser: noParser,
      spawn: () => hangingRun(secondState),
    })[Symbol.asyncIterator]();
    const secondEventsPromise = drain(secondIter);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const firstEvents = await firstEventsPromise;
    expect(firstEvents.find((event) => event.kind === "error")).toMatchObject({
      kind: "error",
      critical: true,
      message: "enginebay: run aborted",
    });

    await control.abort();
    expect(secondState.killed).toBe(true);
    await secondEventsPromise;
  });

  it("keeps the child owned until an in-flight kill finishes", async () => {
    const control = new BayProcessControl();
    let killed = false;
    let releaseKill!: () => void;
    const child = {
      child: { pid: 1 } as SpawnedRun["child"],
      stdout: { async *[Symbol.asyncIterator]() {} },
      stderrText: () => "",
      wait: async () => ({ code: 0, stderr: "" }),
      kill: () =>
        new Promise<void>((resolve) => {
          releaseKill = () => {
            killed = true;
            resolve();
          };
        }),
    } satisfies SpawnedRun;

    const handle = await control.beginRun();
    handle.setRunning(child);

    const firstAbort = control.abort();
    // A second caller (close()) must wait for the same kill, not walk past it.
    const secondAbort = control.abort();
    let secondSettled = false;
    void secondAbort.then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondSettled).toBe(false);
    expect(killed).toBe(false);

    releaseKill();
    await Promise.all([firstAbort, secondAbort]);
    expect(killed).toBe(true);
  });
});
