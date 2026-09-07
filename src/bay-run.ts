import { redactBayEvent } from "./opencode-parse.js";
import {
  classifyProcessFailure,
  DEFAULT_RECOVERY_ATTEMPTS,
  recoveryDiagnostic,
} from "./process-error.js";
import type { RunInsight } from "./run-insight.js";
import type { SpawnedRun } from "./spawn.js";
import type { BayError, BayEvent } from "./types.js";

export async function* iterateRecoverableRun(input: {
  spawn: (resumeSessionId: string | undefined) => SpawnedRun;
  parseLine: (line: string, insight: RunInsight) => BayEvent[];
  resetParser?: () => void;
  setRunning: (run: SpawnedRun | undefined) => void;
  isStopped: () => boolean;
  recoveryAttempts?: number;
}): AsyncIterable<BayEvent> {
  const extra = input.recoveryAttempts ?? DEFAULT_RECOVERY_ATTEMPTS;
  const maxAttempts = 1 + Math.max(0, extra);
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
        !lastError.critical && attempt < maxAttempts && !stopped;
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
        continue;
      }
      break;
    } finally {
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
