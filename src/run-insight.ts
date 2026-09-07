export type RunInsight = {
  sessionId?: string;
  engineErrorMessage?: string;
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

/**
 * Pull a process-level error string from a vendor JSON event.
 * Tool-result failures are not process errors.
 */
export function engineErrorFromRaw(
  raw: Record<string, unknown>,
): string | undefined {
  const type = raw.type;
  const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
  const resultIsError =
    type === "result" &&
    (raw.is_error === true || /^error/i.test(subtype));
  const typedError =
    type === "error" ||
    type === "session.error" ||
    type === "server.error";
  if (!resultIsError && !typedError) {
    return undefined;
  }
  const properties = asRecord(raw.properties);
  return (
    messageFromUnknown(raw.result) ??
    messageFromUnknown(raw.error) ??
    messageFromUnknown(properties?.error) ??
    messageFromUnknown(raw.message) ??
    (subtype.length > 0 ? subtype : undefined)
  );
}
