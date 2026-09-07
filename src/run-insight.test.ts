import { describe, expect, it } from "vitest";
import {
  captureEngineEvent,
  captureEngineError,
  captureSessionId,
  engineErrorFromRaw,
  type RunInsight,
} from "./run-insight.js";

describe("captureSessionId", () => {
  it("reads session_id, sessionId, sessionID, and nested part fields", () => {
    const insight: RunInsight = {};
    captureSessionId({ type: "system", session_id: "a" }, insight);
    expect(insight.sessionId).toBe("a");
    captureSessionId({ sessionID: "ignored" }, insight);
    expect(insight.sessionId).toBe("a");
    const nested: RunInsight = {};
    captureSessionId({ part: { sessionID: "ses_1" } }, nested);
    expect(nested.sessionId).toBe("ses_1");
  });
});

describe("engineErrorFromRaw", () => {
  it("reads Claude/Cursor result errors and OpenCode error events", () => {
    expect(
      engineErrorFromRaw({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Authentication required",
      }),
    ).toBe("Authentication required");
    expect(
      engineErrorFromRaw({
        type: "error",
        error: { data: { message: "ECONNRESET" } },
      }),
    ).toBe("ECONNRESET");
    expect(
      engineErrorFromRaw({ type: "assistant", message: { content: [] } }),
    ).toBeUndefined();
  });

  it("reads Claude errors[] when result text is empty", () => {
    expect(
      engineErrorFromRaw({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "",
        errors: ["API error: 529 overloaded"],
      }),
    ).toBe("API error: 529 overloaded");
  });
});

describe("captureEngineEvent", () => {
  it("records OpenCode APIError isRetryable and sessionID", () => {
    const insight: RunInsight = {};
    captureEngineEvent(
      {
        type: "error",
        sessionID: "ses_494719016ffe85dkDMj0FPRbHK",
        error: {
          name: "APIError",
          data: {
            message: "Rate limit exceeded",
            statusCode: 429,
            isRetryable: true,
          },
        },
      },
      insight,
    );
    expect(insight).toEqual({
      sessionId: "ses_494719016ffe85dkDMj0FPRbHK",
      engineErrorMessage: "Rate limit exceeded",
      engineErrorName: "APIError",
      engineRetryable: true,
    });
  });

  it("records Claude result subtype and session_id from system init", () => {
    const insight: RunInsight = {};
    captureEngineEvent(
      { type: "system", subtype: "init", session_id: "sess-claude" },
      insight,
    );
    captureEngineEvent(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sess-claude",
        errors: ["request cancelled"],
      },
      insight,
    );
    expect(insight.sessionId).toBe("sess-claude");
    expect(insight.engineResultSubtype).toBe("error_during_execution");
    expect(insight.engineErrorMessage).toBe("request cancelled");
  });
});

describe("captureEngineError", () => {
  it("keeps the first non-empty message", () => {
    const insight: RunInsight = {};
    captureEngineError("first", insight);
    captureEngineError("second", insight);
    expect(insight.engineErrorMessage).toBe("first");
  });
});
