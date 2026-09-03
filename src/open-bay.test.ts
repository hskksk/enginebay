import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor, openBay } from "./open-bay.js";
import type { IsolationKind } from "./types.js";
import {
  installFakeCommand,
  installFakeOpencode,
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

async function collectEvents(
  bay: Awaited<ReturnType<typeof openBay>>,
  prompt: string,
) {
  const events = [];
  for await (const event of bay.run(prompt)) {
    events.push(event);
  }
  return events;
}

describe("openBay OpenCode isolation", () => {
  it("spawns a fake opencode with isolated XDG, inherited auth, and no host config writes", async () => {
    const hostHome = await tempDir("enginebay-host-");
    const workDir = await tempDir("enginebay-work-");
    const binDir = await tempDir("enginebay-bin-");
    const dumpDir = await tempDir("enginebay-dump-");
    await installFakeOpencode(binDir);
    await writeHostOpencodeAuth(hostHome);
    await writeFile(
      join(hostHome, ".local", "share", "opencode", "session.db"),
      "host-session",
      "utf8",
    );
    const hostConfigDir = join(hostHome, ".config", "opencode");
    await mkdir(hostConfigDir, { recursive: true });
    await writeFile(join(hostConfigDir, "config.json"), '{"host":true}\n', "utf8");
    await writeFile(join(workDir, "keep.txt"), "workspace\n", "utf8");

    const hostEnv = withFakePath(binDir, {
      HOME: hostHome,
      PATH: process.env.PATH,
      GH_TOKEN: "github_pat_host",
      GITHUB_TOKEN: "host-other",
    });

    const bay = await openBay({
      engine: "opencode",
      workDir,
      hostHome,
      hostEnv,
      instructions: "You are in a bay.",
      mcp: {
        command: process.execPath,
        args: ["/tmp/mcp.js"],
        env: { BOARD_URL: "http://127.0.0.1:9" },
        name: "board-mcp",
      },
      extraEnv: {
        ENGINEBAY_DUMP_DIR: dumpDir,
        GH_TOKEN: "ghs_mintedtokenvalue",
      },
      git: { committerName: "bay-bot" },
      model: "opencode/big-pickle",
    });

    const events = await collectEvents(bay, "read the briefing");
    expect(events.map((event) => event.kind)).toEqual(["text", "exit"]);
    expect(events[0]).toEqual({ kind: "text", text: "ok" });
    expect(events.at(-1)).toEqual({ kind: "exit", code: 0 });

    const argv = JSON.parse(
      await readFile(join(dumpDir, "argv.json"), "utf8"),
    ) as string[];
    expect(argv).toEqual([
      "run",
      "--format",
      "json",
      "--dangerously-skip-permissions",
      "--dir",
      workDir,
      "--model",
      "opencode/big-pickle",
      "read the briefing",
    ]);

    const dumped = JSON.parse(
      await readFile(join(dumpDir, "env.json"), "utf8"),
    ) as {
      HOME: string;
      XDG_CONFIG_HOME: string;
      XDG_DATA_HOME: string;
      XDG_CONFIG_DIRS: string;
      OPENCODE_DISABLE_GLOBAL_CONFIG: string;
      OPENCODE_DISABLE_CLAUDE_CODE: string;
      OPENCODE_CONFIG_CONTENT: string;
      GH_TOKEN: string;
      GITHUB_TOKEN?: string;
      GIT_CONFIG_GLOBAL: string;
      isolatedShareFiles: string[];
    };
    expect(dumped.HOME).not.toBe(hostHome);
    expect(dumped.XDG_CONFIG_HOME).not.toBe(join(hostHome, ".config"));
    expect(dumped.XDG_CONFIG_DIRS).toBe("");
    expect(dumped.OPENCODE_DISABLE_GLOBAL_CONFIG).toBe("1");
    expect(dumped.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(dumped.GH_TOKEN).toBe("ghs_mintedtokenvalue");
    expect(dumped.GITHUB_TOKEN).toBeUndefined();
    expect(dumped.isolatedShareFiles).toContain("auth.json");
    expect(dumped.isolatedShareFiles).not.toContain("session.db");

    const config = JSON.parse(dumped.OPENCODE_CONFIG_CONTENT) as {
      mcp: Record<string, { command: string[] }>;
      instructions: string[];
    };
    expect(config.mcp["board-mcp"]?.command).toEqual([
      process.execPath,
      "/tmp/mcp.js",
    ]);
    expect(config.instructions).toHaveLength(1);
    expect(await readFile(config.instructions[0]!, "utf8")).toBe(
      "You are in a bay.",
    );

    const gitconfig = await readFile(dumped.GIT_CONFIG_GLOBAL, "utf8");
    expect(gitconfig).toContain("name = bay-bot");
    expect(gitconfig).toContain("enginebay@users.noreply.github.com");

    expect(await readFile(join(hostConfigDir, "config.json"), "utf8")).toBe(
      '{"host":true}\n',
    );
    expect(existsSync(join(workDir, "AGENTS.md"))).toBe(false);

    await bay.close();
    expect(existsSync(join(workDir, "keep.txt"))).toBe(true);
    expect(existsSync(dumped.HOME)).toBe(false);
    expect(existsSync(dumped.XDG_DATA_HOME)).toBe(false);
  });

  it("redacts secrets from streamed events and yields stderr diagnostics", async () => {
    const hostHome = await tempDir("enginebay-host-");
    const workDir = await tempDir("enginebay-work-");
    const binDir = await tempDir("enginebay-bin-");
    await installFakeOpencode(binDir);
    await writeHostOpencodeAuth(hostHome);

    const bay = await openBay({
      engine: "opencode",
      workDir,
      hostHome,
      hostEnv: withFakePath(binDir, {
        HOME: hostHome,
        PATH: process.env.PATH,
        ENGINEBAY_FAKE_EVENTS: JSON.stringify({
          type: "text",
          part: { type: "text", text: "token ghs_LIVESECRET99" },
        }),
        ENGINEBAY_FAKE_STDERR: "Bearer abc.def leaked\n",
      }),
    });
    const events = await collectEvents(bay, "go");
    await bay.close();
    expect(events).toContainEqual({
      kind: "text",
      text: "token [redacted]",
    });
    expect(events).toContainEqual({
      kind: "diagnostic",
      stream: "stderr",
      text: "[redacted] leaked",
    });
    expect(JSON.stringify(events)).not.toContain("ghs_LIVESECRET99");
    expect(JSON.stringify(events)).not.toContain("Bearer abc.def");
  });

  it("does not throw when host auth is missing", async () => {
    const hostHome = await tempDir("enginebay-host-");
    const workDir = await tempDir("enginebay-work-");
    const binDir = await tempDir("enginebay-bin-");
    await installFakeOpencode(binDir);
    const bay = await openBay({
      engine: "opencode",
      workDir,
      hostHome,
      hostEnv: withFakePath(binDir, { HOME: hostHome, PATH: process.env.PATH }),
    });
    const events = await collectEvents(bay, "go");
    await bay.close();
    expect(events.at(-1)).toEqual({ kind: "exit", code: 0 });
  });
});

describe("openBay Claude Code isolation", () => {
  it("keeps host HOME, writes MCP to a temp file, and isolates git", async () => {
    const hostHome = await tempDir("enginebay-claude-host-");
    const workDir = await tempDir("enginebay-claude-work-");
    const binDir = await tempDir("enginebay-claude-bin-");
    const dumpDir = await tempDir("enginebay-claude-dump-");
    await installFakeCommand(binDir, "claude");
    await mkdir(join(hostHome, ".claude"), { recursive: true });
    await writeFile(
      join(hostHome, ".claude", ".credentials.json"),
      '{"claudeAiOauth":{}}\n',
      "utf8",
    );
    await writeFile(join(workDir, "keep.txt"), "workspace\n", "utf8");

    const bay = await openBay({
      engine: "claude-code",
      workDir,
      hostHome,
      hostEnv: withFakePath(binDir, {
        HOME: hostHome,
        PATH: process.env.PATH,
        GH_TOKEN: "github_pat_host",
        CLAUDE_CONFIG_DIR: join(hostHome, ".claude"),
      }),
      instructions: "You are in a bay.",
      mcp: {
        command: process.execPath,
        args: ["/tmp/mcp.js"],
        env: { BOARD_URL: "http://127.0.0.1:9" },
        name: "board-mcp",
      },
      extraEnv: {
        ENGINEBAY_DUMP_DIR: dumpDir,
        ENGINEBAY_FAKE_EVENTS: JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "ok" }],
          },
        }),
        GH_TOKEN: "ghs_mintedtokenvalue",
      },
      git: { committerName: "bay-bot" },
      model: "claude-sonnet-5",
    });

    const events = await collectEvents(bay, "read the briefing");
    expect(events.map((event) => event.kind)).toEqual(["text", "exit"]);
    expect(events[0]).toEqual({ kind: "text", text: "ok" });
    expect(events.at(-1)).toEqual({ kind: "exit", code: 0 });

    const argv = JSON.parse(
      await readFile(join(dumpDir, "argv.json"), "utf8"),
    ) as string[];
    expect(argv).not.toContain("--bare");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe(
      "You are in a bay.",
    );
    const mcpPath = argv[argv.indexOf("--mcp-config") + 1]!;
    const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: Record<string, { alwaysLoad?: boolean }>;
    };
    expect(mcp.mcpServers["board-mcp"]?.alwaysLoad).toBe(true);

    const dumped = JSON.parse(
      await readFile(join(dumpDir, "env.json"), "utf8"),
    ) as {
      HOME: string;
      GH_TOKEN: string;
      GITHUB_TOKEN?: string;
      GIT_CONFIG_GLOBAL: string;
      CLAUDE_CONFIG_DIR?: string;
      CLAUDE_SECURESTORAGE_CONFIG_DIR?: string;
      MCP_CONNECTION_NONBLOCKING?: string;
    };
    expect(dumped.HOME).toBe(hostHome);
    expect(dumped.GH_TOKEN).toBe("ghs_mintedtokenvalue");
    expect(dumped.GITHUB_TOKEN).toBeUndefined();
    expect(dumped.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(dumped.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(dumped.MCP_CONNECTION_NONBLOCKING).toBe("0");
    expect(dumped.GIT_CONFIG_GLOBAL).not.toBe("/dev/null");
    expect(dumped.GIT_CONFIG_GLOBAL).not.toContain(hostHome);
    const gitconfig = await readFile(dumped.GIT_CONFIG_GLOBAL, "utf8");
    expect(gitconfig).toContain("name = bay-bot");

    expect(
      await readFile(join(hostHome, ".claude", ".credentials.json"), "utf8"),
    ).toBe('{"claudeAiOauth":{}}\n');
    expect(existsSync(join(workDir, "AGENTS.md"))).toBe(false);

    await bay.close();
    expect(existsSync(join(workDir, "keep.txt"))).toBe(true);
    expect(existsSync(mcpPath)).toBe(false);
  });
});

