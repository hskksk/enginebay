import { describe, expect, it, vi } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import type { LaunchEngineOptions } from "./launch.js";

function captureIo(): {
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (text) => ((stdout += String(text)), true) },
      stderr: { write: (text) => ((stderr += String(text)), true) },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("runCli", () => {
  it("forwards Codex options without parsing them", async () => {
    const launch = vi.fn(
      async (_options: LaunchEngineOptions): Promise<number> => 7,
    );
    const output = captureIo();

    const code = await runCli(
      ["codex", "--model", "gpt-5", "--", "fix the tests"],
      output.io,
      launch,
    );

    expect(code).toBe(7);
    expect(launch).toHaveBeenCalledWith({
      engine: "codex",
      args: ["--model", "gpt-5", "--", "fix the tests"],
      workDir: process.cwd(),
    });
  });

  it.each([
    ["opencode", "opencode"],
    ["claude", "claude-code"],
    ["claude-code", "claude-code"],
    ["cursor", "cursor-agent"],
    ["cursor-agent", "cursor-agent"],
  ] as const)("maps %s to the launch engine %s", async (command, engine) => {
    const launch = vi.fn(async (): Promise<number> => 0);
    await runCli([command, "--flag"], captureIo().io, launch);
    expect(launch).toHaveBeenCalledWith({
      engine,
      args: ["--flag"],
      workDir: process.cwd(),
    });
  });

  it("shows wrapper help without launching an engine", async () => {
    const launch = vi.fn(async (): Promise<number> => 0);
    const output = captureIo();
    expect(await runCli(["--help"], output.io, launch)).toBe(0);
    expect(output.stdout()).toContain("Usage: enginebay <engine>");
    expect(launch).not.toHaveBeenCalled();
  });

  it("returns usage status for an unknown engine", async () => {
    const output = captureIo();
    expect(await runCli(["gemini"], output.io)).toBe(2);
    expect(output.stderr()).toContain('unknown engine "gemini"');
  });

  it("sends engine-specific help to the engine", async () => {
    const launch = vi.fn(async (): Promise<number> => 0);
    await runCli(["help", "codex"], captureIo().io, launch);
    expect(launch).toHaveBeenCalledWith({
      engine: "codex",
      args: ["--help"],
      workDir: process.cwd(),
    });
  });
});
