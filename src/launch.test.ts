import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchEngine } from "./launch.js";
import {
  installFakeCommand,
  withFakePath,
  writeHostOpencodeAuth,
} from "./test/fake-opencode.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of [...cleanups].reverse()) {
    await cleanup();
  }
  cleanups.length = 0;
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function dumpedEnv(dumpDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dumpDir, "env.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("launchEngine", () => {
  it("rejects unknown engines at runtime", async () => {
    await expect(
      launchEngine({
        engine: "gemini" as never,
        hostEnv: {},
      }),
    ).rejects.toThrow('unknown launch engine "gemini"');
  });

  it("resolves a named workspace before engine setup", async () => {
    const hostHome = await tempDir("enginebay-launch-named-host-");
    const binDir = await tempDir("enginebay-launch-named-bin-");
    const dumpDir = await tempDir("enginebay-launch-named-dump-");
    await installFakeCommand(binDir, "codex");

    await launchEngine({
      engine: "codex",
      workspaceId: "My-Project",
      hostHome,
      hostEnv: withFakePath(binDir, {
        HOME: hostHome,
        PATH: process.env.PATH,
        ENGINEBAY_DUMP_DIR: dumpDir,
      }),
    });

    const env = await dumpedEnv(dumpDir);
    expect(env.cwd).toBe(
      join(hostHome, ".local", "share", "enginebay", "workspaces", "my-project"),
    );
    expect(existsSync(env.cwd as string)).toBe(true);
  });

  it("launches Codex interactively with isolated config and attached auth", async () => {
    const hostHome = await tempDir("enginebay-launch-codex-host-");
    const workDir = await tempDir("enginebay-launch-codex-work-");
    const binDir = await tempDir("enginebay-launch-codex-bin-");
    const dumpDir = await tempDir("enginebay-launch-codex-dump-");
    await installFakeCommand(binDir, "codex");
    await mkdir(join(hostHome, ".codex", "sessions"), { recursive: true });
    await writeFile(
      join(hostHome, ".codex", "auth.json"),
      '{"tokens":{"access_token":"host"}}\n',
      "utf8",
    );
    await writeFile(
      join(hostHome, ".codex", "config.toml"),
      'model = "host-model"\n',
      "utf8",
    );

    const code = await launchEngine({
      engine: "codex",
      args: ["fix it"],
      model: "gpt-5",
      instructions: "Use the board.",
      workDir,
      hostHome,
      hostEnv: withFakePath(binDir, {
        HOME: hostHome,
        PATH: process.env.PATH,
        GH_TOKEN: "ghs_host_secret",
        ENGINEBAY_DUMP_DIR: dumpDir,
        ENGINEBAY_FAKE_EXIT: "7",
      }),
      mcp: {
        command: process.execPath,
        args: ["/tmp/mcp.js"],
        env: { BOARD_URL: "http://127.0.0.1:9" },
        name: "board-mcp",
      },
      extraEnv: { GH_TOKEN: "ghs_minted_secret" },
      git: { committerName: "bay-bot" },
    });

    expect(code).toBe(7);
    expect(
      JSON.parse(await readFile(join(dumpDir, "argv.json"), "utf8")),
    ).toEqual(["--model", "gpt-5", "fix it"]);
    const env = await dumpedEnv(dumpDir);
    expect(env.HOME).toBe(hostHome);
    expect(env.CODEX_HOME).not.toBe(join(hostHome, ".codex"));
    expect(env.GH_TOKEN).toBe("ghs_minted_secret");
    expect(env.GIT_CONFIG_GLOBAL).not.toBe("/dev/null");
    expect(env.gitConfig).toContain("name = bay-bot");
    expect(env.codexFiles).toEqual(
      expect.arrayContaining(["auth.json", "config.toml"]),
    );
    expect(env.codexConfig).toContain('[mcp_servers."board-mcp"]');
    expect(env.codexConfig).toContain(
      'developer_instructions = "Use the board."',
    );
    expect(env.codexConfig).not.toContain("host-model");
    expect(existsSync(env.CODEX_HOME as string)).toBe(false);
    expect(
      await readFile(join(hostHome, ".codex", "config.toml"), "utf8"),
    ).toBe('model = "host-model"\n');
  });

  it("applies OpenCode isolation while preserving engine argv", async () => {
    const hostHome = await tempDir("enginebay-launch-open-host-");
    const workDir = await tempDir("enginebay-launch-open-work-");
    const binDir = await tempDir("enginebay-launch-open-bin-");
    const dumpDir = await tempDir("enginebay-launch-open-dump-");
    await installFakeCommand(binDir, "opencode");
    await writeHostOpencodeAuth(hostHome);

    expect(
      await launchEngine({
        engine: "opencode",
        model: "provider/model",
        instructions: "Use MCP first.",
        workDir,
        hostHome,
        hostEnv: withFakePath(binDir, {
          HOME: hostHome,
          PATH: process.env.PATH,
          ENGINEBAY_DUMP_DIR: dumpDir,
        }),
      }),
    ).toBe(0);

    expect(
      JSON.parse(await readFile(join(dumpDir, "argv.json"), "utf8")),
    ).toEqual(["--model", "provider/model"]);
    const env = await dumpedEnv(dumpDir);
    expect(env.HOME).not.toBe(hostHome);
    expect(env.OPENCODE_DISABLE_GLOBAL_CONFIG).toBe("1");
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT as string) as {
      instructions: string[];
    };
    expect(config.instructions).toHaveLength(1);
    expect(env.isolatedShareFiles).toEqual(
      expect.arrayContaining(["auth.json"]),
    );
    expect(existsSync(env.HOME as string)).toBe(false);
  });

  it("adds isolated MCP arguments after Claude options", async () => {
    const hostHome = await tempDir("enginebay-launch-claude-host-");
    const workDir = await tempDir("enginebay-launch-claude-work-");
    const binDir = await tempDir("enginebay-launch-claude-bin-");
    const dumpDir = await tempDir("enginebay-launch-claude-dump-");
    await installFakeCommand(binDir, "claude");

    await launchEngine({
      engine: "claude-code",
      model: "sonnet",
      instructions: "Use MCP first.",
      workDir,
      hostHome,
      hostEnv: withFakePath(binDir, {
        HOME: hostHome,
        PATH: process.env.PATH,
        ENGINEBAY_DUMP_DIR: dumpDir,
      }),
    });

    const argv = JSON.parse(
      await readFile(join(dumpDir, "argv.json"), "utf8"),
    ) as string[];
    expect(argv.slice(0, 2)).toEqual(["--model", "sonnet"]);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe(
      "Use MCP first.",
    );
    const env = await dumpedEnv(dumpDir);
    expect(env.HOME).toBe(hostHome);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(JSON.parse(env.mcpConfig as string)).toEqual({ mcpServers: {} });
  });

  it("launches Cursor with a disposable config directory", async () => {
    const hostHome = await tempDir("enginebay-launch-cursor-host-");
    const workDir = await tempDir("enginebay-launch-cursor-work-");
    const binDir = await tempDir("enginebay-launch-cursor-bin-");
    const dumpDir = await tempDir("enginebay-launch-cursor-dump-");
    await installFakeCommand(binDir, "cursor-agent");

    await launchEngine({
      engine: "cursor-agent",
      model: "composer",
      instructions: "Use MCP first.",
      mcp: {
        command: "node",
        args: ["server.mjs"],
        env: {},
      },
      workDir,
      hostHome,
      hostEnv: withFakePath(binDir, {
        HOME: hostHome,
        PATH: process.env.PATH,
        ENGINEBAY_DUMP_DIR: dumpDir,
      }),
    });

    expect(
      JSON.parse(await readFile(join(dumpDir, "argv.json"), "utf8")),
    ).toEqual([
      "--model",
      "composer",
      "--approve-mcps",
      "Use MCP first.",
    ]);
    const env = await dumpedEnv(dumpDir);
    expect(env.CURSOR_CONFIG_DIR).not.toBe(join(hostHome, ".cursor"));
    expect(env.isolatedCursorFiles).toEqual(
      expect.arrayContaining(["mcp.json", "cli-config.json"]),
    );
    expect(existsSync(env.CURSOR_CONFIG_DIR as string)).toBe(false);
  });
});
