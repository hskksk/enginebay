import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachCodexAuth,
  buildCodexConfig,
  hostCodexHome,
} from "./codex.js";

describe("buildCodexConfig", () => {
  it("writes a session-scoped stdio MCP server as TOML", () => {
    expect(
      buildCodexConfig({
        mcp: {
          command: "/usr/bin/node",
          args: ["/tmp/mcp.js", "argument with spaces"],
          env: { BOARD_TOKEN: 'a"b' },
          name: "board-mcp",
        },
        instructions: "Use the board.",
      }),
    ).toBe(
      `developer_instructions = "Use the board."\n\n` +
        `[mcp_servers."board-mcp"]\n` +
        `command = "/usr/bin/node"\n` +
        `args = ["/tmp/mcp.js", "argument with spaces"]\n` +
        `env = { "BOARD_TOKEN" = "a\\"b" }\n`,
    );
  });

  it("returns an empty config when no MCP is supplied", () => {
    expect(buildCodexConfig()).toBe("");
  });
});

describe("Codex auth", () => {
  it("attaches auth.json but not host config or sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "enginebay-codex-auth-"));
    const hostHome = join(root, "home");
    const isolatedCodexHome = join(root, "isolated");
    const host = hostCodexHome(hostHome);
    await mkdir(join(host, "sessions"), { recursive: true });
    await writeFile(join(host, "auth.json"), '{"tokens":{}}\n', "utf8");
    await writeFile(join(host, "config.toml"), 'model = "host"\n', "utf8");

    const { attached } = await attachCodexAuth({
      hostCodexHome: host,
      isolatedCodexHome,
    });

    expect(attached).toEqual(["auth.json"]);
    expect(await readlink(join(isolatedCodexHome, "auth.json"))).toBe(
      join(host, "auth.json"),
    );
    expect(existsSync(join(isolatedCodexHome, "config.toml"))).toBe(false);
    expect(existsSync(join(isolatedCodexHome, "sessions"))).toBe(false);
  });
});
