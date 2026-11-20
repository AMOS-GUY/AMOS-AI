/**
 * F4 regression tests: the transport enforces the timeouts it promises, tells timeouts, cancellation
 * and failures apart, and only sends bodies that passed the egress gate.
 *
 * Uses a loopback-only test server on an ephemeral port, closed after each test.
 */
import { getEventListeners } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EgressGate } from "../core/egress-gate.ts";
import { AmosError } from "../core/errors.ts";
import { HttpClient, type HttpTimeouts, isLoopbackHost } from "./http.ts";

let server: http.Server | undefined;
let requestsSeen = 0;

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

async function serve(): Promise<string> {
  requestsSeen = 0;
  server = http.createServer((req, res) => {
    requestsSeen++;
    const path = req.url ?? "/";
    if (path === "/ok") {
      res.end("hello");
    } else if (path === "/never") {
      // never answers
    } else if (path === "/stall") {
      res.writeHead(200);
      res.write("first chunk");
      // …then silence
    } else if (path === "/trickle") {
      res.writeHead(200);
      const t = setInterval(() => res.write("."), 40);
      res.on("close", () => clearInterval(t));
    } else if (path === "/redirect") {
      res.writeHead(302, { location: "/ok" }).end();
    } else if (path === "/big") {
      res.end(Buffer.alloc(300 * 1024, 97));
    } else if (path === "/echo") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () =>
        res.end(JSON.stringify({ method: req.method, type: req.headers["content-type"], body })),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const fast: HttpTimeouts = { headersTimeoutMs: 300, idleTimeoutMs: 300, requestTimeoutMs: 2_000 };
const client = (timeouts: Partial<HttpTimeouts> = {}, offline = false, maxResponseBytes?: number) =>
  new HttpClient({
    timeouts: { ...fast, ...timeouts },
    offline,
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  });

async function failure(promise: Promise<unknown>): Promise<AmosError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AmosError);
    return error as AmosError;
  }
  throw new Error("expected the request to fail");
}

