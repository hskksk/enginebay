import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWorkspaceId,
  namedWorkspacePath,
  prepareWorkspace,
  resolveXdgDataHome,
} from "./workspace.js";

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

describe("assertWorkspaceId", () => {
  it("nfc-normalizes, trims, and lowercases", () => {
    expect(assertWorkspaceId("  My-App  ")).toBe("my-app");
    expect(assertWorkspaceId("my-app-ミカ")).toBe("my-app-ミカ");
  });

  it("rejects empty, traversal, and path separators", () => {
    expect(() => assertWorkspaceId("")).toThrow(/1–80/);
    expect(() => assertWorkspaceId("   ")).toThrow(/1–80/);
    expect(() => assertWorkspaceId(".")).toThrow(/invalid/);
    expect(() => assertWorkspaceId("..")).toThrow(/invalid/);
    expect(() => assertWorkspaceId("foo/bar")).toThrow(/single path segment/);
    expect(() => assertWorkspaceId("foo\\bar")).toThrow(/single path segment/);
  });
});

describe("resolveXdgDataHome", () => {
  it("prefers XDG_DATA_HOME then ~/.local/share", () => {
    expect(
      resolveXdgDataHome({ XDG_DATA_HOME: "/custom/share", HOME: "/home/u" }),
    ).toBe("/custom/share");
    expect(resolveXdgDataHome({ HOME: "/home/u" }, "/home/u")).toBe(
      join("/home/u", ".local", "share"),
    );
  });
});

describe("prepareWorkspace", () => {
  it("creates an ephemeral temp dir when id and path are omitted", async () => {
    const workspace = await prepareWorkspace();
    cleanups.push(() =>
      rm(workspace.path, { recursive: true, force: true }),
    );
    expect(workspace.ephemeral).toBe(true);
    expect(workspace.persistent).toBe(false);
    expect(workspace.id).toBeUndefined();
    expect(existsSync(workspace.path)).toBe(true);
    expect(workspace.path).toContain("enginebay-work-");
  });

  it("puts a named workspace under XDG data and keeps files across prepares", async () => {
    const hostHome = await tempDir("enginebay-ws-home-");
    const first = await prepareWorkspace({
      id: "my-app",
      hostHome,
      hostEnv: { HOME: hostHome },
    });
    expect(first).toEqual({
      path: join(hostHome, ".local", "share", "enginebay", "workspaces", "my-app"),
      id: "my-app",
      persistent: true,
      ephemeral: false,
    });
    await writeFile(join(first.path, "keep.txt"), "hello\n", "utf8");

    const second = await prepareWorkspace({
      id: "My-App",
      hostHome,
      hostEnv: { HOME: hostHome },
    });
    expect(second.path).toBe(first.path);
    expect(await readFile(join(second.path, "keep.txt"), "utf8")).toBe(
      "hello\n",
    );
  });

  it("honors XDG_DATA_HOME for named workspaces", async () => {
    const dataHome = await tempDir("enginebay-ws-xdg-");
    const workspace = await prepareWorkspace({
      id: "eval-1",
      hostEnv: { XDG_DATA_HOME: dataHome, HOME: "/unused" },
      hostHome: "/unused",
    });
    expect(workspace.path).toBe(
      join(dataHome, "enginebay", "workspaces", "eval-1"),
    );
  });

  it("mkdirs an explicit path and does not treat it as ephemeral", async () => {
    const root = await tempDir("enginebay-ws-path-");
    const path = join(root, "playground");
    const workspace = await prepareWorkspace({ path });
    expect(workspace).toEqual({
      path,
      persistent: true,
      ephemeral: false,
    });
    expect(existsSync(path)).toBe(true);
  });

  it("rejects setting both path and id", async () => {
    await expect(
      prepareWorkspace({ path: "/tmp/a", id: "x" }),
    ).rejects.toThrow(/path or id, not both/);
  });
});

describe("namedWorkspacePath", () => {
  it("matches prepareWorkspace for the same id", async () => {
    const hostHome = await tempDir("enginebay-ws-named-");
    const hostEnv = { HOME: hostHome };
    expect(namedWorkspacePath("cell-9", hostEnv, hostHome)).toBe(
      join(hostHome, ".local", "share", "enginebay", "workspaces", "cell-9"),
    );
  });
});
