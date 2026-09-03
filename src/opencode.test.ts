import { describe, expect, it } from "vitest";
import {
  buildOpencodeArgs,
  buildOpencodeMcpConfig,
  hostOpencodeShareDir,
} from "./opencode.js";

describe("buildOpencodeArgs", () => {
  it("uses json format, skip-permissions, and --dir", () => {
    expect(
      buildOpencodeArgs({
        workDir: "/tmp/work",
        prompt: "read the briefing",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--dangerously-skip-permissions",
      "--dir",
      "/tmp/work",
      "read the briefing",
    ]);
  });

  it("omits --model when unset so the engine default applies", () => {
    expect(
      buildOpencodeArgs({ workDir: "/tmp/work", prompt: "go" }),
    ).not.toContain("--model");
  });

  it("passes --model when given", () => {
    const args = buildOpencodeArgs({
      workDir: "/tmp/work",
      prompt: "go",
      model: "opencode/big-pickle",
    });
    expect(args[args.indexOf("--model") + 1]).toBe("opencode/big-pickle");
  });

  it("does not use the older --auto flag", () => {
    expect(
      buildOpencodeArgs({ workDir: "/tmp/work", prompt: "go" }),
    ).not.toContain("--auto");
  });
});

describe("buildOpencodeMcpConfig", () => {
  it("injects a local MCP server named enginebay by default", () => {
    expect(
      buildOpencodeMcpConfig({
        mcp: {
          command: "/usr/bin/node",
          args: ["/tmp/mcp.js"],
          env: { BOARD_TOKEN: "tok" },
        },
      }),
    ).toEqual({
      mcp: {
        enginebay: {
          type: "local",
          command: ["/usr/bin/node", "/tmp/mcp.js"],
          enabled: true,
          environment: { BOARD_TOKEN: "tok" },
        },
      },
    });
  });

  it("uses the consumer-supplied MCP name", () => {
    const config = buildOpencodeMcpConfig({
      mcp: {
        command: "node",
        args: ["server.mjs"],
        env: {},
        name: "board-mcp",
      },
      instructionsPath: "/tmp/runtime/instructions.md",
    });
    expect(config).toEqual({
      mcp: {
        "board-mcp": {
          type: "local",
          command: ["node", "server.mjs"],
          enabled: true,
          environment: {},
        },
      },
      instructions: ["/tmp/runtime/instructions.md"],
    });
  });

  it("omits mcp when the consumer did not pass a target", () => {
    expect(buildOpencodeMcpConfig({})).toEqual({});
  });
});

describe("hostOpencodeShareDir", () => {
  it("is ~/.local/share/opencode", () => {
    expect(hostOpencodeShareDir("/home/haru")).toBe(
      "/home/haru/.local/share/opencode",
    );
  });
});
