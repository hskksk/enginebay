# enginebay design

Isolated bays for coding-agent CLIs. This document is the design of record for the package.

Status: **OpenCode, Claude Code, Cursor Agent, and Codex interactive launch
implemented. OpenCode, Claude Code, and Cursor Agent also implement canonical
headless bays.**

## 1. Problem

Products that drive coding agents (a consensus board, an eval harness, a local orchestrator) keep re-implementing the same layer:

1. Spawn OpenCode / Claude Code / another CLI headless.
2. Inject MCP for this session only.
3. Keep the user's global config, hooks, and `AGENTS.md` out of the run.
4. Keep transcripts and engine SQLite files out of the user's install.
5. Still use the login the human already did on the host (`claude login`, `opencode auth`, …).
6. Parse a vendor-specific stdout stream into something the product can log.

That layer is **engine knowledge**, not product knowledge. It is also not an OS sandbox: Seatbelt, landlock, bubblewrap, and microVMs constrain a process; they do not know where OpenCode stores `auth.json`.

Prior art in other repositories inlined the same logic for Claude Code and OpenCode. Those call sites should depend on this library instead.

## 2. Goals

1. **One bay, one engine process.** `openBay` + `run(prompt)` is enough to drive a headless CLI.
2. **Config and session records are disposable** unless the consumer opts into a persistent work dir. Closing the bay deletes enginebay-owned temp dirs (isolation plus an ephemeral workspace). Named / explicit workspaces survive `close()`.
3. **Provider auth is inherited, narrowly.** The child can call the model. It cannot see the rest of the user's dotfiles by default.
4. **MCP is session-scoped.** The consumer passes a stdio command; enginebay injects it with the engine's native mechanism. Nothing is written into the user's global MCP config.
5. **Events are canonical.** Consumers do not parse `stream-json` or `opencode run --format json` themselves.
6. **The library is a standalone primitive.** Unscoped package name `enginebay`, no product-specific imports or types in the public API.
7. **Live engines are not required for unit tests.** Argv, env, and parsers are tested with fixtures. Spawning a real CLI is optional / manual.
8. **Interactive use is a first-class entry point.** `enginebay <engine>
   [enginebay options] -- [native options]` exposes the common workspace, model,
   instructions, MCP, environment, git, auth, and isolation layer while
   preserving the native terminal.

## 3. Non-goals

| Out | Why |
| --- | --- |
| Session loop, idle detection, redrive prompts | Product |
| Board MCP semantics, ticks, A2A | Product |
| Personality, roles, briefing text | Product |
| Eval cells, judges, playgrounds | Eval harness (consumer) |
| Minting GitHub App installation tokens | Consumer; pass the token in |
| Vendoring `opencode` / `claude` binaries | CLI on `PATH` |
| Being a general OS sandbox | `srt`, `jai`, Docker `sbx` already exist; they may become *backends* |
| Implementing Gemini / Antigravity in this slice | Catalog entries wait until a consumer needs them |
| `opencode serve` / long-lived attach | Each `run()` is a new process |

## 4. Concepts

```
consumer (orchestrator, eval runner, adapter, …)
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
export type EngineId = "opencode" | "claude-code" | "cursor-agent";

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

export type LaunchEngineId =
  | "codex"
  | "opencode"
  | "claude-code"
  | "cursor-agent";

export function launchEngine(options: {
  engine: LaunchEngineId;
  args?: string[];        // forwarded to the native CLI
  workDir?: string;       // defaults to process.cwd()
  workspaceId?: string;
  isolation?: { kind: IsolationKind };
  mcp?: McpStdio;
  instructions?: string;
  model?: string;
  extraEnv?: Record<string, string>;
  git?: { committerName?: string };
}): Promise<number>;      // native exit status
```

### 5.1 Interactive launcher

The package exposes a `bin` named `enginebay`. Its first positional argument
selects the engine. Arguments before `--` configure enginebay using the same
concepts as `OpenBayOptions`; arguments after `--` belong to the native CLI.
The mandatory boundary avoids collisions as vendor CLIs add flags.

`launchEngine()` uses inherited stdio rather than parsing output. It installs
temporary engine config, forwards termination signals, returns the child exit
status, and removes temporary state after the child exits. The current
headless-only event contract remains unchanged; Codex does not become an
`openBay()` engine until a canonical Codex event parser is implemented.

CLI mappings:

| enginebay option | `launchEngine()` |
| --- | --- |
| `--work-dir`, `--workspace-id` | `workDir`, `workspaceId` |
| `--model` | `model` |
| `--instructions`, `--instructions-file` | inline `instructions` |
| `--mcp-command`, repeatable `--mcp-arg` / `--mcp-env`, `--mcp-name` | `mcp` |
| repeatable `--env` | `extraEnv` |
| `--git-committer-name` | `git.committerName` |
| `--isolation env` | `isolation.kind` |

### 5.2 Consumer adapter pattern

Most host applications already have a session or plugin interface (`start` / `run` / `stop` / `dispose`, or similar). The adapter should stay thin:

