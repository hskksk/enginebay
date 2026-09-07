import type { BayError } from "./types.js";

export const DEFAULT_RECOVERY_ATTEMPTS = 2;
export const DEFAULT_RECOVERY_BACKOFF_MS = 250;
export const RECOVERY_CONTINUE_PROMPT = "Continue.";

export function resolveRecoveryAttempts(value: number | undefined): number {
  const n = value ?? DEFAULT_RECOVERY_ATTEMPTS;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      "enginebay: recoveryAttempts must be a non-negative integer",
    );
  }
  return n;
}

export function resolveRecoveryBackoffMs(value: number | undefined): number {
  const n = value ?? DEFAULT_RECOVERY_BACKOFF_MS;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      "enginebay: recoveryBackoffMs must be a non-negative number",
    );
  }
  return n;
}

const MAX_ERROR_CHARS = 2000;

/** OpenCode `error.name` values that cannot be fixed by restarting the process. */
const OPENCODE_CRITICAL_NAMES = new Set([
  "ProviderAuthError",
  "MessageAbortedError",
  "MessageOutputLengthError",
  "ContextOverflowError",
  "StructuredOutputError",
]);

/** Claude stream-json `result.subtype` values that retrying the same run cannot fix. */
const CLAUDE_CRITICAL_SUBTYPES = new Set([
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);

/**
 * Anything not matched here is treated as recoverable: a crash, a rate limit,
 * and an unknown non-zero exit are all worth one more process start.
 */
const CRITICAL_PATTERNS: RegExp[] = [
  /unauthoriz/i,
  /\bforbidden\b/i,
  /\b(?:401|403)\b/,
  /\bauthentication\b/i,
  /\bnot logged in\b/i,
  /\blogin required\b/i,
  /\b(?:run|use)\s+\W*\w+ login\b/i,
  /\binvalid[_ ]api[_ ]key\b/i,
  /\bmissing api key\b/i,
  /\bapi[_ ]?key\b[^.\n]{0,40}\b(?:invalid|missing|not valid|expired|revoked)\b/i,
  /\btoken\b[^.\n]{0,40}\b(?:expired|revoked)\b/i,
  /\b(?:billing|payment required)\b/i,
  /\bcredit(?:s)? (?:exceeded|exhausted|limit)\b/i,
  /\b(?:insufficient[_\s]quota|quota exceeded)\b/i,
  /\b(?:unknown model|invalid model|model .+ not found)\b/i,
  /\b(?:error_max_turns|error_max_budget_usd|error_max_structured_output_retries)\b/i,
  /\b(?:enoent|not on path|command not found|could not launch)\b/i,
];

export function clipErrorText(text: string, max = MAX_ERROR_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

export function isCriticalErrorMessage(message: string): boolean {
  return CRITICAL_PATTERNS.some((pattern) => pattern.test(message));
}

export type ProcessFailureInput = {
  code: number;
  signal?: NodeJS.Signals | null;
  stderr: string;
  spawnError?: string;
  engineErrorMessage?: string;
  engineErrorName?: string;
  engineResultSubtype?: string;
  engineRetryable?: boolean;
  aborted: boolean;
};

function failureMessage(input: ProcessFailureInput): string {
  const spawnError = input.spawnError?.trim();
  const engineError = input.engineErrorMessage?.trim();
  const stderr = input.stderr.trim();
  const signal = input.signal ?? undefined;
  const parts: string[] = [];
  if (engineError) {
    parts.push(engineError);
  }
  if (spawnError) {
    parts.push(spawnError);
  }
  if (stderr && stderr !== engineError && stderr !== spawnError) {
    parts.push(stderr);
  }
  if (signal) {
    parts.push(`killed by ${signal}`);
  }
  if (parts.length === 0) {
    parts.push(`process exited with code ${input.code}`);
  }
  return clipErrorText(`enginebay: ${parts.join(": ")}`);
}

/**
 * Classify using each engine's own error shape first, then message fallbacks.
 *
 * OpenCode: `error.name` + `error.data.isRetryable`.
 * Claude: `result.subtype` (`error_during_execution` is an interrupted loop).
 * Cursor: documented failure is non-zero exit + stderr, often with no `result`.
 */
export function classifyProcessFailure(input: ProcessFailureInput): BayError {
  if (input.aborted) {
    return { message: "enginebay: run aborted", critical: true };
  }

  const message = failureMessage(input);
  const spawnError = input.spawnError?.trim() ?? "";
  const haystack = `${spawnError}\n${input.engineErrorMessage ?? ""}\n${input.stderr}\n${message}`;

  if (spawnError && /enoent|not found|could not launch/i.test(spawnError)) {
    return { message, critical: true };
  }

  const name = input.engineErrorName;
  if (name && OPENCODE_CRITICAL_NAMES.has(name)) {
    return { message, critical: true };
  }
  if (input.engineRetryable === true) {
    return { message, critical: false };
  }
  if (input.engineRetryable === false) {
    return { message, critical: true };
  }

  const subtype = input.engineResultSubtype;
  if (subtype && CLAUDE_CRITICAL_SUBTYPES.has(subtype)) {
    return { message, critical: true };
  }
  if (subtype === "error_during_execution") {
    return { message, critical: isCriticalErrorMessage(haystack) };
  }

  if (isCriticalErrorMessage(haystack)) {
    return { message, critical: true };
  }
  return { message, critical: false };
}

export function recoveryDiagnostic(input: {
  error: BayError;
  nextAttempt: number;
  maxAttempts: number;
  sessionId?: string;
}): string {
  const action = input.sessionId
    ? "restarting process and resuming session"
    : "restarting process";
  return clipErrorText(
    `enginebay: non-critical error; ${action} (attempt ${input.nextAttempt}/${input.maxAttempts}): ${input.error.message}`,
  );
}
