# AGENTS.md

enginebay runs a host-installed coding agent (OpenCode, Claude Code, later Cursor Agent / Gemini CLI) as a library: one process, one workspace, one MCP injection, a canonical event stream.

Design of record: [docs/design.md](docs/design.md). Do not add product-specific imports or types to the public API.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Unit tests must not require a live coding CLI. Live engines are optional / manual.
