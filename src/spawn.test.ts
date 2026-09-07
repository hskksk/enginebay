import { describe, expect, it } from "vitest";
import { spawnLineProcess } from "./spawn.js";

describe("spawnLineProcess", () => {
  it("returns from kill without waiting when spawn fails with ENOENT", async () => {
    const spawned = spawnLineProcess({
      command: "/definitely-missing-enginebay-cli",
      args: [],
      cwd: process.cwd(),
      env: process.env,
    });
    const started = Date.now();
    await spawned.kill("SIGTERM");
    expect(Date.now() - started).toBeLessThan(1000);
    const result = await spawned.wait();
    expect(result.spawnError).toMatch(/ENOENT/i);
  });
});