describe("openBay workspaces", () => {
  it("creates an ephemeral work dir and deletes it on close", async () => {
    const hostHome = await tempDir("enginebay-ws-eph-home-");
    const bay = await openBay({
      engine: "opencode",
      hostHome,
      hostEnv: { HOME: hostHome, PATH: process.env.PATH },
    });
    expect(bay.workspace.ephemeral).toBe(true);
    expect(bay.workspace.persistent).toBe(false);
    expect(existsSync(bay.workDir)).toBe(true);
    const path = bay.workDir;
    await bay.close();
    expect(existsSync(path)).toBe(false);
  });

  it("reuses a named XDG workspace and keeps it after close", async () => {
    const hostHome = await tempDir("enginebay-ws-named-home-");
    const hostEnv = { HOME: hostHome, PATH: process.env.PATH };
    const bay = await openBay({
      engine: "claude-code",
      workspaceId: "my-app",
      hostHome,
      hostEnv,
    });
    expect(bay.workspace.id).toBe("my-app");
    expect(bay.workspace.persistent).toBe(true);
    expect(bay.workDir).toBe(
      join(hostHome, ".local", "share", "enginebay", "workspaces", "my-app"),
    );
    await writeFile(join(bay.workDir, "keep.txt"), "named\n", "utf8");
    await bay.close();
    expect(existsSync(join(bay.workDir, "keep.txt"))).toBe(true);

    const again = await openBay({
      engine: "opencode",
      workspaceId: "My-App",
      hostHome,
      hostEnv,
    });
    expect(again.workDir).toBe(bay.workDir);
    expect(await readFile(join(again.workDir, "keep.txt"), "utf8")).toBe(
      "named\n",
    );
    await again.close();
    expect(existsSync(join(again.workDir, "keep.txt"))).toBe(true);
  });
});

