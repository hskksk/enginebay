import { parseCliOptions } from "./cli-options.js";
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

const HELP = `Usage: enginebay <engine> [enginebay options] [-- native options...]

Launch a coding-agent CLI with enginebay isolation, workspace, instructions,
environment, git, and session-scoped MCP configuration.

Engines:
  codex
  opencode
  claude, claude-code
  cursor, cursor-agent

Examples:
  enginebay codex
  enginebay opencode --workspace-id my-project --model provider/model
  enginebay claude --instructions-file ./agent.md -- --verbose
  enginebay cursor --mcp-command node --mcp-arg ./server.mjs
  enginebay codex -- --search

Run "enginebay <engine> --help" for enginebay options.
Run "enginebay <engine> -- --help" for the native CLI's help.
`;

const ENGINE_HELP = `Enginebay options:
  --work-dir <path>             Use an explicit workspace directory
  --workspace-id <id>           Use a named persistent workspace
  --isolation <env>             Select isolation backend (currently env)
  --model <model>               Select the engine model
  --instructions <text>         Add engine-level instructions
  --instructions-file <path>    Read engine-level instructions from a file
  --mcp-command <command>       Inject a session-scoped stdio MCP server
  --mcp-arg <arg>               Add an MCP argument (repeatable)
  --mcp-env <KEY[=VALUE]>       Add/copy MCP environment (repeatable)
  --mcp-name <name>             Set MCP server name (default: enginebay)
  --env <KEY[=VALUE]>           Add/copy child environment (repeatable)
  --git-committer-name <name>   Set isolated git committer name
  -h, --help                    Show these options

Use -- before every native CLI argument.
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
  try {
    const parsed = await parseCliOptions(engineArgs);
    if (parsed.help) {
      io.stdout.write(`${HELP}\n${ENGINE_HELP}`);
      return 0;
    }
    const { help: _help, ...options } = parsed;
    return launch({ engine, ...options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n\n${ENGINE_HELP}`);
    return 2;
  }
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
