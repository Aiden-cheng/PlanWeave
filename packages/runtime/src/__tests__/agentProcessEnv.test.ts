import { describe, expect, it } from "vitest";
import {
  agentProcessEnv,
  agentProcessPath,
  setAgentProcessEnvironmentOverlay
} from "../process/agentProcessEnv.js";

describe("agentProcessEnv", () => {
  it("adds common user-level agent install paths on POSIX", () => {
    expect(
      agentProcessPath({
        envPath: "/usr/bin:/bin",
        platform: "darwin",
        env: { HOME: "/Users/example" }
      }).split(":")
    ).toEqual(
      expect.arrayContaining([
        "/Users/example/.local/bin",
        "/Users/example/.grok/bin",
        "/Users/example/.opencode/bin",
        "/Users/example/.bun/bin",
        "/Users/example/.volta/bin",
        "/Users/example/Library/pnpm"
      ])
    );
  });

  it("uses POSIX delimiters and Homebrew fallbacks", () => {
    const entries = agentProcessPath("/usr/bin:/bin", "darwin").split(":");
    expect(entries.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(entries).toEqual(expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin"]));
  });

  it("adds common user-level agent install paths on Windows", () => {
    expect(
      agentProcessPath({
        envPath: String.raw`C:\Windows\System32`,
        platform: "win32",
        env: {
          USERPROFILE: String.raw`C:\Users\dev`,
          APPDATA: String.raw`C:\Users\dev\AppData\Roaming`,
          LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`
        }
      }).split(";")
    ).toEqual(
      expect.arrayContaining([
        String.raw`C:\Windows\System32`,
        String.raw`C:\Users\dev\AppData\Roaming\npm`,
        String.raw`C:\Users\dev\AppData\Local\pnpm`,
        String.raw`C:\Users\dev\.local\bin`,
        String.raw`C:\Users\dev\.grok\bin`
      ])
    );
  });

  it("uses Windows delimiters and keeps existing Path entries first", () => {
    expect(
      agentProcessPath({
        envPath: String.raw`C:\Tools;C:\Users\dev\AppData\Roaming\npm`,
        platform: "win32",
        env: {
          USERPROFILE: String.raw`C:\Users\dev`,
          APPDATA: String.raw`C:\Users\dev\AppData\Roaming`,
          LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`
        }
      }).split(";")
    ).toEqual(
      expect.arrayContaining([
        String.raw`C:\Tools`,
        String.raw`C:\Users\dev\AppData\Roaming\npm`,
        String.raw`C:\Users\dev\AppData\Local\pnpm`
      ])
    );
  });

  it("collapses Path/PATH on Windows while keeping user install fallbacks", () => {
    const env = agentProcessEnv({
      platform: "win32",
      env: {
        Path: String.raw`C:\Tools`,
        PATH: "should-not-survive",
        USERPROFILE: String.raw`C:\Users\dev`,
        APPDATA: String.raw`C:\Users\dev\AppData\Roaming`,
        LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`
      }
    });
    expect(env.Path?.split(";")[0]).toBe(String.raw`C:\Tools`);
    expect(env.Path?.split(";")).toEqual(
      expect.arrayContaining([String.raw`C:\Users\dev\AppData\Roaming\npm`])
    );
    expect(env.PATH).toBeUndefined();
  });

  it("merges a configured desktop shell environment into every agent process", () => {
    setAgentProcessEnvironmentOverlay({
      PATH: "/Users/example/.nvm/versions/node/v24/bin:/usr/bin:/bin",
      PLANWEAVE_TEST_AGENT_TOKEN: "configured-in-login-shell"
    });
    try {
      const env = agentProcessEnv({ platform: "darwin" });

      expect(env.PATH?.split(":")).toContain("/Users/example/.nvm/versions/node/v24/bin");
      expect(env.PLANWEAVE_TEST_AGENT_TOKEN).toBe("configured-in-login-shell");
    } finally {
      setAgentProcessEnvironmentOverlay(null);
    }
  });
});
