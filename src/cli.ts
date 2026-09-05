import type { LaunchEngineId, LaunchEngineOptions } from "./launch.js";
import { launchEngine } from "./launch.js";

export type CliIo = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

type Launch = (options: LaunchEngineOptions) => Promise<number>;

const COMMANDS: Readonly<Record<string, LaunchEngineId>> = {
  codex: "codex",
  opencode: "opencode",
  claude: "claude-code",
  "claude-code": "claude-code",
  cursor: "cursor-agent",
  "cursor-agent": "cursor-agent",
};

const HELP = `Usage: enginebay <engine> [engine options...]

Launch a coding-agent CLI in an isolated, disposable bay while keeping the
terminal interactive. Engine options are forwarded to the underlying CLI.

Engines:
  codex
  opencode
  claude, claude-code
  cursor, cursor-agent

Examples:
  enginebay codex
  enginebay codex --model gpt-5
  enginebay claude --model sonnet
  enginebay opencode .

Run "enginebay <engine> --help" for the engine's own help.
`;

export async function runCli(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  launch: Launch = launchEngine,
): Promise<number> {
  const [command, ...engineArgs] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.stdout.write(HELP);
    return 0;
  }
  if (command === "help") {
    if (engineArgs.length === 0) {
      io.stdout.write(HELP);
      return 0;
    }
    const engine = COMMANDS[engineArgs[0]!];
    if (!engine) {
      return unknownCommand(engineArgs[0]!, io);
    }
    return launch({ engine, args: ["--help"], workDir: process.cwd() });
  }
  if (command === "--version" || command === "-V") {
    io.stdout.write(`${await packageVersion()}\n`);
    return 0;
  }

  const engine = COMMANDS[command];
  if (!engine) {
    return unknownCommand(command, io);
  }
  return launch({ engine, args: engineArgs, workDir: process.cwd() });
}

function unknownCommand(command: string, io: CliIo): number {
  io.stderr.write(`enginebay: unknown engine "${command}"\n\n${HELP}`);
  return 2;
}

async function packageVersion(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  return typeof packageJson.version === "string"
    ? packageJson.version
    : "unknown";
}
