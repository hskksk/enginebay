import { describe, expect, it } from "vitest";
import { parseOpencodeLine, redactBayEvent } from "./opencode-parse.js";

function parseAll(lines: string[]): ReturnType<typeof parseOpencodeLine> {
  const seen = new Set<string>();
  return lines.flatMap((line) => parseOpencodeLine(line, seen));
}

describe("parseOpencodeLine", () => {
  it("maps text and reasoning parts", () => {
    expect(
      parseAll([
        JSON.stringify({
          type: "text",
          part: { type: "text", text: "briefing loaded" },
        }),
        JSON.stringify({
          type: "reasoning",
          part: { type: "reasoning", text: "consider options" },
        }),
      ]),
    ).toEqual([
      { kind: "text", text: "briefing loaded" },
      { kind: "thinking", text: "consider options" },
    ]);
  });

  it("emits tool_call then tool_result and strips MCP prefixes", () => {
    const seen = new Set<string>();
    const start = parseOpencodeLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          type: "tool",
          tool: "mcp__enginebay__get_briefing",
          callID: "c1",
          state: { status: "running", input: {} },
        },
      }),
      seen,
    );
    const done = parseOpencodeLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          type: "tool",
          tool: "mcp__enginebay__get_briefing",
          callID: "c1",
          state: {
            status: "completed",
            input: {},
            output: '{"remaining_budget":9}',
          },
        },
      }),
      seen,
    );
    expect(start).toEqual([
      { kind: "tool_call", callId: "c1", tool: "get_briefing", args: {} },
    ]);
    expect(done).toEqual([
      {
        kind: "tool_result",
        callId: "c1",
        tool: "get_briefing",
        ok: true,
        result: '{"remaining_budget":9}',
      },
    ]);
  });

  it("emits both call and result when the first event is already completed", () => {
    expect(
      parseAll([
        JSON.stringify({
          type: "tool_use",
          part: {
            type: "tool",
            tool: "read",
            id: "t2",
            state: { status: "error", input: { path: "a" }, error: "missing" },
          },
        }),
      ]),
    ).toEqual([
      { kind: "tool_call", callId: "t2", tool: "read", args: { path: "a" } },
      {
        kind: "tool_result",
        callId: "t2",
        tool: "read",
        ok: false,
        result: "missing",
      },
    ]);
  });

  it("reads tokens from step_finish without requiring an eval collector", () => {
    expect(
      parseAll([
        JSON.stringify({
          type: "step_finish",
          tokens: { input: 10, output: 20, total: 30 },
        }),
      ]),
    ).toEqual([{ kind: "tokens", input: 10, output: 20, total: 30 }]);
  });

  it("captures session IDs and OpenCode error.name / isRetryable", () => {
    const insight: { sessionId?: string; engineErrorMessage?: string; engineErrorName?: string; engineRetryable?: boolean } = {};
    const events = parseOpencodeLine(
      JSON.stringify({
        type: "error",
        sessionID: "ses_9",
        error: {
          name: "APIError",
          data: { message: "provider overloaded", statusCode: 529, isRetryable: true },
        },
      }),
      new Set(),
      insight,
    );
    expect(insight.sessionId).toBe("ses_9");
    expect(insight.engineErrorMessage).toBe("provider overloaded");
    expect(insight.engineErrorName).toBe("APIError");
    expect(insight.engineRetryable).toBe(true);
    expect(events).toContainEqual({
      kind: "diagnostic",
      stream: "stdout",
      text: "provider overloaded",
    });
  });

  it("treats non-JSON stdout as a diagnostic and ignores unknown JSON types", () => {
    expect(parseAll(["not json", JSON.stringify({ type: "session.created" })])).toEqual([
      { kind: "diagnostic", stream: "stdout", text: "not json" },
    ]);
  });

  it("skips blank lines", () => {
    expect(parseAll(["", "  "])).toEqual([]);
  });
});

describe("redactBayEvent", () => {
  it("redacts ghs_, github_pat_, and Bearer in text and nested tool payloads", () => {
    expect(
      redactBayEvent({
        kind: "text",
        text: "token ghs_ABC123 and Bearer xyz.abc",
      }),
    ).toEqual({ kind: "text", text: "token [redacted] and [redacted]" });
    expect(
      redactBayEvent({
        kind: "tool_call",
        callId: "c",
        tool: "x",
        args: { token: "github_pat_zzz" },
      }),
    ).toMatchObject({ args: { token: "[redacted]" } });
    expect(
      redactBayEvent({
        kind: "error",
        message: "token ghs_LIVESECRET99",
        critical: true,
      }),
    ).toEqual({
      kind: "error",
      message: "token [redacted]",
      critical: true,
    });
    expect(
      redactBayEvent({
        kind: "exit",
        code: 1,
        error: { message: "Bearer abc.def leaked", critical: false },
      }),
    ).toEqual({
      kind: "exit",
      code: 1,
      error: { message: "[redacted] leaked", critical: false },
    });
  });
});
