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
  /** Merged last. Use for minted GH_TOKEN, model overrides, etc. */
  extraEnv?: Record<string, string>;
  /** Override host process.env / homedir in tests. */
  hostEnv?: NodeJS.ProcessEnv;
  hostHome?: string;
  model?: string;
  git?: { committerName?: string };
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
  | { kind: "exit"; code: number };

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
  run(prompt: string): AsyncIterable<BayEvent>;
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
