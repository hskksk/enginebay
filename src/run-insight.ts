export type RunInsight = {
  sessionId?: string;
  engineErrorMessage?: string;
  /** OpenCode `error.name` (ProviderAuthError, APIError, …). */
  engineErrorName?: string;
  /** Claude/Cursor `result.subtype` (error_during_execution, …). */
  engineResultSubtype?: string;
  /**
   * The engine's terminal event said the turn failed. Mid-stream error events
   * do not set this: an engine that recovers and exits 0 must not be resumed.
   */
  engineTerminalError?: boolean;
  /** OpenCode `error.data.isRetryable` when the vendor set it. */
  engineRetryable?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function messageFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  const rec = asRecord(value);
  if (!rec) {
    return undefined;
  }
  const data = asRecord(rec.data);
  return firstString([
    rec.message,
    rec.error,
    rec.result,
    data?.message,
    typeof rec.name === "string" && rec.name.length > 0 ? rec.name : undefined,
  ]);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
}

export function captureSessionId(
  raw: Record<string, unknown>,
  insight?: RunInsight,
): void {
  if (!insight || insight.sessionId) {
    return;
  }
  const part = asRecord(raw.part);
  const properties = asRecord(raw.properties);
  const sessionId = firstString([
    raw.session_id,
    raw.sessionId,
    raw.sessionID,
    part?.session_id,
    part?.sessionId,
    part?.sessionID,
    properties?.session_id,
    properties?.sessionId,
    properties?.sessionID,
  ]);
  if (sessionId) {
    insight.sessionId = sessionId;
  }
}

export function captureEngineError(
  message: string | undefined,
  insight?: RunInsight,
): void {
  if (!insight || insight.engineErrorMessage) {
    return;
  }
  if (message && message.length > 0) {
    insight.engineErrorMessage = message;
  }
}

function noteRetryable(value: unknown, insight: RunInsight): void {
  if (insight.engineRetryable !== undefined) {
    return;
  }
  if (typeof value === "boolean") {
    insight.engineRetryable = value;
  }
}

function noteErrorObject(
  error: Record<string, unknown> | undefined,
  insight: RunInsight,
): void {
  if (!error) {
    return;
  }
  if (!insight.engineErrorName && typeof error.name === "string") {
    insight.engineErrorName = error.name;
  }
  const data = asRecord(error.data);
  noteRetryable(error.isRetryable, insight);
  noteRetryable(data?.isRetryable, insight);
  captureEngineError(messageFromUnknown(error) ?? messageFromUnknown(data), insight);
}

/**
 * Record vendor session ids and structured process-error fields from one JSON event.
 */
export function captureEngineEvent(
  raw: Record<string, unknown>,
  insight?: RunInsight,
): void {
  captureSessionId(raw, insight);
  if (!insight) {
    return;
  }

  const type = raw.type;
  const subtype = typeof raw.subtype === "string" ? raw.subtype : undefined;
  const properties = asRecord(raw.properties);

  if (
    type === "error" ||
    type === "session.error" ||
    type === "server.error"
  ) {
    noteErrorObject(asRecord(raw.error) ?? asRecord(properties?.error), insight);
    captureEngineError(messageFromUnknown(raw), insight);
    return;
  }

  if (type !== "result") {
    return;
  }
  if (subtype && !insight.engineResultSubtype) {
    insight.engineResultSubtype = subtype;
  }
  const isError =
    raw.is_error === true ||
    (subtype !== undefined && /^error/i.test(subtype));
  if (!isError) {
    return;
  }
  insight.engineTerminalError = true;
  const listed = stringList(raw.errors);
  captureEngineError(
    messageFromUnknown(raw.result) ??
      (listed.length > 0 ? listed.join("; ") : undefined) ??
      messageFromUnknown(raw.error) ??
      subtype,
    insight,
  );
}

/**
 * Pull a process-level error string from a vendor JSON event.
 * Tool-result failures are not process errors.
 */
export function engineErrorFromRaw(
  raw: Record<string, unknown>,
): string | undefined {
  const insight: RunInsight = {};
  captureEngineEvent(raw, insight);
  return insight.engineErrorMessage;
}
