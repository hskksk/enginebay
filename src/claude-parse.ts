import { normalizeToolName } from "./opencode-parse.js";
import {
  captureEngineError,
  captureSessionId,
  engineErrorFromRaw,
  type RunInsight,
} from "./run-insight.js";
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

function tokensFromMessage(message: RawRecord | undefined): BayEvent | undefined {
  const usage = asRecord(message?.usage);
  if (!usage) {
    return undefined;
  }
  const input =
    typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const output =
    typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  if (input === undefined && output === undefined) {
    return undefined;
  }
  return {
    kind: "tokens",
    input,
    output,
    total: (input ?? 0) + (output ?? 0),
  };
}

/**
 * Parse one NDJSON line from `claude --output-format stream-json`.
 * `toolById` correlates tool_use ids with later tool_result blocks.
 */
export function parseClaudeLine(
  line: string,
  toolById: Map<string, string>,
  insight?: RunInsight,
): BayEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const raw = parseJsonLine(trimmed);
  if (!raw) {
    return [{ kind: "diagnostic", stream: "stdout", text: trimmed }];
  }

  captureSessionId(raw, insight);
  captureEngineError(engineErrorFromRaw(raw), insight);

  const events: BayEvent[] = [];
  const message = asRecord(raw.message);
  const tokenEvent = tokensFromMessage(message);
  if (tokenEvent) {
    events.push(tokenEvent);
  }

  const content = message?.content;
  if (!Array.isArray(content)) {
    return events;
  }

  const isAssistant = raw.type === "assistant";
  const isUser = raw.type === "user";

  for (const block of content) {
    const item = asRecord(block);
    if (!item) {
      continue;
    }
    if (isAssistant && item.type === "thinking" && typeof item.thinking === "string") {
      if (item.thinking.length > 0) {
        events.push({ kind: "thinking", text: item.thinking });
      }
      continue;
    }
    if (isAssistant && item.type === "text" && typeof item.text === "string") {
      if (item.text.length > 0) {
        events.push({ kind: "text", text: item.text });
      }
      continue;
    }
    if (isAssistant && item.type === "tool_use" && typeof item.name === "string") {
      const tool = normalizeToolName(item.name);
      const callId = typeof item.id === "string" ? item.id : "unknown";
      toolById.set(callId, tool);
      events.push({
        kind: "tool_call",
        callId,
        tool,
        args: item.input ?? {},
      });
      continue;
    }
    if ((isAssistant || isUser) && item.type === "tool_result") {
      const callId =
        typeof item.tool_use_id === "string" ? item.tool_use_id : "unknown";
      const tool = toolById.get(callId) ?? "unknown";
      events.push({
        kind: "tool_result",
        callId,
        tool,
        ok: item.is_error !== true,
        result: item.content,
      });
    }
  }
  return events;
}
