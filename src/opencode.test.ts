import { describe, expect, it } from "vitest";
import {
  buildOpencodeArgs,
  buildOpencodeLaunchArgs,
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

  it("passes --agent when given", () => {
    const args = buildOpencodeArgs({
      workDir: "/tmp/work",
      prompt: "go",
      agent: "eval",
    });
    expect(args[args.indexOf("--agent") + 1]).toBe("eval");
  });

  it("omits --agent when unset", () => {
    expect(
      buildOpencodeArgs({ workDir: "/tmp/work", prompt: "go" }),
    ).not.toContain("--agent");
  });

  it("does not use the older --auto flag", () => {
    expect(
      buildOpencodeArgs({ workDir: "/tmp/work", prompt: "go" }),
    ).not.toContain("--auto");
  });

  it("passes --session when resuming a recovered run", () => {
    expect(
      buildOpencodeArgs({
        workDir: "/tmp/work",
        prompt: "Continue.",
        sessionId: "ses_1",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--dangerously-skip-permissions",
      "--dir",
      "/tmp/work",
      "--session",
      "ses_1",
      "Continue.",
    ]);
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

  it("merges plugins with mcp and keeps extra from overwriting mcp", () => {
    expect(
      buildOpencodeMcpConfig({
        mcp: {
          command: "node",
          args: ["server.mjs"],
          env: {},
          name: "board-mcp",
        },
        plugins: ["opencode-gemini-auth@latest"],
        extra: {
          mcp: { stolen: true },
          instructions: ["nope.md"],
          theme: "dark",
        },
      }),
    ).toEqual({
      theme: "dark",
      mcp: {
        "board-mcp": {
          type: "local",
          command: ["node", "server.mjs"],
          enabled: true,
          environment: {},
        },
      },
      plugin: ["opencode-gemini-auth@latest"],
    });
  });

  it("merges extraEnv OPENCODE_CONFIG_CONTENT without replacing mcp", () => {
    expect(
      buildOpencodeMcpConfig({
        mcp: {
          command: "node",
          args: ["s.mjs"],
          env: {},
        },
        extraEnvContent: JSON.stringify({
          plugin: ["from-env"],
          mcp: { hijack: true },
        }),
      }),
    ).toEqual({
      plugin: ["from-env"],
      mcp: {
        enginebay: {
          type: "local",
          command: ["node", "s.mjs"],
          enabled: true,
          environment: {},
        },
      },
    });
  });
});

describe("buildOpencodeLaunchArgs", () => {
  it("defaults to interactive run --dir and skip-permissions", () => {
    expect(
      buildOpencodeLaunchArgs({
        workDir: "/tmp/work",
        model: "provider/model",
        agent: "eval",
      }),
    ).toEqual([
      "run",
      "--interactive",
      "--dir",
      "/tmp/work",
      "--dangerously-skip-permissions",
      "--model",
      "provider/model",
      "--agent",
      "eval",
    ]);
  });

  it("does not duplicate --model when args already has it", () => {
    const args = buildOpencodeLaunchArgs({
      workDir: "/tmp/work",
      model: "from-option",
      args: ["--model", "from-args", "--verbose"],
    });
    expect(args.filter((arg) => arg === "--model")).toHaveLength(1);
    expect(args[args.indexOf("--model") + 1]).toBe("from-args");
  });

  it("does not duplicate --dir when extras already have it", () => {
    const args = buildOpencodeLaunchArgs({
      workDir: "/tmp/work",
      args: ["--dir", "/tmp/other", "--verbose"],
    });
    expect(args.filter((arg) => arg === "--dir")).toHaveLength(1);
    expect(args[args.indexOf("--dir") + 1]).toBe("/tmp/other");
  });

  it("forwards a full subcommand without prepending interactive run", () => {
    expect(
      buildOpencodeLaunchArgs({
        workDir: "/tmp/work",
        model: "m",
        args: ["auth", "login"],
      }),
    ).toEqual(["auth", "login", "--model", "m"]);
  });

  it("treats sessionId and continueLast as exclusive", () => {
    expect(() =>
      buildOpencodeLaunchArgs({
        workDir: "/tmp/work",
        sessionId: "ses_1",
        continueLast: true,
      }),
    ).toThrow(/sessionId or continueLast/);
  });

  it("passes --session or --continue but not both", () => {
    expect(
      buildOpencodeLaunchArgs({
        workDir: "/tmp/work",
        sessionId: "ses_1",
      }),
    ).toContain("--session");
    expect(
      buildOpencodeLaunchArgs({
        workDir: "/tmp/work",
        continueLast: true,
      }),
    ).toContain("--continue");
  });
});

describe("hostOpencodeShareDir", () => {
  it("is ~/.local/share/opencode", () => {
    expect(hostOpencodeShareDir("/home/haru")).toBe(
      "/home/haru/.local/share/opencode",
    );
  });
});
