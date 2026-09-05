import { describe, expect, it } from "vitest";
import { parseCursorLine, parseCursorToolCall } from "./cursor-parse.js";
import { redactBayEvent } from "./opencode-parse.js";

function parseAll(lines: string[]): ReturnType<typeof parseCursorLine> {
  const toolById = new Map<string, string>();
  return lines.flatMap((line) => parseCursorLine(line, toolById));
}

describe("parseCursorLine", () => {
  it("maps assistant text, tools, and MCP names from stream-json", () => {
    const events = parseAll([
      JSON.stringify({
        type: "system",
        subtype: "init",
        model: "Composer",
        session_id: "sess-1",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "Read README.md" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I'll read the file" }],
        },
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "tool-1",
        tool_call: { readToolCall: { args: { path: "README.md" } } },
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "tool-1",
        tool_call: {
          readToolCall: {
            args: { path: "README.md" },
            result: { success: { content: "# Hi", totalLines: 1 } },
          },
        },
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "tool-2",
        tool_call: {
          function: {
            name: "mcp__board-mcp__get_briefing",
            arguments: "{}",
          },
        },
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "tool-2",
        tool_call: {
          function: {
            name: "mcp__board-mcp__get_briefing",
            arguments: "{}",
            result: { success: { remaining_budget: 7 } },
          },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "I'll read the file",
      }),
    ]);
    expect(events).toEqual([
      { kind: "text", text: "I'll read the file" },
      {
        kind: "tool_call",
        callId: "tool-1",
        tool: "read",
        args: { path: "README.md" },
      },
      {
        kind: "tool_result",
        callId: "tool-1",
        tool: "read",
        ok: true,
        result: { success: { content: "# Hi", totalLines: 1 } },
      },
      {
        kind: "tool_call",
        callId: "tool-2",
        tool: "get_briefing",
        args: {},
      },
      {
        kind: "tool_result",
        callId: "tool-2",
        tool: "get_briefing",
        ok: true,
        result: { success: { remaining_budget: 7 } },
      },
    ]);
  });

  it("emits both call and result when the first event is already completed", () => {
    expect(
      parseAll([
        JSON.stringify({
          type: "tool_call",
          subtype: "completed",
          call_id: "t2",
          tool_call: {
            writeToolCall: {
              args: { path: "summary.txt", fileText: "hi" },
              result: { success: { linesCreated: 1 } },
            },
          },
        }),
      ]),
    ).toEqual([
      {
        kind: "tool_call",
        callId: "t2",
        tool: "write",
        args: { path: "summary.txt", fileText: "hi" },
      },
      {
        kind: "tool_result",
        callId: "t2",
        tool: "write",
        ok: true,
        result: { success: { linesCreated: 1 } },
      },
    ]);
  });

  it("marks failed tool results and error terminal events", () => {
    const events = parseAll([
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "t-err",
        tool_call: {
          readToolCall: {
            args: { path: "missing.txt" },
            result: { error: { message: "ENOENT" } },
          },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Authentication required",
      }),
    ]);
    expect(events).toContainEqual({
      kind: "tool_result",
      callId: "t-err",
      tool: "read",
      ok: false,
      result: { error: { message: "ENOENT" } },
    });
    expect(events).toContainEqual({
      kind: "diagnostic",
      stream: "stdout",
      text: "Authentication required",
    });
  });

  it("skips duplicate assistant flushes that carry model_call_id", () => {
    expect(
      parseAll([
        JSON.stringify({
          type: "assistant",
          timestamp_ms: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp_ms: 2,
          model_call_id: "mc-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
        }),
      ]),
    ).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("treats non-JSON stdout as a diagnostic", () => {
    expect(parseAll(["not json"])).toEqual([
      { kind: "diagnostic", stream: "stdout", text: "not json" },
    ]);
  });

  it("redacts secrets in assistant text", () => {
    const [event] = parseAll([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "token ghs_ABC123" }],
        },
      }),
    ]);
    expect(redactBayEvent(event!)).toEqual({
      kind: "text",
      text: "token [redacted]",
    });
  });

  it("maps thinking events when print mode emits them", () => {
    expect(
      parseAll([
        JSON.stringify({ type: "thinking", text: "consider options" }),
      ]),
    ).toEqual([{ kind: "thinking", text: "consider options" }]);
  });
});

describe("parseCursorToolCall", () => {
  it("reads typed ToolCall keys and function payloads", () => {
    expect(
      parseCursorToolCall({
        grepToolCall: { args: { pattern: "foo" } },
      }),
    ).toEqual({ tool: "grep", args: { pattern: "foo" }, result: undefined });
    expect(
      parseCursorToolCall({
        function: { name: "mcp__enginebay__tick", arguments: '{"n":1}' },
      }),
    ).toEqual({ tool: "tick", args: { n: 1 }, result: undefined });
  });
});
