import type { BayError } from "./types.js";

export const DEFAULT_RECOVERY_ATTEMPTS = 2;
export const RECOVERY_CONTINUE_PROMPT = "Continue.";

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

const CRITICAL_PATTERNS: RegExp[] = [
  /\b(unauthoriz|authentication|not logged in|login required|invalid api key|api[_ ]?key(?: is)?(?: invalid| missing)|missing api key)\b/i,
  /\b(billing|payment required|credit(?:s)? (?:exceeded|exhausted|limit)|insufficient[_\s]quota)\b/i,
  /\b(unknown model|invalid model|model .+ not found)\b/i,
  /\b(error_max_turns|error_max_budget_usd|error_max_structured_output_retries)\b/i,
  /\b(enoent|not on path|command not found|could not launch)\b/i,
];

const RECOVERABLE_PATTERNS: RegExp[] = [
  /\b(rate limit|too many requests|overloaded|try again|temporarily unavailable)\b/i,
  /\b(econnreset|etimedout|enotfound|eai_again|socket hang up|fetch failed|network)\b/i,
  /\b(429|529|503|504)\b/,
  /\btimeout\b/i,
];

const CRASH_SIGNALS = new Set<string>([
  "SIGKILL",
  "SIGSEGV",
  "SIGABRT",
  "SIGBUS",
  "SIGILL",
  "SIGFPE",
]);

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

function isRecoverableErrorMessage(message: string): boolean {
  return RECOVERABLE_PATTERNS.some((pattern) => pattern.test(message));
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
  } else if (stderr && stderr !== engineError) {
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
  if (input.signal && CRASH_SIGNALS.has(input.signal)) {
    return { message, critical: false };
  }
  if (isRecoverableErrorMessage(haystack)) {
    return { message, critical: false };
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
