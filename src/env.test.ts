import { describe, expect, it } from "vitest";
import { assertProductExtraEnv, buildChildEnv, extraEnvGitToken, extraEnvHasGitToken } from "./env.js";

describe("buildChildEnv", () => {
  it("strips host GitHub tokens, then extraEnv, then isolation overrides", () => {
    const env = buildChildEnv({
      hostEnv: {
        PATH: "/bin",
        GH_TOKEN: "github_pat_host",
        GITHUB_TOKEN: "host-other",
        KEEP: "yes",
      },
      extraEnv: { GH_TOKEN: "ghs_minted", HOME: "/tmp/hijack" },
      overrides: { HOME: "/tmp/isolated" },
    });
    expect(env.KEEP).toBe("yes");
    expect(env.HOME).toBe("/tmp/isolated");
    expect(env.GH_TOKEN).toBe("ghs_minted");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  it("drops host tokens when extraEnv has none", () => {
    const env = buildChildEnv({
      hostEnv: { GH_TOKEN: "github_pat_host", PATH: "/bin" },
      overrides: {},
    });
    expect(env.GH_TOKEN).toBeUndefined();
  });
});

describe("extraEnv git tokens", () => {
  it("reads GH_TOKEN or GITHUB_TOKEN", () => {
    expect(extraEnvHasGitToken({ GH_TOKEN: "ghs_a" })).toBe(true);
    expect(extraEnvGitToken({ GITHUB_TOKEN: "ghs_b" })).toBe("ghs_b");
    expect(extraEnvHasGitToken({ GH_TOKEN: "" })).toBe(false);
    expect(extraEnvGitToken(undefined)).toBeUndefined();
  });
});

describe("assertProductExtraEnv", () => {
  it("rejects HOME and XDG keys", () => {
    expect(() =>
      assertProductExtraEnv({ XDG_DATA_HOME: "/tmp/hijack" }),
    ).toThrow(/extraEnv must not set XDG_DATA_HOME/);
  });

  it("rejects OPENCODE_CONFIG_CONTENT when asked", () => {
    expect(() =>
      assertProductExtraEnv(
        { OPENCODE_CONFIG_CONTENT: "{}" },
        { rejectConfigContent: true },
      ),
    ).toThrow(/OPENCODE_CONFIG_CONTENT/);
  });
});
