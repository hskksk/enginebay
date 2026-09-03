# enginebay

Isolated **bays** for coding-agent CLIs.

enginebay runs a host-installed coding agent (OpenCode, Claude Code, and later Cursor Agent / Gemini CLI) as a library: one process, one workspace, one MCP injection, a canonical event stream. It keeps the engine's **config and session records** out of the user's ordinary install, and **inherits only provider login** from the host.

It is not a product, a session loop, or a sandbox OS. Host applications — orchestrators, eval harnesses, adapters — stay thin.

**Status:** OpenCode and **Claude Code** drivers are implemented (`openBay`, `doctor`, `env` isolation). See [docs/design.md](docs/design.md).

## Why

Each coding CLI stores config, transcripts, and auth in a different place (`~/.claude`, `~/.config/opencode`, XDG, Keychain). Wrapping that knowledge inside every product duplicates the same bugs: polluted `~/.config`, leaked host `GH_TOKEN`, missing login after `HOME` remap, ad-hoc stdout parsers.

enginebay owns that knowledge. A consumer owns *when* to run, *which* prompt, *which* tools, and *what* to do with events.

## What it does

| Concern | enginebay | Consumer |
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

`main` へのマージごとに [semantic-release](https://semantic-release.gitbook.io/) が Conventional Commits に従ってバージョンを上げ、GitHub Release を作成し、**npm に stage します**（[Release workflow](.github/workflows/publish.yml)）。registry への反映は maintainer が 2FA で approve するまで待ちます。

| PR / コミット prefix | バージョン |
| --- | --- |
| `fix:` | patch（例 `0.1.0` → `0.1.1`） |
| `feat:` | minor（例 `0.1.0` → `0.2.0`） |
| `BREAKING CHANGE:` または `feat!:` | major |
| その他（`chore:` `docs:` `ci:` など） | patch |

**Squash merge 推奨** — マージ後のコミットメッセージが PR タイトルになるため、PR タイトルを `feat: …` / `fix: …` 形式にしてください。

### CI（stage）→ maintainer（approve）

1. Release workflow が `npm stage publish` を実行（OIDC / Trusted publishing）
2. maintainer が npmjs.com または CLI で内容を確認して approve:
   - Web: npm → `enginebay` → **Staged packages**
   - CLI: `npm stage list enginebay` → `npm stage approve <stage-id>`（2FA 必須）

`npm stage approve` / `reject` は OIDC 不可。ローカル CLI か npmjs.com から 2FA 付きで実行してください。

### Trusted publishing セットアップ（初回のみ）

1. npm で `enginebay` パッケージを作成（初回 publish 前）
2. パッケージ Settings → **Trusted publishing** で GitHub Actions を追加:
   - Organization or user: `hskksk`
   - Repository: `enginebay`
   - Workflow filename: `publish.yml`（ファイル名のみ。パスは含めない）
   - Environment name: **空のまま**（GitHub Environment を使わない限り）
   - Allowed actions: **`npm stage publish` のみ**（`npm publish` はオフ推奨）
3. （推奨）Settings → Publishing access → **Require two-factor authentication and disallow tokens**
4. PR を `main` にマージ → Release workflow が stage まで実行

認証は [npm trusted publishers](https://docs.npmjs.com/trusted-publishers)（GitHub Actions OIDC）を使用します。stage 時にも provenance が付与されます（public repo / public package の場合）。

### Troubleshooting: `E403 OIDC permission denied for this action`

CI が `npm publish` を呼んでいるのに Trusted publishing で **`npm stage publish` だけ**許可していると、この 403 になります。本 repo は `@semantic-release/exec` 経由で `npm stage publish` を使います。

それでも 403 の場合:

1. npm → Trusted publishing の org/repo/workflow filename が完全一致しているか確認
2. **Allowed actions** で `npm stage publish` がオンで **Save changes** 済みか確認
3. Environment name を npm に入れているなら workflow に `environment:` を追加するか、npm 側を空に戻す
4. `publish.yml` では semantic-release 利用時 **`actions/setup-node` に `registry-url` を付けない**

リリース対象のコミットがない場合（例: 直前の `[skip ci]` リリースコミットのみ）はスキップされます。手動実行は Actions → Release → Run workflow から可能です。

## Repository

Standalone npm package: unscoped name **`enginebay`**, repository [hskksk/enginebay](https://github.com/hskksk/enginebay).

## Documentation

- [Design](docs/design.md) — goals, API, isolation, events, consumers.

## License

UNLICENSED. An OSS license will be chosen separately.
