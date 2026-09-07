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

async function collect(iterable: AsyncIterable<BayEvent>): Promise<BayEvent[]> {
  const events: BayEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
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
        parseLine: () => [],
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

  it("resumes with the captured session id after a non-critical crash", async () => {
    let spawns = 0;
    let resumed: string | undefined;
    const events = await collect(
      iterateRecoverableRun({
        recoveryAttempts: 2,
        recoveryBackoffMs: 0,
        isStopped: () => false,
        setRunning: () => {},
        parseLine: (_line, insight) => {
          insight.sessionId = "ses_recover";
          return [];
        },
        spawn: (sessionId) => {
          spawns += 1;
          resumed = sessionId;
          if (sessionId) {
            return finishedRun({ code: 0, stderr: "" });
          }
          return finishedRun({ code: 1, stderr: "ECONNRESET" }, ["session"]);
        },
      }),
    );
    expect(spawns).toBe(2);
    expect(resumed).toBe("ses_recover");
    expect(events.at(-1)).toEqual({ kind: "exit", code: 0 });
  });

  it("kills the child when the consumer cancels the iterator", async () => {
    const state = { killed: false };
    const iter = iterateRecoverableRun({
      recoveryAttempts: 2,
      recoveryBackoffMs: 0,
      isStopped: () => false,
      setRunning: () => {},
      parseLine: () => [],
      spawn: () => hangingRun(state),
    })[Symbol.asyncIterator]();
    const pending = iter.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await iter.return();
    await pending;
    expect(state.killed).toBe(true);
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
      parseLine: () => [],
      spawn: () => hangingRun(firstState),
    })[Symbol.asyncIterator]();
    void firstIter.next();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await control.beginRun();
    expect(firstState.killed).toBe(true);

    const secondIter = iterateRecoverableRun({
      recoveryAttempts: 0,
      recoveryBackoffMs: 0,
      isStopped: second.isStopped,
      setRunning: second.setRunning,
      parseLine: () => [],
      spawn: () => hangingRun(secondState),
    })[Symbol.asyncIterator]();
    void secondIter.next();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const firstEvents: BayEvent[] = [];
    for (;;) {
      const step = await firstIter.next();
      if (step.done) {
        break;
      }
      firstEvents.push(step.value);
    }
    expect(firstEvents.find((event) => event.kind === "error")).toMatchObject({
      kind: "error",
      critical: true,
      message: "enginebay: run aborted",
    });

    await control.abort();
    expect(secondState.killed).toBe(true);
  });
});
