import { readFile } from "node:fs/promises";
import type { LaunchEngineOptions } from "./launch.js";

export type ParsedCliOptions = Omit<
  LaunchEngineOptions,
  "engine" | "hostEnv" | "hostHome"
> & {
  help: boolean;
};

export async function parseCliOptions(
  argv: string[],
  hostEnv: NodeJS.ProcessEnv = process.env,
): Promise<ParsedCliOptions> {
  const separator = argv.indexOf("--");
  const wrapperArgs = separator < 0 ? argv : argv.slice(0, separator);
  const nativeArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const result: ParsedCliOptions = { args: nativeArgs, help: false };
  const mcpArgs: string[] = [];
  const mcpEnv: Record<string, string> = {};
  const extraEnv: Record<string, string> = {};
  let mcpCommand: string | undefined;
  let mcpName: string | undefined;
  let instructions: string | undefined;
  let instructionsFile: string | undefined;
  let committerName: string | undefined;
  let sawMcpOption = false;

  for (let index = 0; index < wrapperArgs.length; index += 1) {
    const token = wrapperArgs[index]!;
    const [name, inlineValue] = splitOption(token);
    const value = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = wrapperArgs[index + 1];
      if (next === undefined) {
        throw new Error(`enginebay: ${name} requires a value`);
      }
      index += 1;
      return next;
    };

    switch (name) {
      case "--help":
      case "-h":
        if (inlineValue !== undefined) {
          throw new Error(`enginebay: ${name} does not take a value`);
        }
        result.help = true;
        break;
      case "--work-dir":
        result.workDir = value();
        break;
      case "--workspace-id":
        result.workspaceId = value();
        break;
      case "--isolation": {
        const kind = value();
        if (kind !== "env") {
          throw new Error(
            `enginebay: isolation ${kind} is not implemented; use "env"`,
          );
        }
        result.isolation = { kind };
        break;
      }
      case "--model":
        result.model = value();
        break;
      case "--instructions":
        instructions = value();
        break;
      case "--instructions-file":
        instructionsFile = value();
        break;
      case "--mcp-command":
        mcpCommand = value();
        sawMcpOption = true;
        break;
      case "--mcp-arg":
        mcpArgs.push(value());
        sawMcpOption = true;
        break;
      case "--mcp-env": {
        const [key, envValue] = parseEnv(value(), hostEnv, "--mcp-env");
        mcpEnv[key] = envValue;
        sawMcpOption = true;
        break;
      }
      case "--mcp-name":
        mcpName = value();
        sawMcpOption = true;
        break;
      case "--env": {
        const [key, envValue] = parseEnv(value(), hostEnv, "--env");
        extraEnv[key] = envValue;
        break;
      }
      case "--git-committer-name":
        committerName = value();
        break;
      default:
        throw new Error(
          `enginebay: unknown option "${token}"; put native CLI arguments after --`,
        );
    }
  }

  if (result.workDir !== undefined && result.workspaceId !== undefined) {
    throw new Error("enginebay: set either --work-dir or --workspace-id, not both");
  }
  if (instructions !== undefined && instructionsFile !== undefined) {
    throw new Error(
      "enginebay: set either --instructions or --instructions-file, not both",
    );
  }
  if (instructionsFile !== undefined) {
    instructions = await readFile(instructionsFile, "utf8");
  }
  if (instructions !== undefined) {
    result.instructions = instructions;
  }
  if (sawMcpOption) {
    if (!mcpCommand || mcpCommand.length === 0) {
      throw new Error(
        "enginebay: --mcp-command is required when using MCP options",
      );
    }
    result.mcp = {
      command: mcpCommand,
      args: mcpArgs,
      env: mcpEnv,
      ...(mcpName ? { name: mcpName } : {}),
    };
  }
  if (Object.keys(extraEnv).length > 0) {
    result.extraEnv = extraEnv;
  }
  if (committerName !== undefined) {
    result.git = { committerName };
  }
  return result;
}

function splitOption(token: string): [name: string, value?: string] {
  const equals = token.indexOf("=");
  return equals < 0
    ? [token]
    : [token.slice(0, equals), token.slice(equals + 1)];
}

function parseEnv(
  input: string,
  hostEnv: NodeJS.ProcessEnv,
  option: string,
): [key: string, value: string] {
  const equals = input.indexOf("=");
  const key = equals < 0 ? input : input.slice(0, equals);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`enginebay: ${option} has invalid environment key "${key}"`);
  }
  if (equals >= 0) {
    return [key, input.slice(equals + 1)];
  }
  const inherited = hostEnv[key];
  if (inherited === undefined) {
    throw new Error(
      `enginebay: ${option} requested unset environment variable "${key}"`,
    );
  }
  return [key, inherited];
}
