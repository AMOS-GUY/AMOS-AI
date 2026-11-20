/** M0.5 audit regressions for the transport: SEC-01 detection and SEC-04 URL credentials. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AmosError } from "../core/errors.ts";
import { envProxyActive, HttpClient } from "./http.ts";

let server: http.Server | undefined;
let requestsSeen = 0;

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server?.close(() => r()));
  server = undefined;
});

async function serve(): Promise<string> {
  requestsSeen = 0;
  server = http.createServer((_req, res) => {
    requestsSeen++;
    res.end("ok");
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const client = () =>
  new HttpClient({
    timeouts: { headersTimeoutMs: 2000, idleTimeoutMs: 2000, requestTimeoutMs: 4000 },
    offline: false,
  });

async function failure(p: Promise<unknown>): Promise<AmosError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(AmosError);
    return error as AmosError;
  }
  throw new Error("expected failure");
}

describe("envProxyActive (SEC-01)", () => {
  it("detects every way of switching Node's env-proxy mode on", () => {
    expect(envProxyActive({}, [])).toBe(false);
    expect(envProxyActive({ NODE_USE_ENV_PROXY: "" }, [])).toBe(false);
    expect(envProxyActive({ NODE_USE_ENV_PROXY: "0" }, [])).toBe(false);
    expect(envProxyActive({ NODE_USE_ENV_PROXY: "false" }, [])).toBe(false);
    expect(envProxyActive({ NODE_USE_ENV_PROXY: "1" }, [])).toBe(true);
    expect(envProxyActive({ NODE_USE_ENV_PROXY: "true" }, [])).toBe(true);
    expect(envProxyActive({}, ["--use-env-proxy"])).toBe(true);
    expect(envProxyActive({ NODE_OPTIONS: "--max-old-space-size=512 --use-env-proxy" }, [])).toBe(
      true,
    );
    expect(envProxyActive({ NODE_OPTIONS: "--use-env-proxy-not-really" }, [])).toBe(false);
    // Plain proxy variables do not switch Node's fetch to a proxy.
    expect(envProxyActive({ HTTP_PROXY: "http://p:1", HTTPS_PROXY: "http://p:1" }, [])).toBe(false);
  });

  it("makes the transport refuse requests, without connecting", async () => {
    const base = await serve();
    const before = process.env["NODE_USE_ENV_PROXY"];
    process.env["NODE_USE_ENV_PROXY"] = "1";
    try {
      const e = await failure(client().request({ url: `${base}/ok` }));
      expect(e.code).toBe("NETWORK");
      expect(e.details).toMatchObject({ cause: "ENV_PROXY_UNSUPPORTED" });
      expect(requestsSeen).toBe(0);
    } finally {
      if (before === undefined) delete process.env["NODE_USE_ENV_PROXY"];
      else process.env["NODE_USE_ENV_PROXY"] = before;
    }
    expect((await client().request({ url: `${base}/ok` })).status).toBe(200);
  });
});

describe("URL credentials (SEC-04)", () => {
  it("refuses URLs with embedded credentials, without echoing them or connecting", async () => {
    const base = await serve();
    const withCreds = base.replace("http://", "http://user:hunter2-pass@");
    const e = await failure(client().request({ url: `${withCreds}/ok` }));
    expect(e.message).toContain("embedded credentials");
    expect(JSON.stringify({ m: e.message, d: e.details, h: e.hint })).not.toContain("hunter2-pass");
    expect(requestsSeen).toBe(0);
  });
});
