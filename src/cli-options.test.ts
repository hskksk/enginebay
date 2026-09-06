import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliOptions } from "./cli-options.js";

describe("parseCliOptions", () => {
  it("maps the original enginebay features to launch options", async () => {
    const parsed = await parseCliOptions(
      [
        "--workspace-id",
        "my-project",
        "--isolation=env",
        "--model",
        "provider/model",
        "--instructions",
        "Stay focused.",
        "--mcp-command",
        "node",
        "--mcp-arg",
        "server.mjs",
        "--mcp-arg=--stdio",
        "--mcp-env",
        "BOARD_TOKEN",
        "--mcp-env",
        "BOARD_URL=http://127.0.0.1:9",
        "--mcp-name",
        "board",
        "--env",
        "GH_TOKEN",
        "--git-committer-name",
        "bay-bot",
        "--",
        "--verbose",
      ],
      {
        BOARD_TOKEN: "board-secret",
        GH_TOKEN: "github-secret",
      },
    );

    expect(parsed).toEqual({
      help: false,
      args: ["--verbose"],
      workspaceId: "my-project",
      isolation: { kind: "env" },
      model: "provider/model",
      instructions: "Stay focused.",
      mcp: {
        command: "node",
        args: ["server.mjs", "--stdio"],
        env: {
          BOARD_TOKEN: "board-secret",
          BOARD_URL: "http://127.0.0.1:9",
        },
        name: "board",
      },
      extraEnv: { GH_TOKEN: "github-secret" },
      git: { committerName: "bay-bot" },
    });
  });

  it("reads instructions from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enginebay-cli-options-"));
    try {
      const path = join(dir, "instructions.md");
      await writeFile(path, "Use the MCP tools.\n", "utf8");
      await expect(
        parseCliOptions(["--instructions-file", path]),
      ).resolves.toMatchObject({ instructions: "Use the MCP tools.\n" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous workspaces and incomplete MCP config", async () => {
    await expect(
      parseCliOptions([
        "--work-dir",
        "/tmp/work",
        "--workspace-id",
        "named",
      ]),
    ).rejects.toThrow(/either --work-dir or --workspace-id/);
    await expect(parseCliOptions(["--mcp-arg", "server.mjs"])).rejects.toThrow(
      /--mcp-command is required/,
    );
  });

  it("does not parse native arguments after the separator", async () => {
    await expect(
      parseCliOptions(["--", "--workspace-id", "belongs-to-native"]),
    ).resolves.toEqual({
      help: false,
      args: ["--workspace-id", "belongs-to-native"],
    });
  });
});
