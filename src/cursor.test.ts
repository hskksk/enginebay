import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachCursorAuth,
  buildCursorArgs,
  buildCursorCliConfig,
  buildCursorMcpConfig,
  cursorAuthPresent,
  hostCursorConfigDir,
} from "./cursor.js";

describe("buildCursorArgs", () => {
  it("uses print mode, force, trust, MCP approve, and stream-json", () => {
    expect(
      buildCursorArgs({
        prompt: "work on the briefing",
        workDir: "/tmp/work",
      }),
    ).toEqual([
      "-p",
      "--force",
      "--trust",
      "--approve-mcps",
      "--sandbox",
      "disabled",
      "--output-format",
      "stream-json",
      "--workspace",
      "/tmp/work",
      "work on the briefing",
    ]);
  });

  it("omits --model when unset and prepends instructions to the prompt", () => {
    expect(
      buildCursorArgs({ prompt: "go", workDir: "/tmp/work" }),
    ).not.toContain("--model");
    const args = buildCursorArgs({
      prompt: "go",
      workDir: "/tmp/work",
      instructions: "You are in a bay.",
      model: "composer-2",
    });
    expect(args[args.indexOf("--model") + 1]).toBe("composer-2");
    expect(args.at(-1)).toBe("You are in a bay.\n\ngo");
  });

  it("does not use --continue or --yolo", () => {
    const args = buildCursorArgs({ prompt: "go", workDir: "/tmp/work" });
    expect(args).not.toContain("--continue");
    expect(args).not.toContain("--yolo");
  });
});

describe("buildCursorMcpConfig", () => {
  it("names the server enginebay by default", () => {
    expect(
      buildCursorMcpConfig({
        command: "/usr/bin/node",
        args: ["/tmp/mcp.js"],
        env: { BOARD_TOKEN: "tok" },
      }),
    ).toEqual({
      mcpServers: {
        enginebay: {
          command: "/usr/bin/node",
          args: ["/tmp/mcp.js"],
          env: { BOARD_TOKEN: "tok" },
        },
      },
    });
  });

  it("uses the consumer-supplied MCP name", () => {
    expect(
      buildCursorMcpConfig({
        command: "node",
        args: ["server.mjs"],
        env: {},
        name: "board-mcp",
      }),
    ).toEqual({
      mcpServers: {
        "board-mcp": {
          command: "node",
          args: ["server.mjs"],
          env: {},
        },
      },
    });
  });

  it("writes an empty mcpServers object when the consumer did not pass a target", () => {
    expect(buildCursorMcpConfig()).toEqual({ mcpServers: {} });
  });
});

describe("buildCursorCliConfig", () => {
  it("uses unrestricted approval so host allowlists do not apply", () => {
    expect(buildCursorCliConfig()).toMatchObject({
      version: 1,
      approvalMode: "unrestricted",
    });
  });
});

describe("hostCursorConfigDir", () => {
  it("is ~/.cursor", () => {
    expect(hostCursorConfigDir("/home/haru")).toBe("/home/haru/.cursor");
  });
});

describe("attachCursorAuth", () => {
  it("symlinks host auth.json into the isolated config dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "enginebay-cursor-auth-"));
    const hostConfigDir = join(root, "host-cursor");
    const isolatedConfigDir = join(root, "isolated-cursor");
    await mkdir(hostConfigDir, { recursive: true });
    await writeFile(join(hostConfigDir, "auth.json"), '{"ok":true}\n', "utf8");
    await writeFile(
      join(hostConfigDir, "mcp.json"),
      '{"mcpServers":{"host":{}}}\n',
      "utf8",
    );
    const { attached } = await attachCursorAuth({
      hostConfigDir,
      isolatedConfigDir,
    });
    expect(attached).toEqual(["auth.json"]);
    expect(await readlink(join(isolatedConfigDir, "auth.json"))).toBe(
      join(hostConfigDir, "auth.json"),
    );
    expect(existsSync(join(isolatedConfigDir, "mcp.json"))).toBe(false);
  });
});

describe("cursorAuthPresent", () => {
  it("detects an auth file under host HOME", async () => {
    const hostHome = await mkdtemp(join(tmpdir(), "enginebay-cursor-auth-home-"));
    await mkdir(join(hostHome, ".cursor"), { recursive: true });
    await writeFile(
      join(hostHome, ".cursor", "auth.json"),
      '{"accessToken":"x"}\n',
      "utf8",
    );
    const present = cursorAuthPresent(hostHome, {});
    expect(present.found).toBe(true);
    expect(present.detail).toMatch(/auth file/);
  });

  it("detects CURSOR_API_KEY", () => {
    const present = cursorAuthPresent("/missing", {
      CURSOR_API_KEY: "key_test",
    });
    expect(present.found).toBe(true);
    expect(present.detail).toMatch(/CURSOR_API_KEY/);
  });
});
