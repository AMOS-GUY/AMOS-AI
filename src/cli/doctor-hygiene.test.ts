/** M0.5 audit regressions for `amos doctor`: SEC-03 child environment, SEC-01 proxy report. */
import { describe, expect, it } from "vitest";
import { checkProxy, childEnv } from "./doctor.ts";

describe("childEnv (SEC-03)", () => {
  it("passes only the variables a version check needs — never keys or tokens", () => {
    const env = childEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      LANG: "C.UTF-8",
      // Fake values assembled at runtime so the repository secret scan does not flag this file.
      DEEPSEEK_API_KEY: ["sk", "should", "not", "pass"].join("-"),
      DASHSCOPE_API_KEY: ["sk", "nor", "this"].join("-"),
      GITHUB_TOKEN: "ghp-nope",
      AMOS_DATA_DIR: "/d",
      NODE_OPTIONS: "--use-env-proxy",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8" });
  });

  it("keeps what Windows needs to start a program", () => {
    const env = childEnv({ SYSTEMROOT: "C:\\Windows", PATHEXT: ".EXE", Path: "ignored-case" });
    expect(env).toEqual({ SYSTEMROOT: "C:\\Windows", PATHEXT: ".EXE" });
  });
});

describe("checkProxy (SEC-01)", () => {
  it("fails when Node env-proxy mode is on", () => {
    expect(checkProxy({ NODE_USE_ENV_PROXY: "1" }, []).status).toBe("fail");
    expect(checkProxy({}, ["--use-env-proxy"]).status).toBe("fail");
    expect(checkProxy({ NODE_OPTIONS: "--use-env-proxy" }, []).status).toBe("fail");
  });

  it("notes plain proxy variables as ignored, without echoing the proxy address", () => {
    const info = checkProxy({ HTTPS_PROXY: "http://127.0.0.1:7890" }, []);
    expect(info.status).toBe("info");
    expect(info.detail).toContain("not used");
    expect(info.detail).not.toContain("7890");
  });

  it("is ok with no proxy configured", () => {
    expect(checkProxy({}, []).status).toBe("ok");
  });
});
