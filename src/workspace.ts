import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { resolveHostHome } from "./env.js";

export const WORKSPACE_ID_MAX_LENGTH = 80;

export type PrepareWorkspaceInput = {
  /** Named persistent workspace. Stored under XDG data. */
  id?: string;
  /** Explicit directory. Consumer-owned; never deleted by enginebay. */
  path?: string;
  hostEnv?: NodeJS.ProcessEnv;
  hostHome?: string;
};

export type PreparedWorkspace = {
  path: string;
  /** Set when this is a named XDG workspace. */
  id?: string;
  /** Survives `close()`. */
  persistent: boolean;
  /** `close()` / `discardWorkspace` deletes the directory. */
  ephemeral: boolean;
};

/**
 * Validate a workspace id. IDs are a single path segment, NFC, lowercased.
 * Unicode is allowed so ids like `my-app-ミカ` work.
 */
export function assertWorkspaceId(id: string): string {
  const normalized = id.normalize("NFC").trim().toLowerCase();
  if (normalized.length < 1 || normalized.length > WORKSPACE_ID_MAX_LENGTH) {
    throw new Error(
      `enginebay: workspace id must be 1–${WORKSPACE_ID_MAX_LENGTH} characters`,
    );
  }
  if (normalized === "." || normalized === "..") {
    throw new Error("enginebay: workspace id is invalid");
  }
  if (/[\\/\x00-\x1f]/.test(normalized)) {
    throw new Error("enginebay: workspace id must be a single path segment");
  }
  return normalized;
}

export function resolveXdgDataHome(
  hostEnv: NodeJS.ProcessEnv = process.env,
  hostHome?: string,
): string {
  const xdg = hostEnv.XDG_DATA_HOME;
  if (typeof xdg === "string" && xdg.length > 0) {
    return xdg;
  }
  return join(resolveHostHome(hostEnv, hostHome), ".local", "share");
}

export function namedWorkspacePath(
  id: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
  hostHome?: string,
): string {
  const safeId = assertWorkspaceId(id);
  const root = resolve(
    join(resolveXdgDataHome(hostEnv, hostHome), "enginebay", "workspaces"),
  );
  const dest = resolve(join(root, safeId));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!dest.startsWith(prefix)) {
    throw new Error("enginebay: workspace id escaped the workspace root");
  }
  return dest;
}

export async function prepareWorkspace(
  input: PrepareWorkspaceInput = {},
): Promise<PreparedWorkspace> {
  if (input.path !== undefined && input.id !== undefined) {
    throw new Error("enginebay: set either workspace path or id, not both");
  }
  const hostEnv = input.hostEnv ?? process.env;
  if (input.path !== undefined) {
    if (input.path.length === 0) {
      throw new Error("enginebay: workspace path is empty");
    }
    await mkdir(input.path, { recursive: true });
    return {
      path: input.path,
      persistent: true,
      ephemeral: false,
    };
  }
  if (input.id !== undefined) {
    const id = assertWorkspaceId(input.id);
    const path = namedWorkspacePath(id, hostEnv, input.hostHome);
    await mkdir(path, { recursive: true, mode: 0o700 });
    return {
      path,
      id,
      persistent: true,
      ephemeral: false,
    };
  }
  const path = await mkdtemp(join(tmpdir(), "enginebay-work-"));
  return {
    path,
    persistent: false,
    ephemeral: true,
  };
}

/** Delete an ephemeral workspace. Named and explicit paths are left alone. */
export async function discardWorkspace(
  workspace: PreparedWorkspace,
): Promise<void> {
  if (!workspace.ephemeral) {
    return;
  }
  await rm(workspace.path, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
