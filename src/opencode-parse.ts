import { redactSecrets, redactSecretsDeep } from "./redact.js";
import {
  captureEngineEvent,
  engineErrorFromRaw,
  type RunInsight,
} from "./run-insight.js";
import type { BayEvent } from "./types.js";

export function normalizeToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, "");
}

export function redactBayEvent(event: BayEvent): BayEvent {
  switch (event.kind) {
    case "text":
    case "thinking":
    case "diagnostic":
      return { ...event, text: redactSecrets(event.text) };
    case "error":
      return { ...event, message: redactSecrets(event.message) };
    case "exit":
      if (!event.error) {
        return event;
      }
      return {
        ...event,
        error: {
          ...event.error,
          message: redactSecrets(event.error.message),
        },
      };
    case "tool_call":
      return {
        ...event,
        tool: event.tool,
        args: redactSecretsDeep(event.args),
      };
    case "tool_result":
      return {
        ...event,
        result: redactSecretsDeep(event.result),
      };
    default:
      return event;
  }
}

type RawPart = {
  type?: string;
  text?: string;
  tool?: string;
  id?: string;
  callID?: string;
  callId?: string;
  messageID?: string;
  reason?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
};

type RawEvent = {
  type?: string;
  part?: RawPart;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
    reasoning?: number;
  };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function parseJsonLine(line: string): RawEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return asRecord(parsed) as RawEvent | undefined;
  } catch {
    return undefined;
  }
}

function callIdOf(part: RawPart | undefined): string {
  if (!part) {
    return "unknown";
  }
  return part.callID ?? part.callId ?? part.id ?? "unknown";
}

function tokensEvent(raw: RawEvent): BayEvent | undefined {
  const tokens = raw.tokens;
  if (!tokens) {
    return undefined;
  }
  const input = typeof tokens.input === "number" ? tokens.input : undefined;
  const output = typeof tokens.output === "number" ? tokens.output : undefined;
  const reasoning =
    typeof tokens.reasoning === "number" ? tokens.reasoning : undefined;
  const total =
    typeof tokens.total === "number"
      ? tokens.total
      : input !== undefined || output !== undefined
        ? (input ?? 0) + (output ?? 0) + (reasoning ?? 0)
        : undefined;
  if (input === undefined && output === undefined && total === undefined) {
    return undefined;
  }
  return { kind: "tokens", input, output, total };
}

/**
 * Parse one NDJSON line from `opencode run --format json`.
 * Unknown JSON types are ignored (not emitted as diagnostics).
 */
export function parseOpencodeLine(
  line: string,
  seenToolCalls: Set<string>,
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

  const events: BayEvent[] = [];
  const rec = asRecord(raw) ?? {};
  captureEngineEvent(rec, insight);
  const engineError = engineErrorFromRaw(rec);
  if (engineError) {
    events.push({ kind: "diagnostic", stream: "stdout", text: engineError });
  }

  const tokenEvent = tokensEvent(raw);
  if (tokenEvent) {
    events.push(tokenEvent);
  }

  const type = raw.type;
  const part = raw.part;
  const partType = part?.type;

  if (
    (type === "text" || partType === "text") &&
    typeof part?.text === "string" &&
    part.text.length > 0
  ) {
    events.push({ kind: "text", text: part.text });
    return events;
  }

  if (
    (type === "reasoning" || partType === "reasoning") &&
    typeof part?.text === "string" &&
    part.text.length > 0
  ) {
    events.push({ kind: "thinking", text: part.text });
    return events;
  }

  const toolName =
    typeof part?.tool === "string"
      ? part.tool
      : type === "tool_use" && typeof partType === "string" && partType !== "tool"
        ? partType
        : undefined;
  if (type === "tool_use" || partType === "tool") {
    const tool = normalizeToolName(toolName ?? "unknown");
    const callId = callIdOf(part);
    const status = part?.state?.status;
    const failed = status === "error";
    const completed = status === "completed" || failed;
    if (completed) {
      if (!seenToolCalls.has(callId)) {
        seenToolCalls.add(callId);
        events.push({
          kind: "tool_call",
          callId,
          tool,
          args: part?.state?.input,
        });
      }
      events.push({
        kind: "tool_result",
        callId,
        tool,
        ok: !failed,
        result: failed ? part?.state?.error : part?.state?.output,
      });
      return events;
    }
    if (!seenToolCalls.has(callId)) {
      seenToolCalls.add(callId);
      events.push({
        kind: "tool_call",
        callId,
        tool,
        args: part?.state?.input,
      });
    }
    return events;
  }

  return events;
}
