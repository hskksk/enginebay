# enginebay

Isolated **bays** for coding-agent CLIs.

enginebay runs a host-installed coding agent (OpenCode, Claude Code, Cursor Agent, and later Gemini CLI) as a library: one process, one workspace, one MCP injection, a canonical event stream. It keeps the engine's **config and session records** out of the user's ordinary install, and **inherits only provider login** from the host.

It is not a product, a session loop, or a sandbox OS. Host applications — orchestrators, eval harnesses, adapters — stay thin.

**Status:** OpenCode, **Claude Code**, and **Cursor Agent** drivers are implemented (`openBay`, `doctor`, `env` isolation). See [docs/design.md](docs/design.md).

## Why

Each coding CLI stores config, transcripts, and auth in a different place (`~/.claude`, `~/.config/opencode`, `~/.cursor`, XDG, Keychain). Wrapping that knowledge inside every product duplicates the same bugs: polluted `~/.config`, leaked host `GH_TOKEN`, missing login after `HOME` remap, ad-hoc stdout parsers.

enginebay owns that knowledge. A consumer owns *when* to run, *which* prompt, *which* tools, and *what* to do with events.

## What it does

| Concern | enginebay | Consumer |
| --- | --- | --- |
| Spawn the CLI headless | yes | — |
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

## Workspaces

`openBay` always has a cwd. How it is created:

| Call | Location | `close()` |
| --- | --- | --- |
| neither `workDir` nor `workspaceId` | temp (`enginebay-work-*`) | deletes it |
| `workspaceId: "…"` | `$XDG_DATA_HOME/enginebay/workspaces/<id>` (default `~/.local/share/…`) | keeps it |
| `workDir: "/path"` | that path (mkdir if needed) | keeps it |

Do not pass both. IDs are a single path segment, NFC, lowercased; unicode is allowed (`my-app-ミカ`). Isolation dirs (engine config / session DB) stay disposable either way — a named workspace is the **coding tree**, not the engine's XDG.

## Engines

v1 implements OpenCode, Claude Code, and Cursor Agent. Later engines wait until a consumer needs them.

| ID | CLI | Notes |
| --- | --- | --- |
| `opencode` | `opencode` | MCP via `OPENCODE_CONFIG_CONTENT`. Auth under `~/.local/share/opencode`. |
| `claude-code` | `claude` | MCP via `--mcp-config --strict-mcp-config`. Auth via host `claude login` / Keychain. |
| `cursor-agent` | `cursor-agent` (`agent`) | MCP via isolated `CURSOR_CONFIG_DIR/mcp.json` + `--approve-mcps`. Auth via `CURSOR_API_KEY` or host `agent login`. |
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

### Troubleshooting: `E403 OIDC permission denied for this action`

This 403 happens when CI calls `npm publish` but Trusted publishing only allows **`npm stage publish`**. This repo uses `npm stage publish` via `@semantic-release/exec`.

If it is still 403:

1. Confirm the npm Trusted publishing org/repo/workflow filename match exactly
2. Confirm **Allowed actions** has `npm stage publish` on and **Save changes** was clicked
3. If you set an Environment name on npm, add `environment:` to the workflow or clear it on npm
4. In `publish.yml`, **do not set `registry-url` on `actions/setup-node`** when using semantic-release

If there is no releasable commit (for example only the previous `[skip ci]` release commit), the workflow skips. You can run it manually from Actions → Release → Run workflow.

## Repository

Standalone npm package: unscoped name **`enginebay`**, repository [hskksk/enginebay](https://github.com/hskksk/enginebay).

## Documentation

- [Design](docs/design.md) — goals, API, isolation, events, consumers.

## License

UNLICENSED. An OSS license will be chosen separately.
