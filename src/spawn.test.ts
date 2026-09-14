import { describe, expect, it } from "vitest";
import { applySpawnAdapter, spawnLineProcess } from "./spawn.js";

function spawnMissing() {
  return spawnLineProcess({
    command: "/definitely-missing-enginebay-cli",
    args: [],
    cwd: process.cwd(),
    env: process.env,
  });
}

describe("spawnLineProcess", () => {
  it("returns from kill without waiting when the child has no pid", async () => {
    const spawned = spawnMissing();
    const started = Date.now();
    await spawned.kill("SIGTERM");
    expect(Date.now() - started).toBeLessThan(1000);
    const result = await spawned.wait();
    expect(result.spawnError).toMatch(/ENOENT/i);
  });

  it("returns from kill without waiting after a spawn error was recorded", async () => {
    const spawned = spawnMissing();
    const result = await spawned.wait();
    expect(result.spawnError).toMatch(/ENOENT/i);
    const started = Date.now();
    await spawned.kill("SIGTERM");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("applySpawnAdapter", () => {
  it("rewrites --dir and XDG_DATA_HOME then calls spawn", () => {
    let seen: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
    applySpawnAdapter(
      {
        mapPath: (path) => `${path}/mapped`,
        spawn: (req) => {
          seen = { args: req.args, env: req.env };
          return spawnMissing();
        },
      },
      {
        command: "opencode",
        args: ["run", "--dir", "/tmp/work", "go"],
        cwd: "/tmp/work",
        env: { XDG_DATA_HOME: "/tmp/data", HOME: "/tmp/home" },
      },
    );
    expect(seen?.args[seen.args.indexOf("--dir") + 1]).toBe("/tmp/work/mapped");
    expect(seen?.env.XDG_DATA_HOME).toBe("/tmp/data/mapped");
    expect(seen?.env.HOME).toBe("/tmp/home/mapped");
  });
});
