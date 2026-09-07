import { describe, expect, it } from "vitest";
import {
  classifyProcessFailure,
  clipErrorText,
  isCriticalErrorMessage,
  recoveryDiagnostic,
} from "./process-error.js";

describe("classifyProcessFailure", () => {
  it("treats abort as critical", () => {
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "ECONNRESET",
        aborted: true,
      }),
    ).toEqual({ message: "enginebay: run aborted", critical: true });
  });

  it("treats missing CLI spawn errors as critical", () => {
    const error = classifyProcessFailure({
      code: 1,
      stderr: "",
      spawnError: "spawn claude ENOENT",
      aborted: false,
    });
    expect(error.critical).toBe(true);
    expect(error.message).toMatch(/ENOENT/);
  });

  it("uses OpenCode error.name and isRetryable", () => {
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "",
        engineErrorName: "ProviderAuthError",
        engineErrorMessage: "provider not configured",
        aborted: false,
      }).critical,
    ).toBe(true);
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "",
        engineErrorName: "APIError",
        engineErrorMessage: "Rate limit exceeded",
        engineRetryable: true,
        aborted: false,
      }).critical,
    ).toBe(false);
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "",
        engineErrorName: "APIError",
        engineErrorMessage: "permission denied by provider",
        engineRetryable: false,
        aborted: false,
      }).critical,
    ).toBe(true);
  });

  it("uses Claude result subtypes", () => {
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "",
        engineResultSubtype: "error_max_turns",
        engineErrorMessage: "error_max_turns",
        aborted: false,
      }).critical,
    ).toBe(true);
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "",
        engineResultSubtype: "error_max_budget_usd",
        aborted: false,
      }).critical,
    ).toBe(true);
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "",
        engineResultSubtype: "error_during_execution",
        engineErrorMessage: "API error: 529 overloaded",
        aborted: false,
      }).critical,
    ).toBe(false);
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "",
        engineResultSubtype: "error_during_execution",
        engineErrorMessage: "authentication required",
        aborted: false,
      }).critical,
    ).toBe(true);
  });

  it("treats Cursor-style stderr failures without a result event", () => {
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "socket hang up",
        aborted: false,
      }).critical,
    ).toBe(false);
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "Authentication required",
        aborted: false,
      }).critical,
    ).toBe(true);
  });

  it("treats authentication and billing messages as critical", () => {
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "",
        engineErrorMessage: "Authentication required",
        aborted: false,
      }).critical,
    ).toBe(true);
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "invalid API key",
        aborted: false,
      }).critical,
    ).toBe(true);
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "billing credits exhausted",
        aborted: false,
      }).critical,
    ).toBe(true);
  });

  it("treats rate limits, network errors, and crashes as recoverable", () => {
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "ECONNRESET: connection reset",
        aborted: false,
      }).critical,
    ).toBe(false);
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "rate limit exceeded (429)",
        aborted: false,
      }).critical,
    ).toBe(false);
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "",
        signal: "SIGKILL",
        aborted: false,
      }).critical,
    ).toBe(false);
  });

  it("prefers the engine error message as the cause", () => {
    const error = classifyProcessFailure({
      code: 1,
      stderr: "noise",
      engineErrorMessage: "overloaded, try again",
      aborted: false,
    });
    expect(error.critical).toBe(false);
    expect(error.message).toMatch(/overloaded, try again/);
  });

  it("defaults unknown non-zero exits to recoverable", () => {
    expect(
      classifyProcessFailure({
        code: 1,
        stderr: "",
        aborted: false,
      }),
    ).toEqual({
      message: "enginebay: process exited with code 1",
      critical: false,
    });
  });
});

describe("isCriticalErrorMessage", () => {
  it("detects missing-CLI wording without relying on Claude subtypes", () => {
    expect(isCriticalErrorMessage("command not found")).toBe(true);
    expect(isCriticalErrorMessage("socket hang up")).toBe(false);
  });
});

describe("recoveryDiagnostic", () => {
  it("mentions resume when a session id is known", () => {
    expect(
      recoveryDiagnostic({
        error: { message: "enginebay: ECONNRESET", critical: false },
        nextAttempt: 2,
        maxAttempts: 3,
        sessionId: "sess-1",
      }),
    ).toMatch(/resuming session \(attempt 2\/3\): enginebay: ECONNRESET/);
  });
});

describe("clipErrorText", () => {
  it("truncates long causes", () => {
    expect(clipErrorText("x".repeat(10), 4)).toBe("xxxx…");
  });
});
