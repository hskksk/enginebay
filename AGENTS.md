# AGENTS.md

enginebay runs a host-installed coding agent (OpenCode, Claude Code, later Cursor Agent / Gemini CLI) as a library: one process, one workspace, one MCP injection, a canonical event stream.

Design of record: [docs/design.md](docs/design.md). Do not add product-specific imports or types to the public API.

## Language

**English only** for everything that lands in this repository, even when the user writes in Japanese or another language.

Write English in source, comments, docs, tests, commit messages, PR titles and bodies, CI workflow text, error messages, and any other artifact you create or edit.

Do not mix Japanese (or other non-English prose) into files. Translate existing non-English prose to English instead of leaving it.

The user may prompt in Japanese. Still produce English artifacts. Do not mirror the prompt language in code or documentation.

Exceptions:

- Unicode in identifiers, fixtures, or examples that demonstrate encoding support (for example `my-app-ミカ`).
- Third-party names, URLs, and quoted CLI output.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Unit tests must not require a live coding CLI. Live engines are optional / manual.

## Commits and PR titles

Releases use [semantic-release](https://semantic-release.gitbook.io/) with [@semantic-release/commit-analyzer](https://github.com/semantic-release/commit-analyzer) and [Conventional Commits](https://www.conventionalcommits.org/). **Squash merge is the norm** — the merged commit message is usually the PR title, so set the PR title to the final release message.

### Format

```
<type>[optional scope][optional !]: <description>

[optional body]

[optional footer(s)]
```

Examples:

```
feat: add cursor-agent engine driver
fix(opencode): attach auth-v2.json on isolated data dir
ci: pin Node 22.14.0 in publish workflow
docs: document staged npm publish flow
```

Rules:

- Use the imperative mood (`add`, not `added` / `adds`).
- Keep the subject line ≤ 72 characters; no trailing period.
- Scope is optional; use a short subsystem name when it helps (`opencode`, `claude`, `ci`, `docs`).
- Reference issues in the footer when useful: `Fixes #123`.

### Version bump mapping (this repo)

Configured in [`.releaserc.json`](.releaserc.json):

| Prefix / signal | Release |
| --- | --- |
| `feat:` | **minor** |
| `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, `ci:`, `test:` | **patch** |
| `BREAKING CHANGE:` in footer, or `!` after type/scope (e.g. `feat!:`) | **major** |

Use `feat:` only for user-visible API or behavior changes. Use `fix:` for bug fixes. Use `refactor:` for internal reshaping without intended behavior change. Use `docs:`, `ci:`, `chore:`, `test:` for non-feature work — they still trigger a patch release here.

### Breaking changes

Prefer an explicit footer:

```
feat: drop Node 20 support

BREAKING CHANGE: minimum Node version is now 22.14.0
```

Or the shorthand form: `feat!: drop Node 20 support`.

### What to avoid

- Vague subjects: `update`, `fix stuff`, `WIP`.
- PR titles that do not start with a recognized type when the change should ship in the next release.
- Mixing unrelated changes under one `feat:` / `fix:` — split PRs when version notes would be misleading.