describe("openBay guards", () => {
  it("rejects unimplemented isolation backends", async () => {
    await expect(
      openBay({
        engine: "opencode",
        workDir: "/tmp/work",
        isolation: { kind: "jai" as IsolationKind },
      }),
    ).rejects.toThrow(/isolation jai is not implemented/);
  });

  it("rejects setting both workDir and workspaceId", async () => {
    await expect(
      openBay({
        engine: "opencode",
        workDir: "/tmp/work",
        workspaceId: "x",
      }),
    ).rejects.toThrow(/workDir or workspaceId, not both/);
  });
});

describe("doctor", () => {
  it("reports a missing CLI in English", async () => {
    const emptyPath = await tempDir("enginebay-empty-path-");
    const report = await doctor("opencode", {
      env: { PATH: emptyPath, HOME: emptyPath },
      home: emptyPath,
    });
    expect(report.ok).toBe(false);
    expect(report.cli.found).toBe(false);
    expect(report.message).toMatch(/opencode CLI is not on PATH/);
    expect(report.auth.found).toBe(false);

    const claudeMissing = await doctor("claude-code", {
      env: { PATH: emptyPath, HOME: emptyPath },
      home: emptyPath,
    });
    expect(claudeMissing.ok).toBe(false);
    expect(claudeMissing.message).toMatch(/claude CLI is not on PATH/);
  });

  it("finds a fake CLI and host auth files", async () => {
    const hostHome = await tempDir("enginebay-host-");
    const binDir = await tempDir("enginebay-bin-");
    await installFakeOpencode(binDir);
    await writeHostOpencodeAuth(hostHome);
    const report = await doctor("opencode", {
      env: withFakePath(binDir, { HOME: hostHome, PATH: process.env.PATH }),
      home: hostHome,
    });
    expect(report.ok).toBe(true);
    expect(report.cli.found).toBe(true);
    expect(report.cli.version).toBe("1.0.0-fake");
    expect(report.auth.found).toBe(true);
    expect(report.message).toMatch(/auth files present/);
  });

  it("finds a fake claude CLI and host credentials file", async () => {
    const hostHome = await tempDir("enginebay-claude-doc-");
    const binDir = await tempDir("enginebay-claude-doc-bin-");
    await installFakeCommand(binDir, "claude");
    await mkdir(join(hostHome, ".claude"), { recursive: true });
    await writeFile(
      join(hostHome, ".claude", ".credentials.json"),
      '{"claudeAiOauth":{}}\n',
      "utf8",
    );
    const report = await doctor("claude-code", {
      env: withFakePath(binDir, { HOME: hostHome, PATH: process.env.PATH }),
      home: hostHome,
    });
    expect(report.ok).toBe(true);
    expect(report.cli.found).toBe(true);
    expect(report.cli.command).toBe("claude");
    expect(report.cli.version).toBe("1.0.0-fake");
    expect(report.auth.found).toBe(true);
    expect(report.message).toMatch(/credentials file/);
  });
});
