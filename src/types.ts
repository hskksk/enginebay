import type { SpawnAdapter } from "./spawn.js";
import type { PreparedWorkspace } from "./workspace.js";

export const ENGINE_IDS = ["opencode", "claude-code", "cursor-agent"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export const ISOLATION_KINDS = ["env"] as const;
export type IsolationKind = (typeof ISOLATION_KINDS)[number];

export type McpStdio = {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** MCP server name inside the engine. Default: "enginebay". */
  name?: string;
};

/** OpenCode config merge. `mcp` / `instructions` stay owned by enginebay. */
export type EngineConfig = {
  plugins?: string[];
  extra?: Record<string, unknown>;
};

export type ExitReason = "ok" | "error" | "abort" | "timeout";

export type RunOptions = {
  /** Kill the child after this many ms. Last event: reason timeout, code 124. */
  timeoutMs?: number;
};

export type OpenBayOptions = {
  engine: EngineId;
  /**
   * Explicit cwd. Consumer-owned: `close()` does not delete it.
   * Omit together with `workspaceId` for an ephemeral temp dir.
   */
  workDir?: string;
  /**
   * Named persistent workspace under `$XDG_DATA_HOME/enginebay/workspaces/<id>`.
   * Do not set together with `workDir`.
   */
  workspaceId?: string;
  isolation?: { kind: IsolationKind };
  mcp?: McpStdio;
  /** Inline text. enginebay writes a temp file if the engine only accepts paths. */
  instructions?: string;
  /**
   * Product temp vars (minted GH_TOKEN, harness flags). Isolation, auth, and
   * OpenCode config are first-class options — do not set HOME / XDG_* here.
   */
  extraEnv?: Record<string, string>;
  /** Override host process.env / homedir in tests. */
  hostEnv?: NodeJS.ProcessEnv;
  hostHome?: string;
  model?: string;
  /** OpenCode `--agent`. Other engines ignore this for now. */
  agent?: string;
  /** OpenCode plugin / extra config merged with session MCP. */
  config?: EngineConfig;
  /**
   * OpenCode `XDG_DATA_HOME`. Omit for a temp dir deleted on `close()`.
   * When set, `close()` keeps it so sessions can be resumed later.
   */
  dataDir?: string;
  /**
   * Delete engine session DB files (`opencode.db*`) in `dataDir` while
   * keeping auth links. Default false.
   */
  resetSession?: boolean;
  /** Override the host auth directory used for allowlisted attach. */
  auth?: { sourceDir?: string };
  /** Wrap or remap the child spawn (e.g. container exec). */
  spawn?: SpawnAdapter;
  git?: { committerName?: string };
  /**
   * Extra CLI process starts after a non-critical failure. Default 2.
   * Set 0 to disable restart/resume recovery.
   */
  recoveryAttempts?: number;
  /**
   * Delay in ms before a resume restart, multiplied by the attempt number.
   * Default 250. Set 0 to retry immediately.
   */
  recoveryBackoffMs?: number;
};

export type BayError = {
  /** Human-readable cause after secret redaction. */
  message: string;
  /** True when restarting the process cannot recover (auth, missing CLI, abort). */
  critical: boolean;
};

export type BayEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; callId: string; tool: string; args?: unknown }
  | {
      kind: "tool_result";
      callId: string;
      tool: string;
      ok: boolean;
      result?: unknown;
    }
  | { kind: "tokens"; input?: number; output?: number; total?: number }
  | { kind: "diagnostic"; stream: "stdout" | "stderr"; text: string }
  | { kind: "error"; message: string; critical: boolean }
  | { kind: "turn"; reason: string; sessionId?: string; messageId?: string }
  | { kind: "session"; phase: "created" | "idle"; sessionId: string }
  | {
      kind: "exit";
      code: number;
      reason?: ExitReason;
      sessionId?: string;
      error?: BayError;
    };

export type DoctorReport = {
  ok: boolean;
  engine: EngineId;
  cli: { found: boolean; command: string; version?: string };
  auth: { found: boolean; detail: string };
  message: string;
};

export interface Bay {
  readonly engine: EngineId;
  readonly workDir: string;
  readonly workspace: PreparedWorkspace;
  /** Latest session id observed on this bay, if the engine emitted one. */
  readonly sessionId: string | undefined;
  run(prompt: string, opts?: RunOptions): AsyncIterable<BayEvent>;
  /** Replace extraEnv (and rewrite isolated gitconfig if a token is present). */
  updateExtraEnv(
    extraEnv: Record<string, string>,
    git?: { committerName?: string },
  ): Promise<void>;
  /** Kill a running child if any; keep isolation dirs. */
  abort(): Promise<void>;
  /**
   * Remove enginebay-owned temp dirs. Deletes `workDir` only when it is
   * ephemeral (no `workDir` / `workspaceId` was passed to `openBay`).
   */
  close(): Promise<void>;
}

export function isEngineId(value: string): value is EngineId {
  return (ENGINE_IDS as readonly string[]).includes(value);
}