describe("HttpClient — timeouts", () => {
  it("returns status and body for a normal response", async () => {
    const base = await serve();
    const res = await client().request({ url: `${base}/ok` });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  it("enforces headersTimeoutMs when the server never answers", async () => {
    const base = await serve();
    const started = Date.now();
    const e = await failure(client({ headersTimeoutMs: 200 }).request({ url: `${base}/never` }));
    expect(e.code).toBe("NETWORK_TIMEOUT");
    expect(e.details).toMatchObject({ phase: "headers", timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("enforces idleTimeoutMs when the body stalls after the first chunk", async () => {
    const base = await serve();
    const res = await client({ idleTimeoutMs: 200 }).request({ url: `${base}/stall` });
    const seen: string[] = [];
    const e = await failure(
      (async () => {
        for await (const chunk of res.chunks()) seen.push(Buffer.from(chunk).toString());
      })(),
    );
    expect(seen.join("")).toBe("first chunk");
    expect(e.code).toBe("NETWORK_TIMEOUT");
    expect(e.details).toMatchObject({ phase: "idle" });
  });

  it("enforces requestTimeoutMs even while data keeps trickling in", async () => {
    const base = await serve();
    const res = await client({ idleTimeoutMs: 300, requestTimeoutMs: 500 }).request({
      url: `${base}/trickle`,
    });
    const e = await failure(res.text());
    expect(e.code).toBe("NETWORK_TIMEOUT");
    expect(e.details).toMatchObject({ phase: "total", timeoutMs: 500 });
  });
});

describe("HttpClient — cancellation and failures are distinguishable", () => {
  it("reports caller cancellation while waiting for headers as NETWORK_CANCELLED", async () => {
    const base = await serve();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const e = await failure(
      client({ headersTimeoutMs: 5_000 }).request({ url: `${base}/never`, signal: ac.signal }),
    );
    expect(e.code).toBe("NETWORK_CANCELLED");
  });

  it("reports cancellation while reading the body as NETWORK_CANCELLED", async () => {
    const base = await serve();
    const ac = new AbortController();
    const res = await client({ idleTimeoutMs: 5_000 }).request({
      url: `${base}/stall`,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    expect((await failure(res.text())).code).toBe("NETWORK_CANCELLED");
  });

  it("does not start a request whose signal is already aborted", async () => {
    const base = await serve();
    const e = await failure(client().request({ url: `${base}/ok`, signal: AbortSignal.abort() }));
    expect(e.code).toBe("NETWORK_CANCELLED");
    expect(requestsSeen).toBe(0);
  });

  it("reports a refused connection as NETWORK with the errno code", async () => {
    const base = await serve();
    const port = new URL(base).port;
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const e = await failure(client().request({ url: `http://127.0.0.1:${port}/ok` }));
    expect(e.code).toBe("NETWORK");
    expect(e.details).toMatchObject({ cause: "ECONNREFUSED" });
  });

  it("refuses redirects instead of following them", async () => {
    const base = await serve();
    const e = await failure(client().request({ url: `${base}/redirect` }));
    expect(e.code).toBe("NETWORK");
    expect(requestsSeen).toBe(1); // /ok was never requested
  });

  it("aborts responses larger than the limit", async () => {
    const base = await serve();
    const res = await client({}, false, 100 * 1024).request({ url: `${base}/big` });
    const e = await failure(res.text());
    expect(e.code).toBe("NETWORK");
    expect(e.details).toMatchObject({ cause: "TOO_LARGE" });
  });

  it("can be closed early without leaking timers or throwing", async () => {
    const base = await serve();
    const res = await client().request({ url: `${base}/stall` });
    res.close();
    res.close();
  });
});

describe("HttpClient — network policy", () => {
  it("refuses non-loopback hosts in offline mode without sending anything", async () => {
    const e = await failure(client({}, true).request({ url: "https://example.com/" }));
    expect(e.code).toBe("NETWORK_OFFLINE");
  });

  it("still reaches loopback (local models) in offline mode", async () => {
    const base = await serve();
    expect((await client({}, true).request({ url: `${base}/ok` })).status).toBe(200);
  });

  it("refuses plain http to non-loopback hosts", async () => {
    const e = await failure(client().request({ url: "http://example.com/" }));
    expect(e.code).toBe("NETWORK");
    expect(e.message).toContain("https");
  });

  it("recognises loopback hosts precisely", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.10.0.3")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("127.0.0.1.evil.test")).toBe(false);
    expect(isLoopbackHost("localhost.evil.test")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });

  it("rejects invalid timeout values", () => {
    expect(
      () => new HttpClient({ timeouts: { ...fast, idleTimeoutMs: 0 }, offline: false }),
    ).toThrow(AmosError);
    expect(
      () => new HttpClient({ timeouts: { ...fast, requestTimeoutMs: Number.NaN }, offline: false }),
    ).toThrow(AmosError);
  });
});

describe("HttpClient — only cleared bodies leave", () => {
  it("sends exactly the clearance body with its content type", async () => {
    const base = await serve();
    const gate = new EgressGate([
      {
        providerId: "local",
        location: "local",
        enabled: true,
        allowPersonalData: true,
        origin: base,
      },
    ]);
    const clearance = gate.authorizeForProvider(
      "local",
      [{ label: "local_only", content: "notes" }],
      (c) => ({
        messages: c,
      }),
    );
    const res = await client().request({ url: `${base}/echo`, body: clearance });
    expect(JSON.parse(await res.text())).toEqual({
      method: "POST",
      type: "application/json",
      body: '{"messages":["notes"]}',
    });
  });

  it("refuses a forged body and non-GET requests without a clearance, before connecting", async () => {
    const base = await serve();
    const forged = {
      providerId: "local",
      origin: base,
      label: "public",
      body: "{}",
      contentType: "application/json",
    };
    expect(
      (await failure(client().request({ url: `${base}/echo`, body: forged as never }))).code,
    ).toBe("PRIVACY_VIOLATION");
    expect((await failure(client().request({ url: `${base}/echo`, method: "POST" }))).code).toBe(
      "PRIVACY_VIOLATION",
    );
    expect(requestsSeen).toBe(0);
  });

  it("refuses a clearance issued for a different origin, before connecting", async () => {
    const base = await serve();
    const gate = new EgressGate([
      {
        providerId: "elsewhere",
        location: "local",
        enabled: true,
        allowPersonalData: true,
        origin: "http://127.0.0.1:1",
      },
    ]);
    const clearance = gate.authorizeForProvider(
      "elsewhere",
      [{ label: "local_only", content: "x" }],
      (c) => c,
    );
    expect((await failure(client().request({ url: `${base}/echo`, body: clearance }))).code).toBe(
      "PRIVACY_VIOLATION",
    );
    expect(requestsSeen).toBe(0);
  });
});

describe("HttpClient — resource cleanup", () => {
  it("removes its listener from the caller's signal when a timeout fires on an unread body", async () => {
    const base = await serve();
    const ac = new AbortController();
    await client({ requestTimeoutMs: 300 }).request({ url: `${base}/stall`, signal: ac.signal });
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 450)); // body never read; total timeout fires
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });

  it("removes its listener after a normal response is read", async () => {
    const base = await serve();
    const ac = new AbortController();
    const res = await client().request({ url: `${base}/ok`, signal: ac.signal });
    await res.text();
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });
});
