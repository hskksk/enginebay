import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { writeIsolatedGitconfig } from "./gitconfig.js";

describe("writeIsolatedGitconfig", () => {
  it("uses a generic enginebay committer email and HTTPS insteadOf", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enginebay-gitconfig-"));
    const path = join(dir, ".gitconfig");
    await writeIsolatedGitconfig(path, {
      token: "ghs_secret",
      committerName: "bay-bot",
    });
    const text = await readFile(path, "utf8");
    expect(text).toContain("name = bay-bot");
    expect(text).toContain("email = enginebay@users.noreply.github.com");
    expect(text).toContain("https://x-access-token:ghs_secret@github.com/");
    expect(text).not.toMatch(/email = (?!enginebay@users\.noreply\.github\.com)/);
  });
});
