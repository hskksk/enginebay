# enginebay design

Isolated bays for coding-agent CLIs. This document is the design of record for the package. Implementation follows it; Comitia product docs do not override it.

Status: **OpenCode and Claude Code implemented.**

## 1. Problem

Products that drive coding agents (a consensus board, an eval harness, a local orchestrator) keep re-implementing the same layer:

1. Spawn OpenCode / Claude Code / another CLI headless.
2. Inject MCP for this session only.
3. Keep the user's global config, hooks, and `AGENTS.md` out of the run.
4. Keep transcripts and engine SQLite files out of the user's install.
5. Still use the login the human already did on the host (`claude login`, `opencode auth`, …).
6. Parse a vendor-specific stdout stream into something the product can log.

That layer is **engine knowledge**, not product knowledge. It is also not an OS sandbox: Seatbelt, landlock, bubblewrap, and microVMs constrain a process; they do not know where OpenCode stores `auth.json`.

Comitia currently inlines this for Claude Code (`packages/agent/src/plugins/claude-code.ts`). [prism-data-labs-agent](https://github.com/hskksk/prism-data-labs-agent) inlines a more complete OpenCode isolation story under `eval/`. Both should call one library.

## 2. Goals

1. **One bay, one engine process.** `openBay` + `run(prompt)` is enough to drive a headless CLI.
2. **Config and session records are disposable** unless the consumer opts into a persistent work dir. Closing the bay deletes enginebay-owned temp dirs (isolation plus an ephemeral workspace). Named / explicit workspaces survive `close()`.
3. **Provider auth is inherited, narrowly.** The child can call the model. It cannot see the rest of the user's dotfiles by default.
4. **MCP is session-scoped.** The consumer passes a stdio command; enginebay injects it with the engine's native mechanism. Nothing is written into the user's global MCP config.
5. **Events are canonical.** Consumers do not parse `stream-json` or `opencode run --format json` themselves.
6. **The library stays extractable.** Unscoped package name `enginebay`, no imports from `@comitia/*`, no Comitia types in the public API.
7. **Live engines are not required for unit tests.** Argv, env, and parsers are tested with fixtures. Spawning a real CLI is optional / manual.

## 3. Non-goals

| Out | Why |
| --- | --- |
| Session loop, idle detection, redrive prompts | Product (Comitia design 02 §7) |
| Board MCP semantics, ticks, A2A | Product |
| Personality, roles, briefing text | Product |
| Eval cells, judges, playgrounds | prism-data-labs-agent |
| Minting GitHub App installation tokens | Comitia design 08; pass the token in |
| Vendoring `opencode` / `claude` binaries | Same policy as Comitia today: CLI on `PATH` |
| Being a general OS sandbox | `srt`, `jai`, Docker `sbx` already exist; they may become *backends* |
| Implementing Cursor Agent / Antigravity / Gemini in the first slice | Catalog entries wait until a consumer needs them |
| `opencode serve` / long-lived attach | Each `run()` is a new process, matching Comitia's Claude plugin |

## 4. Concepts

```
consumer (Comitia adapter, eval runner, …)
    │  prompt, workspace (id | path | ephemeral), MCP stdio, extraEnv
    ▼
enginebay bay
    │  isolation env + auth attach + MCP inject
    ▼
coding CLI (opencode | claude | …)
    │  NDJSON / stream-json
    ▼
canonical BayEvent stream
```

**Bay.** A prepared environment for one engine and one workspace. Owns temp dirs for config and session data. Multiple `run()` calls may reuse the bay (same isolation, same MCP). Each `run()` still spawns a new CLI process.

**Engine.** A driver: argv, env, MCP injection, auth attach, stdout parser. Identified by a stable string (`opencode`, `claude-code`, …).

**Isolation backend.** How the child is fenced from the host install. v1 is `env` (environment variables and temp dirs). Later backends may wrap the same driver in `jai` or `srt`.

**Auth attach.** Engine-specific, allowlisted paths or env (Keychain, `auth.json`). Not “the whole `$HOME`”.

## 5. Public API (sketch)

Names may move slightly in implementation; the shapes should not.

```ts
export type EngineId = "opencode" | "claude-code"; // v1: opencode first

export type IsolationKind = "env"; // later: "jai" | "srt"

export type McpStdio = {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** MCP server name inside the engine. Default: "enginebay". */
  name?: string;
};

export type OpenBayOptions = {
  engine: EngineId;
  workDir?: string;       // explicit path; close() does not delete
  workspaceId?: string;   // named XDG workspace; close() does not delete
  // neither → ephemeral temp; close() deletes
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
  | { kind: "tool_result"; callId: string; tool: string; ok: boolean; result?: unknown }
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
  updateExtraEnv(extraEnv: Record<string, string>, git?: { committerName?: string }): Promise<void>;
  abort(): Promise<void>;
  /** Remove isolation temps. Deletes workDir only when it is ephemeral. */
  close(): Promise<void>;
}

export function prepareWorkspace(input?: {
  id?: string;
  path?: string;
  hostEnv?: NodeJS.ProcessEnv;
  hostHome?: string;
}): Promise<PreparedWorkspace>;

export function openBay(options: OpenBayOptions): Promise<Bay>;
export function doctor(engine: EngineId, host?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
}): Promise<DoctorReport>;
```

### 5.1 Mapping to Comitia `EnginePlugin`

Comitia keeps `EnginePlugin` (`start` / `run` / `report` / `stop` / `dispose`). The plugin becomes a thin wrapper:

| `EnginePlugin` | enginebay |
| --- | --- |
| `start(session)` | `openBay({ workspaceId or workDir, mcp, instructions, extraEnv })` |
| `run(prompt)` | iterate `bay.run(prompt)`, map `BayEvent` → `TraceEvent` |
| `report()` | last `tokens` event |
| `stop()` | `abort()` |
| `dispose()` | `close()` |
| `updateGithubAuth` | `bay.updateExtraEnv(extraEnv, git?)` |

Comitia continues to own GitHub minting, the day loop, and prompt constants (`TOOLSET_OVERVIEW`, environment prompt). Those strings are passed in as `instructions`; enginebay does not import them.

### 5.2 Mapping to prism eval

Eval keeps playgrounds, criteria, and collectors. It replaces `buildOpencodeRunArgs` / `buildEvalCliEnv` / stdout adapters with `openBay({ engine: "opencode", workDir: playground })` or a named `workspaceId`. Isolation must remain equivalent: no host `~/.config/opencode`, per-run session DB, host auth still visible.

## 6. Isolation backends

### 6.1 `env` (v1, required)

No extra binaries. The child is a normal process with a rewritten environment.

Shared rules:

- Create a temp **runtime dir** (config, instructions file, MCP file if needed).
- Create a temp **data dir** for session records (XDG data/state/cache as required).
- Do not write into the consumer's `workDir` except as the engine's cwd (no `AGENTS.md` dropped into a user repo).
- Strip `GH_TOKEN` and `GITHUB_TOKEN` from the inherited env, then apply `extraEnv`.
- Set `GIT_TERMINAL_PROMPT=0`. If the consumer passes a git token in `extraEnv`, also isolate git config (see §7.2).
- On `close()`, delete runtime and data dirs. Delete `workDir` only if it was ephemeral. Never delete a named or explicit workspace.

**OpenCode**

- `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` → runtime/data temps.
- `OPENCODE_DISABLE_GLOBAL_CONFIG=1`
- `OPENCODE_DISABLE_CLAUDE_CODE=1` (do not pick up a host Claude integration).
- `OPENCODE_CONFIG_CONTENT` = JSON with `mcp` and `instructions` (path to the temp markdown).
- Auth: attach host `~/.local/share/opencode` (`auth.json` / `auth-v2.json`) without pointing `XDG_DATA_HOME` at an empty temp that hides login. Prefer a dedicated data dir plus a symlink of the auth files, as in prism `eval/util/eval-cli-env.ts`.
- argv: `opencode run --format json --dangerously-skip-permissions --dir <workDir> [--model <id>] <prompt>`
- Do not use the older PoC flag `--auto`.

**Claude Code** (second driver; behavior already proven in Comitia)

- Keep real `HOME` so Keychain / `claude login` still work. Do not use `--bare`.
- `--mcp-config <file> --strict-mcp-config --setting-sources project,local`
- `--permission-mode bypassPermissions --output-format stream-json`
- `--append-system-prompt` for `instructions`
- Git isolation via `GIT_CONFIG_GLOBAL`, not a fake `HOME`.
- Do not pass `CLAUDE_CONFIG_DIR` (macOS Keychain namespaces on that path).

### 6.2 Later backends (not v1)

`jai` (copy-on-write / empty home) and Anthropic `srt` (Seatbelt / bubblewrap) can wrap the same argv. They are isolation *backends*, selected by `isolation.kind`. enginebay still owns auth-attach allowlists; the backend must be configured to grant those paths and deny the rest of `$HOME`.

Docker Sandboxes (`sbx`) is a **launcher**, not a backend we embed. Supporting it would mean the consumer calls `sbx` instead of enginebay, or enginebay grows a third backend that shells out to `sbx`. Out of scope until a consumer asks.

### 6.3 Workspaces

A **workspace** is the engine cwd (the tree the model edits). It is not the isolation dir.

| Kind | When | Path | `close()` |
| --- | --- | --- | --- |
| Ephemeral | no `workDir`, no `workspaceId` | `mkdtemp(enginebay-work-)` | delete |
| Named | `workspaceId` | `$XDG_DATA_HOME/enginebay/workspaces/<id>` | keep |
| Explicit | `workDir` | that path (created if missing) | keep |

`XDG_DATA_HOME` defaults to `~/.local/share`. This is **data**, not cache or state: a git clone between days is user data. Isolation config/session DB stays in throwaway runtime dirs so a named workspace is not polluted with OpenCode SQLite.

IDs: one path segment, NFC, lowercased, max 80 characters. Unicode allowed. `/`, `\`, `.`, `..`, and control characters are rejected.

Do not pass `workDir` and `workspaceId` together. `prepareWorkspace()` is the same helper `openBay` uses, for consumers that need the path before spawn (clone, then `openBay({ workDir })`).

Comitia default: `workspaceId = comitia-{agent-name}` (config key, engine-independent). `COMITIA_WORK_DIR` remains an explicit-path override.

## 7. Credentials

### 7.1 Provider login (inherit)

| Engine | Host source | Attach method |
| --- | --- | --- |
| OpenCode | `~/.local/share/opencode/auth.json` (and `auth-v2.json`) | symlink or bind into the isolated data dir |
| Claude Code | Keychain and/or `~/.claude` credentials | keep host `HOME`; copy only what Comitia already copies |

If attach fails, `openBay` still succeeds (the CLI may error on first `run()`). `doctor()` reports the miss in English so UIs can tell the human to log in.

API keys already in the host environment (`ANTHROPIC_API_KEY`, …) pass through unless a future denylist says otherwise. Document the pass-through list per engine.

### 7.2 GitHub (do not inherit by default)

Host `GH_TOKEN` / `GITHUB_TOKEN` are **stripped**. Comitia mints a short-lived installation token and passes it in `extraEnv`. enginebay may write an isolated `.gitconfig` into the runtime dir when those variables are present (HTTPS `insteadOf`, committer name via options if we add `git?: { committerName }`).

enginebay never logs token values. Parsers redact `ghs_`, `github_pat_`, and `Bearer` in event payloads (same policy as Comitia `trace-format.ts`).

### 7.3 What must not leak

- User global MCP, hooks, plugins, `~/AGENTS.md`
- Host git credentials (`gh auth`, `~/.git-credentials`, SSH keys) unless a later opt-in exists
- enginebay runtime dirs after `close()`

## 8. MCP injection

The consumer supplies stdio `{ command, args, env }`. enginebay never puts board URLs or agent tokens into a user-global file.

| Engine | Mechanism |
| --- | --- |
| OpenCode | `OPENCODE_CONFIG_CONTENT` → `mcp.<name> = { type: "local", command: [command, ...args], enabled: true, environment }` |
| Claude Code | temp `mcp-config.json` + `--mcp-config` + `--strict-mcp-config` |

Default server name is `enginebay` so products are not hardcoded. Comitia can pass `name: "comitia-board"` to keep existing tool-name prefixes if needed. Parsers strip known MCP prefixes (`mcp__[^_]+__`) when emitting `tool`.

## 9. Instructions

Some engines take a CLI flag (`claude --append-system-prompt`). OpenCode `instructions` is a **list of file paths**. enginebay always accepts an inline string, writes `instructions.md` under the runtime dir, and points the engine at it. The file is deleted on `close()`.

Do not write `AGENTS.md` into `workDir`.

## 10. Canonical events

Vendors keep changing stdout. The public stream is `BayEvent` only.

| `kind` | Meaning |
| --- | --- |
| `text` | Assistant visible text |
| `thinking` | Reasoning / thinking block |
| `tool_call` | Tool start (`callId` correlates) |
| `tool_result` | Tool end |
| `tokens` | Usage if the stream exposes it |
| `diagnostic` | Non-JSON stderr/stdout the parser skipped |
| `exit` | Process exit code, always last |

No `run_start` / `continue_decision`: those are consumer session-loop events (Comitia M20). Comitia maps `BayEvent` → `TraceEvent` and adds adapter kinds itself.

OpenCode v1 parser reads `opencode run --format json` NDJSON (`text`, `reasoning`, `tool_use`, `step_finish`). It does **not** require the eval collector plugin or `opencode export`. If stdout is too thin for thinking/tools, a later slice may add export as a fallback — not in v1.

Claude parser reads `claude --output-format stream-json` (`assistant` thinking/text/`tool_use`, `user` `tool_result`). Comitia maps `BayEvent` → traces and keeps remaining-budget parsing on the product side.

## 11. Engine catalog and slices

Implementation order inside this package:

1. **Types + `env` isolation helpers + `doctor` stubs** (no spawn).
2. **OpenCode driver** — argv, config JSON, auth attach, JSON parser, tests with fixture transcripts.
3. **Claude Code driver** — extract from Comitia plugin; Comitia wrapper shrinks.
4. **Cursor / Gemini** — when prism or Comitia needs them; prism already has launchers to copy.

Comitia product work that *consumes* slice 2: allow `opencode` in `ENGINES`, wire `createEnginePlugin`, doctor, English+Japanese UI labels as required by Comitia. That work stays in `@comitia/agent` / `@comitia/shared`, not here.

## 12. Testing

| Layer | How |
| --- | --- |
| Argv / env / MCP JSON | Unit tests, no CLI |
| Parsers | Checked-in stdout fixtures (sanitize secrets) |
| Isolation | Snapshot that host `~/.config/opencode` is unchanged when a fake binary is spawned |
| Live CLI | Manual / optional; never a required CI gate |

Test doubles: a fake `opencode` on `PATH` that writes stdin/env and prints fixture JSON.

## 13. Packaging

| Item | Choice |
| --- | --- |
| npm name | `enginebay` (unscoped, already unused on the registry as of 2026-09) |
| Repository | [hskksk/enginebay](https://github.com/hskksk/enginebay) |
| Language | TypeScript strict, NodeNext |
| Dependencies | Node stdlib first. No `@comitia/*`. |
| Engines field | Node 22+ (LTS) |
| License | UNLICENSED until an OSS license is chosen |

`build` / `test` / `typecheck` run `tsc` and Vitest.

Extraction checklist:

1. Freeze the public API.
2. Move the directory to `hskksk/enginebay`. **Done** (this repository).
3. Publish `enginebay`. **Done** — `main` マージ時に semantic-release がバージョン bump + npm publish（secret `NPM_TOKEN`）。
4. Comitia depends on the published (or git) package instead of `workspace:*`.
5. prism-data-labs-agent depends on the same package and deletes its duplicated `eval` drivers.

## 14. Security notes

- Isolation in v1 is **cooperative**. A CLI that ignores XDG can still read `$HOME`. Stronger backends (§6.2) are how we raise that bar.
- `env` isolation is still enough for the original product rule: “do not leave MCP or session files in the user's standard install.”
- Tokens in `extraEnv` must not appear in `BayEvent` payloads or thrown `Error` messages.
- `workDir` is trusted by the consumer. enginebay does not try to prevent the model from editing that tree.

## 15. Open questions

Closed for v1 OpenCode:

1. **Default model** — omit `--model` when `options.model` is unset; the engine default applies.
2. **`git.committerName`** — optional on `OpenBayOptions`. Isolated `.gitconfig` is written when `extraEnv` has a GitHub token. Email is `enginebay@users.noreply.github.com`.
3. **Auth attach on Windows** — v1 is POSIX-first (`~/.local/share/opencode`).
4. **Event versioning** — no `v` field on `BayEvent` until a second parser exists.
5. **License** — UNLICENSED until an OSS license is chosen. This extraction does not pick one.

## 16. References

- Comitia adapter SPI: `packages/agent/src/plugins/types.ts`, Claude plugin: `packages/agent/src/plugins/claude-code.ts`
- Comitia engine connection: `docs/design/02-agent-connection.md` §6, tech notes: `docs/design/03-tech-selection.md` §1
- Comitia GitHub credentials: `docs/design/08-agent-github-credentials.md`
- OpenCode PoC: `poc/01-tool-injection/src/run-opencode.ts`
- prism-data-labs-agent: `eval/util/eval-cli-env.ts`, `eval/config/resolve-primary-agent.ts` (`buildOpencodeRunArgs`), `eval/util/session-stream.ts`
- Isolation catalog (context, not dependencies): [wincent gist, 2026-05](https://gist.github.com/wincent/2752d8d97727577050c043e4ff9e386e)
