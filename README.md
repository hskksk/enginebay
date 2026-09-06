# enginebay

Isolated **bays** for coding-agent CLIs.

enginebay runs a host-installed coding agent (OpenCode, Claude Code, Cursor Agent, and Codex) as a library or an interactive CLI: one process, one workspace, one MCP injection, and (for headless bays) a canonical event stream. It keeps the engine's **config and session records** out of the user's ordinary install, and **inherits only provider login** from the host.

It is not a product, a session loop, or a sandbox OS. Host applications — orchestrators, eval harnesses, adapters — stay thin.

**Status:** Interactive launch supports **OpenCode, Claude Code, Cursor Agent,
and Codex**. The canonical headless API (`openBay`, `doctor`, `BayEvent`)
supports OpenCode, Claude Code, and Cursor Agent. See
[docs/design.md](docs/design.md).

## Why

Each coding CLI stores config, transcripts, and auth in a different place (`~/.claude`, `~/.config/opencode`, `~/.cursor`, XDG, Keychain). Wrapping that knowledge inside every product duplicates the same bugs: polluted `~/.config`, leaked host `GH_TOKEN`, missing login after `HOME` remap, ad-hoc stdout parsers.

enginebay owns that knowledge. A consumer owns *when* to run, *which* prompt, *which* tools, and *what* to do with events.

## What it does

| Concern | enginebay | Consumer |
| --- | --- | --- |
| Spawn the CLI headless | yes | — |
| Launch the native interactive CLI | yes | choose enginebay options and native argv |
| Isolate config / session DB | yes | — |
| Inherit provider auth from the host | yes | host login (`opencode auth`, `claude login`, `agent login`) |
| Inject session-scoped MCP | yes | provide the stdio command |
| Canonical events (text, thinking, tools) | yes | map to product traces |
| Workspace directory | ephemeral temp, named XDG, or a path you pass | choose id vs path; clone / destroy policy |
| Day loop, ticks, personality, board | no | yes |
| GitHub App token minting | no | pass a token via `extraEnv` if needed |
| OS sandbox (Seatbelt, landlock, microVM) | not in v1 | optional later backend |

## Intended use

```ts
import { doctor, openBay } from "enginebay";

const check = await doctor("opencode");
if (!check.ok) throw new Error(check.message);

const bay = await openBay({
  engine: "opencode",
  workspaceId: "my-project",
  mcp: {
    command: process.execPath,
    args: ["/path/to/mcp-proxy"],
    env: { API_URL: "http://127.0.0.1:8787" },
  },
  instructions: "Follow the tool protocol. Tool calls are the primary output.",
  extraEnv: {
    // Optional. Host GH_TOKEN is stripped unless you pass one.
    GH_TOKEN: mintedInstallationToken,
  },
});

for await (const event of bay.run("Read the briefing and set today's goals.")) {
  // event.kind: "text" | "thinking" | "tool_call" | "tool_result" | "tokens" | "diagnostic" | "exit"
}

await bay.close();
```

Each `run()` is a **fresh CLI process**. Conversation continuity is the consumer's job (a redrive prompt), not `--continue` inside the engine.

## Interactive CLI

The CLI exposes enginebay's common features consistently across every
interactive engine:

```bash
enginebay opencode \
  --workspace-id my-project \
  --model provider/model \
  --instructions-file ./agent-instructions.md \
  --mcp-command node \
  --mcp-arg /path/to/mcp-proxy \
  --mcp-env API_URL=http://127.0.0.1:8787

enginebay claude --work-dir . --model sonnet -- --verbose
enginebay cursor --workspace-id my-project
enginebay codex --workspace-id my-project -- --search
```

Arguments before `--` configure enginebay; arguments after `--` are forwarded
unchanged to the native CLI. This explicit boundary prevents future vendor
flags from colliding with enginebay options.

Common options:

| Option | Purpose |
| --- | --- |
| `--work-dir <path>` | explicit workspace |
| `--workspace-id <id>` | named persistent workspace |
| `--model <id>` | engine model |
| `--instructions <text>` / `--instructions-file <path>` | session instructions |
| `--mcp-command`, `--mcp-arg`, `--mcp-env`, `--mcp-name` | session-scoped stdio MCP |
| `--env <KEY[=VALUE]>` | copy or set child environment |
| `--git-committer-name <name>` | isolated git identity when a GitHub token is supplied |
| `--isolation env` | isolation backend |

`--env NAME` and `--mcp-env NAME` copy a value from the current environment,
which avoids putting the secret itself in shell history. Host `GH_TOKEN` and
`GITHUB_TOKEN` remain excluded unless explicitly supplied with `--env`.

The child receives terminal input/output directly. Its exit status is returned,
and termination signals are forwarded before disposable config is removed.
Without `--work-dir` or `--workspace-id`, the child uses the current directory.

The equivalent library primitive is:

