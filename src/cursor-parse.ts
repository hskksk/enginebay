import { normalizeToolName } from "./opencode-parse.js";
import type { BayEvent } from "./types.js";

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as RawRecord;
  }
  return undefined;
}

function parseJsonLine(line: string): RawRecord | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function tokensFromRaw(raw: RawRecord): BayEvent | undefined {
  const usage = asRecord(raw.usage);
  if (!usage) {
    return undefined;
  }
  const input =
    typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : typeof usage.input === "number"
        ? usage.input
        : undefined;
  const output =
    typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : typeof usage.output === "number"
        ? usage.output
        : undefined;
  const total =
    typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : typeof usage.total === "number"
        ? usage.total
        : input !== undefined || output !== undefined
          ? (input ?? 0) + (output ?? 0)
          : undefined;
  if (input === undefined && output === undefined && total === undefined) {
    return undefined;
  }
  return { kind: "tokens", input, output, total };
}

function textFromContent(content: unknown): string[] {
  if (typeof content === "string" && content.length > 0) {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (!item) {
      continue;
    }
    if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
      texts.push(item.text);
    }
  }
  return texts;
}

function thinkingFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (!item) {
      continue;
    }
    if (item.type === "thinking") {
      const text =
        typeof item.thinking === "string"
          ? item.thinking
          : typeof item.text === "string"
            ? item.text
            : undefined;
      if (text && text.length > 0) {
        texts.push(text);
      }
    }
  }
  return texts;
}

function camelToToolName(key: string): string {
  const stripped = key.endsWith("ToolCall") ? key.slice(0, -"ToolCall".length) : key;
  if (stripped.length === 0) {
    return "unknown";
  }
  return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}

function parseFunctionArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * Cursor stream-json puts the tool under a typed key (`readToolCall`) or
 * a `function` object. Either shape may appear on started/completed events.
 */
export function parseCursorToolCall(toolCall: unknown): {
  tool: string;
  args?: unknown;
  result?: unknown;
} {
  const rec = asRecord(toolCall);
  if (!rec) {
    return { tool: "unknown" };
  }
  if (typeof rec.name === "string") {
    return {
      tool: normalizeToolName(rec.name),
      args: rec.args ?? rec.arguments,
      result: rec.result,
    };
  }
  const fn = asRecord(rec.function);
  if (fn && typeof fn.name === "string") {
    return {
      tool: normalizeToolName(fn.name),
      args: parseFunctionArgs(fn.arguments ?? fn.args),
      result: fn.result ?? rec.result,
    };
  }
  for (const [key, value] of Object.entries(rec)) {
    if (key === "function") {
      continue;
    }
    const nested = asRecord(value);
    if (!nested) {
      continue;
    }
    return {
      tool: normalizeToolName(camelToToolName(key)),
      args: nested.args ?? parseFunctionArgs(nested.arguments),
      result: nested.result,
    };
  }
  return { tool: "unknown" };
}

function toolResultOk(result: unknown): boolean {
  const rec = asRecord(result);
  if (!rec) {
    return true;
  }
  if (rec.error !== undefined && rec.error !== null && rec.error !== false) {
    return false;
  }
  if (rec.is_error === true) {
    return false;
  }
  return true;
}

/**
 * Parse one NDJSON line from `agent -p --output-format stream-json`.
 * `toolById` correlates started/completed tool events.
 */
export function parseCursorLine(
  line: string,
  toolById: Map<string, string>,
): BayEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const raw = parseJsonLine(trimmed);
  if (!raw) {
    return [{ kind: "diagnostic", stream: "stdout", text: trimmed }];
  }

  const events: BayEvent[] = [];
  const tokenEvent = tokensFromRaw(raw);
  if (tokenEvent) {
    events.push(tokenEvent);
  }

  const type = raw.type;
  if (type === "assistant") {
    // Buffered flush before a tool call is a duplicate of streamed text.
    if (raw.model_call_id !== undefined) {
      return events;
    }
    const message = asRecord(raw.message);
    for (const text of thinkingFromContent(message?.content)) {
      events.push({ kind: "thinking", text });
    }
    for (const text of textFromContent(message?.content)) {
      events.push({ kind: "text", text });
    }
    return events;
  }

  if (type === "thinking") {
    const text =
      typeof raw.text === "string"
        ? raw.text
        : textFromContent(asRecord(raw.message)?.content)[0];
    if (text && text.length > 0) {
      events.push({ kind: "thinking", text });
    }
    return events;
  }

  if (type === "tool_call") {
    const callId = typeof raw.call_id === "string" ? raw.call_id : "unknown";
    const parsed = parseCursorToolCall(raw.tool_call);
    const known = toolById.get(callId);
    const tool = known ?? parsed.tool;
    if (raw.subtype === "completed") {
      if (!known) {
        toolById.set(callId, parsed.tool);
        events.push({
          kind: "tool_call",
          callId,
          tool: parsed.tool,
          args: parsed.args ?? {},
        });
      }
      events.push({
        kind: "tool_result",
        callId,
        tool,
        ok: toolResultOk(parsed.result),
        result: parsed.result,
      });
      return events;
    }
    if (!known) {
      toolById.set(callId, parsed.tool);
      events.push({
        kind: "tool_call",
        callId,
        tool: parsed.tool,
        args: parsed.args ?? {},
      });
    }
    return events;
  }

  if (type === "result" && (raw.is_error === true || raw.subtype === "error")) {
    const text =
      typeof raw.result === "string"
        ? raw.result
        : typeof raw.error === "string"
          ? raw.error
          : trimmed;
    if (text.length > 0) {
      events.push({ kind: "diagnostic", stream: "stdout", text });
    }
  }

  return events;
}
