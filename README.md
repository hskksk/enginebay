# enginebay

Isolated **bays** for coding-agent CLIs.

enginebay runs a host-installed coding agent (OpenCode, Claude Code, and later Cursor Agent / Gemini CLI) as a library: one process, one workspace, one MCP injection, a canonical event stream. It keeps the engine's **config and session records** out of the user's ordinary install, and **inherits only provider login** from the host.

It is not a product, a session loop, or a sandbox OS. Host applications — Comitia, eval harnesses, other adapters — stay thin.

**Status:** OpenCode and **Claude Code** drivers are implemented (`openBay`, `doctor`, `env` isolation). See [docs/design.md](docs/design.md).

## Why

Each coding CLI stores config, transcripts, and auth in a different place (`~/.claude`, `~/.config/opencode`, XDG, Keychain). Wrapping that knowledge inside every product duplicates the same bugs: polluted `~/.config`, leaked host `GH_TOKEN`, missing login after `HOME` remap, ad-hoc stdout parsers.

enginebay owns that knowledge. A consumer owns *when* to run, *which* prompt, *which* tools, and *what* to do with events.

## What it does

| Concern | enginebay | Consumer (e.g. Comitia) |
| --- | --- | --- |
| Spawn the CLI headless | yes | — |
| Isolate config / session DB | yes | — |
| Inherit provider auth from the host | yes | host login (`opencode auth`, `claude login`) |
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
  workspaceId: "comitia-mika",
  mcp: {
    command: process.execPath,
    args: ["/path/to/mcp-proxy"],
    env: { BOARD_URL: "http://127.0.0.1:8787" },
  },
  instructions: "You are a participant on a consensus board. Tools are the only output that counts.",
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

Do not pass both. IDs are a single path segment, NFC, lowercased; unicode is allowed (`comitia-ミカ`). Isolation dirs (engine config / session DB) stay disposable either way — a named workspace is the **coding tree**, not the engine's XDG.

## Engines

v1 implements OpenCode and Claude Code. Later engines wait until a consumer needs them.

| ID | CLI | Notes |
| --- | --- | --- |
| `opencode` | `opencode` | MCP via `OPENCODE_CONFIG_CONTENT`. Auth under `~/.local/share/opencode`. |
| `claude-code` | `claude` | MCP via `--mcp-config --strict-mcp-config`. Auth via host `claude login` / Keychain. |
| `cursor-agent` | later | |
| `gemini` | later | |

The CLI must already be on `PATH`. enginebay does not vendor engine binaries.

## Isolation (v1: `env`)

Default backend remaps XDG (and engine-specific flags such as `OPENCODE_DISABLE_GLOBAL_CONFIG`) to a disposable directory, so host `~/.config/opencode` and `~/AGENTS.md` are neither read nor written. Provider auth is reattached from the host by a **narrow, engine-specific path** (symlink or kept `HOME` for Keychain) — not by exposing the whole home directory.

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

`main` へのマージごとに [semantic-release](https://semantic-release.gitbook.io/) が Conventional Commits に従ってバージョンを上げ、GitHub Release を作成し、npm に公開します（[Release workflow](.github/workflows/publish.yml)）。

| PR / コミット prefix | バージョン |
| --- | --- |
| `fix:` | patch（例 `0.1.0` → `0.1.1`） |
| `feat:` | minor（例 `0.1.0` → `0.2.0`） |
| `BREAKING CHANGE:` または `feat!:` | major |
| その他（`chore:` `docs:` `ci:` など） | patch |

**Squash merge 推奨** — マージ後のコミットメッセージが PR タイトルになるため、PR タイトルを `feat: …` / `fix: …` 形式にしてください。

セットアップ（初回のみ）:

1. npm の [Granular Access Token](https://docs.npmjs.com/creating-and-viewing-access-tokens)（Publish 権限）を GitHub リポジトリ secret **`NPM_TOKEN`** に登録
2. PR を `main` にマージ → Release workflow が走り、`enginebay` が https://www.npmjs.com/package/enginebay に公開される

リリース対象のコミットがない場合（例: 直前の `[skip ci]` リリースコミットのみ）はスキップされます。手動実行は Actions → Release → Run workflow から可能です。

## Repository

This is [hskksk/enginebay](https://github.com/hskksk/enginebay). The npm name is the unscoped **`enginebay`**, not `@comitia/enginebay`. It was extracted from the Comitia monorepo (`packages/enginebay`).

Comitia still vendors a copy until it depends on this repository (or a published package) instead of `workspace:*`.

## Documentation

- [Design](docs/design.md) — goals, API, isolation, events, consumers, extraction.

## License

UNLICENSED. An OSS license will be chosen separately; this extraction does not pick one.
