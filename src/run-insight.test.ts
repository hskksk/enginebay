import { describe, expect, it } from "vitest";
import {
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
});

describe("captureEngineError", () => {
  it("keeps the first non-empty message", () => {
    const insight: RunInsight = {};
    captureEngineError("first", insight);
    captureEngineError("second", insight);
    expect(insight.engineErrorMessage).toBe("first");
  });
});