| Typical adapter hook | enginebay |
| --- | --- |
| start session | `openBay({ workspaceId or workDir, mcp, instructions, extraEnv })` |
| run turn | iterate `bay.run(prompt)`, map `BayEvent` → product trace events |
| usage / billing | last `tokens` event |
| cancel | `abort()` |
| teardown | `close()` |
| refresh GitHub auth | `bay.updateExtraEnv(extraEnv, git?)` |

The consumer owns GitHub minting, scheduling loops, and prompt text. Those strings are passed in as `instructions`; enginebay does not import them.

### 5.3 Eval harness integration

Eval runners keep playgrounds, criteria, and collectors. They replace bespoke argv/env builders and stdout adapters with `openBay({ engine: "opencode", workDir: playground })` or a named `workspaceId`. Isolation must remain equivalent: no host `~/.config/opencode`, per-run session DB, host auth still visible.

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
- Auth: attach host `~/.local/share/opencode` (`auth.json` / `auth-v2.json`) without pointing `XDG_DATA_HOME` at an empty temp that hides login. Prefer a dedicated data dir plus a symlink of the auth files.
- argv: `opencode run --format json --dangerously-skip-permissions --dir <workDir> [--model <id>] <prompt>`
- Do not use the older PoC flag `--auto`.

**Claude Code** (second driver)

- Keep real `HOME` so Keychain / `claude login` still work. Do not use `--bare`.
- `--mcp-config <file> --strict-mcp-config --setting-sources project,local`
- `--permission-mode bypassPermissions --output-format stream-json`
- `--append-system-prompt` for `instructions`
- Git isolation via `GIT_CONFIG_GLOBAL`, not a fake `HOME`.
- Do not pass `CLAUDE_CONFIG_DIR` (macOS Keychain namespaces on that path).

**Cursor Agent**

- Keep real `HOME` so Keychain / `agent login` still work.
- `CURSOR_CONFIG_DIR` → a disposable runtime dir (host `~/.cursor/mcp.json` and `cli-config.json` are neither read nor written).
- Write session-scoped `mcp.json` and an unrestricted `cli-config.json` into that dir.
- Auth: symlink host `~/.cursor/auth.json` into the isolated config dir when present. `CURSOR_API_KEY` in the host env (or `extraEnv`) passes through.
- argv: `cursor-agent -p --force --trust --approve-mcps --sandbox disabled --output-format stream-json --workspace <workDir> [--model <id>] <prompt>`
- Prefer the unambiguous `cursor-agent` binary; fall back to `agent` when that is what is on `PATH`.
- The CLI has no `--append-system-prompt`. enginebay prepends `instructions` to the prompt. Do not write `AGENTS.md` into `workDir`.
- Do not pass `--continue` / `--resume`. Each `run()` is a new process.

For interactive launch, OpenCode, Claude Code, and Cursor Agent reuse these
same config, auth, MCP, environment, and git-isolation mechanisms. Native argv
is inherited after `--`; enginebay adds model and engine-specific MCP /
instruction settings. Cursor has no system-prompt flag, so its interactive
instructions become the initial prompt.

**Codex (interactive launcher)**

- Set `CODEX_HOME` to a disposable directory containing an enginebay-owned
  `config.toml`.
- Attach only host `~/.codex/auth.json`; do not copy host config, sessions,
  history, or rollout logs.
- Write an optional stdio server under `[mcp_servers.<name>]`.
- Write inline instructions as `developer_instructions`.
- Keep the real `HOME` for platform credential stores while isolating Codex's
  own state through `CODEX_HOME`.
- Preserve native argv after enginebay's model override. The interactive
  launcher does not force an approval or sandbox policy; callers may select
  those through Codex flags after `--`.

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

Consumers typically derive `workspaceId` from their own config key (for example `my-app-{agent-name}`) or pass an explicit `workDir` when they manage the tree directly.

## 7. Credentials

### 7.1 Provider login (inherit)

| Engine | Host source | Attach method |
| --- | --- | --- |
| OpenCode | `~/.local/share/opencode/auth.json` (and `auth-v2.json`) | symlink or bind into the isolated data dir |
| Claude Code | Keychain and/or `~/.claude` credentials | keep host `HOME`; narrow credential attach only |
| Cursor Agent | `CURSOR_API_KEY` and/or `~/.cursor/auth.json` (Keychain on macOS) | keep host `HOME`; symlink `auth.json` into isolated `CURSOR_CONFIG_DIR` |

If attach fails, `openBay` still succeeds (the CLI may error on first `run()`). `doctor()` reports the miss in English so UIs can tell the human to log in.

API keys already in the host environment (`ANTHROPIC_API_KEY`, …) pass through unless a future denylist says otherwise. Document the pass-through list per engine.

### 7.2 GitHub (do not inherit by default)

Host `GH_TOKEN` / `GITHUB_TOKEN` are **stripped**. The consumer mints a short-lived installation token (or similar) and passes it in `extraEnv`. enginebay may write an isolated `.gitconfig` into the runtime dir when those variables are present (HTTPS `insteadOf`, committer name via options if we add `git?: { committerName }`).

