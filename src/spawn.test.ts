import { describe, expect, it } from "vitest";
import { spawnLineProcess } from "./spawn.js";

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
