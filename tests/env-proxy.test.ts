/**
 * SEC-01 regression (M0.5 audit): with Node's env-proxy mode on, Node tunnels even plain-http
 * loopback requests through HTTP_PROXY. The transport must refuse instead of sending local-model
 * traffic (possibly local_only data) to a proxy.
 *
 * Each case runs in a child process with that environment, against two loopback servers: a fake
 * "local model" and a fake "proxy" that counts every contact. The control case proves the setup is
 * real: plain fetch() in the same environment does reach the proxy.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const httpModule = pathToFileURL(path.resolve("src/net/http.ts")).href;
let proxy: http.Server;
let target: http.Server;
const seen = { proxy: 0, target: 0 };

beforeEach(async () => {
  seen.proxy = 0;
  seen.target = 0;
  proxy = http.createServer((req, res) => {
    seen.proxy++;
    req.resume();
    res.end("via-proxy");
  });
  proxy.on("connect", (_req, socket) => {
    seen.proxy++;
    socket.destroy();
  });
  target = http.createServer((req, res) => {
    seen.target++;
    req.resume();
    res.end("direct");
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
});

afterEach(async () => {
  for (const s of [proxy, target]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const port = (s: http.Server) => (s.address() as AddressInfo).port;

function runChild(code: string, extraEnv: Record<string, string>): Promise<string> {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
    HTTP_PROXY: `http://127.0.0.1:${port(proxy)}`,
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    const kill = setTimeout(() => child.kill(), 15_000);
    child.on("close", () => {
      clearTimeout(kill);
      resolve(out.trim());
    });
  });
}

function amosRequest(url: string): string {
  return [
    `import { HttpClient } from ${JSON.stringify(httpModule)};`,
    "const client = new HttpClient({ timeouts: { headersTimeoutMs: 3000, idleTimeoutMs: 3000, requestTimeoutMs: 5000 }, offline: true });",
    `try { const r = await client.request({ url: ${JSON.stringify(url)} }); console.log("SENT " + (await r.text())); }`,
    'catch (e) { console.log("REFUSED " + e.code + " " + (e.details?.cause ?? "")); }',
  ].join("\n");
}

function plainFetch(url: string): string {
  return [
    `try { const r = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(3000) }); console.log("SENT " + (await r.text())); }`,
    'catch (e) { console.log("FAILED " + (e.cause?.code ?? e.name)); }',
  ].join("\n");
}

// Each case starts a Node child process, and the control case waits out Node's CONNECT retries.
describe("Node env-proxy mode (SEC-01)", { timeout: 20_000 }, () => {
  it("control: in this environment Node really sends loopback traffic to the proxy", async () => {
    await runChild(plainFetch(`http://127.0.0.1:${port(target)}/v1`), { NODE_USE_ENV_PROXY: "1" });
    expect(seen.proxy).toBeGreaterThan(0);
    expect(seen.target).toBe(0);
  });

  it("AMOS's transport refuses before contacting anything", async () => {
    const out = await runChild(amosRequest(`http://127.0.0.1:${port(target)}/v1`), {
      NODE_USE_ENV_PROXY: "1",
    });
    expect(out).toContain("REFUSED NETWORK ENV_PROXY_UNSUPPORTED");
    expect(seen).toEqual({ proxy: 0, target: 0 });
  });

  it("also refuses when the mode comes from NODE_OPTIONS", async () => {
    const out = await runChild(amosRequest(`http://127.0.0.1:${port(target)}/v1`), {
      NODE_OPTIONS: "--use-env-proxy",
    });
    expect(out).toContain("REFUSED NETWORK ENV_PROXY_UNSUPPORTED");
    expect(seen.proxy).toBe(0);
  });

  it("without env-proxy mode, HTTP_PROXY is ignored and loopback goes direct", async () => {
    const out = await runChild(amosRequest(`http://127.0.0.1:${port(target)}/v1`), {});
    expect(out).toBe("SENT direct");
    expect(seen).toEqual({ proxy: 0, target: 1 });
  });
});