enginebay never logs token values. Parsers redact `ghs_`, `github_pat_`, and `Bearer` in event payloads.

### 7.3 What must not leak

- User global MCP, hooks, plugins, `~/AGENTS.md`
- Host git credentials (`gh auth`, `~/.git-credentials`, SSH keys) unless a later opt-in exists
- enginebay runtime dirs after `close()`

## 8. MCP injection

The consumer supplies stdio `{ command, args, env }`. enginebay never puts service URLs or agent tokens into a user-global file.

| Engine | Mechanism |
| --- | --- |
| OpenCode | `OPENCODE_CONFIG_CONTENT` → `mcp.<name> = { type: "local", command: [command, ...args], enabled: true, environment }` |
| Claude Code | temp `mcp-config.json` + `--mcp-config` + `--strict-mcp-config` |
| Cursor Agent | isolated `CURSOR_CONFIG_DIR/mcp.json` + `--approve-mcps` (no `--mcp-config` flag) |

Default server name is `enginebay` so products are not hardcoded. Consumers may pass a custom `name` (for example `board-mcp`) to control tool-name prefixes. Parsers strip known MCP prefixes (`mcp__[^_]+__`) when emitting `tool`.

## 9. Instructions

Some engines take a CLI flag (`claude --append-system-prompt`). OpenCode `instructions` is a **list of file paths**. Cursor Agent has no instruction flag; enginebay prepends the inline string to the prompt. The public option is always an inline string. enginebay writes `instructions.md` under the runtime dir when the engine only accepts paths. The file is deleted on `close()`.

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

No `run_start` / `continue_decision`: those are consumer session-loop events. The consumer maps `BayEvent` → its own trace model and adds adapter kinds itself.

OpenCode v1 parser reads `opencode run --format json` NDJSON (`text`, `reasoning`, `tool_use`, `step_finish`). It does **not** require the eval collector plugin or `opencode export`. If stdout is too thin for thinking/tools, a later slice may add export as a fallback — not in v1.

Claude parser reads `claude --output-format stream-json` (`assistant` thinking/text/`tool_use`, `user` `tool_result`). Remaining-budget and other product-specific fields stay on the consumer side.

Cursor parser reads `cursor-agent -p --output-format stream-json` (`assistant` text, `tool_call` started/completed, error `result`). Thinking is usually suppressed in print mode. The concatenated terminal `result` is skipped so assistant text is not doubled.

## 11. Engine catalog

Implemented drivers:

1. **Types + `env` isolation helpers + `doctor`**
2. **OpenCode driver** — argv, config JSON, auth attach, JSON parser, fixture tests
3. **Claude Code driver** — argv, MCP config, stream-json parser, fixture tests
4. **Cursor Agent driver** — argv, isolated `CURSOR_CONFIG_DIR` MCP, auth attach, stream-json parser, fixture tests
5. **Interactive launcher** — Codex plus the three headless engines, inherited
   terminal, native argv/exit status, signal forwarding, disposable config

Future: **Gemini** when a consumer needs it.

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
| npm name | `enginebay` (unscoped) |
| Repository | [hskksk/enginebay](https://github.com/hskksk/enginebay) |
| Language | TypeScript strict, NodeNext |
| Dependencies | Node stdlib first. No product-specific scoped packages. |
| Engines field | Node 22+ (LTS) |
| License | UNLICENSED until an OSS license is chosen |

`build` / `test` / `typecheck` run `tsc` and Vitest.

Publishing runs on merge to `main` via semantic-release → `npm stage publish` (OIDC, `.github/workflows/publish.yml`); a maintainer approves on npm before the version goes live. See [README § Publish](../README.md#publish).

## 14. Security notes

- Isolation in v1 is **cooperative**. A CLI that ignores XDG can still read `$HOME`. Stronger backends (§6.2) are how we raise that bar.
- `env` isolation is still enough for the core rule: “do not leave MCP or session files in the user's standard install.”
- Tokens in `extraEnv` must not appear in `BayEvent` payloads or thrown `Error` messages.
- `workDir` is trusted by the consumer. enginebay does not try to prevent the model from editing that tree.

## 15. Open questions

Closed for v1 OpenCode:

1. **Default model** — omit `--model` when `options.model` is unset; the engine default applies.
2. **`git.committerName`** — optional on `OpenBayOptions`. Isolated `.gitconfig` is written when `extraEnv` has a GitHub token. Email is `enginebay@users.noreply.github.com`.
3. **Auth attach on Windows** — v1 is POSIX-first (`~/.local/share/opencode`).
4. **Event versioning** — no `v` field on `BayEvent` until a second parser exists.
5. **License** — UNLICENSED until an OSS license is chosen.

## 16. References

- [prism-data-labs-agent](https://github.com/hskksk/prism-data-labs-agent) — prior OpenCode eval isolation (to be replaced by this package)
- Isolation catalog (context, not dependencies): [wincent gist, 2026-05](https://gist.github.com/wincent/2752d8d97727577050c043e4ff9e386e)
