import { describe, expect, it } from "vitest";
import { parseClaudeLine } from "./claude-parse.js";
import { redactBayEvent } from "./opencode-parse.js";

function parseAll(lines: string[]): ReturnType<typeof parseClaudeLine> {
  const toolById = new Map<string, string>();
  return lines.flatMap((line) => parseClaudeLine(line, toolById));
}

describe("parseClaudeLine", () => {
  it("maps text, thinking, tools, and remaining-budget payloads", () => {
    const events = parseAll([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "consider options" },
            { type: "text", text: "briefing loaded" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "mcp__board-mcp__get_briefing",
              input: {},
            },
          ],
          usage: { input_tokens: 4, output_tokens: 6 },
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [{ type: "text", text: '{"remaining_budget":7}' }],
            },
          ],
        },
      }),
    ]);
    expect(events).toEqual([
      { kind: "tokens", input: 4, output: 6, total: 10 },
      { kind: "thinking", text: "consider options" },
      { kind: "text", text: "briefing loaded" },
      {
        kind: "tool_call",
        callId: "tool-1",
        tool: "get_briefing",
        args: {},
      },
      {
        kind: "tool_result",
        callId: "tool-1",
        tool: "get_briefing",
        ok: true,
        result: [{ type: "text", text: '{"remaining_budget":7}' }],
      },
    ]);
  });

  it("captures session_id, result subtype, and errors[] on insight", () => {
    const insight: {
      sessionId?: string;
      engineErrorMessage?: string;
      engineResultSubtype?: string;
    } = {};
    parseClaudeLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-claude",
      }),
      new Map(),
      insight,
    );
    parseClaudeLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sess-claude",
        errors: ["API error: 529 overloaded"],
      }),
      new Map(),
      insight,
    );
    expect(insight.sessionId).toBe("sess-claude");
    expect(insight.engineResultSubtype).toBe("error_during_execution");
    expect(insight.engineErrorMessage).toBe("API error: 529 overloaded");
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
});