```ts
import { launchEngine } from "enginebay";

const code = await launchEngine({
  engine: "opencode",
  workspaceId: "my-project",
  model: "provider/model",
  instructions: "Follow the tool protocol.",
  args: ["--verbose"],
  mcp: {
    command: process.execPath,
    args: ["/path/to/mcp-proxy"],
    env: { API_URL: "http://127.0.0.1:8787" },
  },
});
```

The same `launchEngine()` options apply to OpenCode, Claude Code, Cursor Agent,
and Codex. Each driver translates MCP and instructions to its native mechanism
without writing instruction files into the workspace. Cursor Agent has no
system-prompt flag, so interactive instructions become its initial prompt, as
the headless driver similarly prepends them to the run prompt.

## Workspaces

`openBay` always has a cwd. How it is created:

| Call | Location | `close()` |
| --- | --- | --- |
| neither `workDir` nor `workspaceId` | temp (`enginebay-work-*`) | deletes it |
| `workspaceId: "…"` | `$XDG_DATA_HOME/enginebay/workspaces/<id>` (default `~/.local/share/…`) | keeps it |
| `workDir: "/path"` | that path (mkdir if needed) | keeps it |

Do not pass both. IDs are a single path segment, NFC, lowercased; unicode is allowed (`my-app-ミカ`). Isolation dirs (engine config / session DB) stay disposable either way — a named workspace is the **coding tree**, not the engine's XDG.

## Engines

Interactive launching supports OpenCode, Claude Code, Cursor Agent, and Codex.
Canonical headless `BayEvent` streaming currently supports the first three.

| ID | CLI | Notes |
| --- | --- | --- |
| `opencode` | `opencode` | MCP via `OPENCODE_CONFIG_CONTENT`. Auth under `~/.local/share/opencode`. |
| `claude-code` | `claude` | MCP via `--mcp-config --strict-mcp-config`. Auth via host `claude login` / Keychain. |
| `cursor-agent` | `cursor-agent` (`agent`) | MCP via isolated `CURSOR_CONFIG_DIR/mcp.json` + `--approve-mcps`. Auth via `CURSOR_API_KEY` or host `agent login`. |
| `codex` | `codex` | Interactive launch: MCP and instructions via disposable `CODEX_HOME`; host `auth.json` attached. |
| `gemini` | later | |

The CLI must already be on `PATH`. enginebay does not vendor engine binaries.

## Isolation (v1: `env`)

Default backend remaps XDG / `CURSOR_CONFIG_DIR` (and engine-specific flags such as `OPENCODE_DISABLE_GLOBAL_CONFIG`) to a disposable directory, so host `~/.config/opencode`, `~/.cursor/mcp.json`, and `~/AGENTS.md` are neither read nor written. Provider auth is reattached from the host by a **narrow, engine-specific path** (symlink or kept `HOME` for Keychain) — not by exposing the whole home directory.

Host `GH_TOKEN` / `GITHUB_TOKEN` are removed from the child environment unless the consumer puts them in `extraEnv`.

OS-level sandboxes (`jai`, Anthropic `srt`, Docker `sbx`) are **optional backends**, not this package's identity. See [design §6](docs/design.md#6-isolation-backends).

## Install

```bash
npm install enginebay
# or
pnpm add enginebay
```

Requires Node.js 22+.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Live coding CLIs are not required for unit tests.

## Publish

Every merge to `main` runs [semantic-release](https://semantic-release.gitbook.io/), which bumps the version from Conventional Commits, creates a GitHub Release, and **stages the package on npm** ([Release workflow](.github/workflows/publish.yml)). The version stays staged until a maintainer approves it with 2FA.

| PR / commit prefix | Release |
| --- | --- |
| `fix:` | patch (e.g. `0.1.0` → `0.1.1`) |
| `feat:` | minor (e.g. `0.1.0` → `0.2.0`) |
| `BREAKING CHANGE:` or `feat!:` | major |
| Other (`chore:`, `docs:`, `ci:`, …) | patch |

**Squash merge is the norm** — the merged commit message is usually the PR title, so set the PR title to `feat: …` / `fix: …` form.

### CI (stage) → maintainer (approve)

1. The Release workflow runs `npm stage publish` (OIDC / trusted publishing).
2. A maintainer reviews the staged package on npmjs.com or the CLI, then approves:
   - Web: npm → `enginebay` → **Staged packages**
   - CLI: `npm stage list enginebay` → `npm stage approve <stage-id>` (2FA required)

`npm stage approve` / `reject` cannot use OIDC. Run them from a local CLI or npmjs.com with 2FA.

Auth uses [npm trusted publishers](https://docs.npmjs.com/trusted-publishers) (GitHub Actions OIDC). Provenance is attached at stage time as well (public repo / public package).

## Repository

Standalone npm package: unscoped name **`enginebay`**, repository [hskksk/enginebay](https://github.com/hskksk/enginebay).

## Documentation

- [Design](docs/design.md) — goals, API, isolation, events, consumers.

## License

UNLICENSED. An OSS license will be chosen separately.
