import type { AmosConfig } from "../config/schema.ts";
import { type EgressClearance, verifyClearance } from "../core/egress-gate.ts";
import { AmosError } from "../core/errors.ts";

/**
 * The only outbound HTTP path in AMOS (M0.1 F4; enforced by tests/boundaries.test.ts).
 *
 * Guarantees (all tested against a loopback server):
 *  - headersTimeoutMs: time from sending until response headers arrive. Covers DNS, TCP connect,
 *    TLS and server think-time. (Node's built-in fetch cannot time "connect" separately without the
 *    undici package, so AMOS does not offer that setting.)
 *  - idleTimeoutMs: longest silence between two body chunks while the body is read.
 *  - requestTimeoutMs: hard limit for the whole exchange, including reading the body.
 *  - Caller cancellation via AbortSignal, reported separately from timeouts.
 *  - Errors are distinguishable by code: NETWORK_TIMEOUT (details.phase = headers | idle | total),
 *    NETWORK_CANCELLED, NETWORK_OFFLINE, NETWORK (transport failure; details.cause = errno code).
 *  - Request bodies are only sent if they come from a genuine EgressClearance whose origin matches
 *    the URL; anything but GET requires one. Redirects are refused (a redirect could re-send a
 *    cleared body to another host).
 *  - offline mode permits loopback only; plain http:// is permitted to loopback only.
 *
 * Not guaranteed: timing accuracy finer than the event loop allows (timers can fire late under
 * heavy CPU load), and DNS lookups already in progress are not interrupted by the OS — the request
 * fails at the deadline, but the lookup itself may finish later in the background.
 */

export interface HttpTimeouts {
  readonly headersTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export interface HttpClientOptions {
  readonly timeouts: HttpTimeouts;
  readonly offline: boolean;
  /** Bodies larger than this are aborted with NETWORK (details.cause = "TOO_LARGE"). */
  readonly maxResponseBytes?: number;
}

export interface HttpRequest {
  readonly url: string | URL;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  /** Only a clearance from EgressGate can be sent; the transport sends exactly its bytes. */
  readonly body?: EgressClearance;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Read the body chunk by chunk (once). Enforces idle/total timeouts and the size limit. */
  chunks(): AsyncGenerator<Uint8Array, void, undefined>;
  /** Read the whole body as UTF-8 text. */
  text(): Promise<string>;
  /** Stop reading and release the connection and timers. Safe to call more than once. */
  close(): void;
}

type AbortPhase = "headers" | "idle" | "total" | "cancelled" | "too_large" | "closed";

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

export class HttpClient {
  readonly #timeouts: HttpTimeouts;
  readonly #offline: boolean;
  readonly #maxBytes: number;

  constructor(options: HttpClientOptions) {
    const t = options.timeouts;
    for (const [name, value] of Object.entries(t)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new AmosError("CONFIG_INVALID", `${name} must be a positive number of milliseconds.`);
      }
    }
    this.#timeouts = { ...t };
    this.#offline = options.offline;
    this.#maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new AmosError("NETWORK", `Unsupported protocol ${url.protocol}`);
    }
    const loopback = isLoopbackHost(url.hostname);
    if (this.#offline && !loopback) {
      throw new AmosError("NETWORK_OFFLINE", `Offline mode: not contacting ${url.host}.`, {
        hint: "Set network.offline: false (or unset AMOS_OFFLINE) to allow network access.",
      });
    }
    if (url.protocol === "http:" && !loopback) {
      throw new AmosError("NETWORK", `Refusing plain http:// to ${url.host}; use https://.`);
    }

    const method = req.method ?? (req.body === undefined ? "GET" : "POST");
    const headers = new Headers(req.headers);
    let body: string | undefined;
    if (req.body !== undefined) {
      const clearance = verifyClearance(req.body, url);
      body = clearance.body;
      headers.set("content-type", clearance.contentType);
    } else if (method !== "GET") {
      throw new AmosError(
        "PRIVACY_VIOLATION",
        "Only GET requests may be sent without an egress clearance.",
      );
    }
    if (req.signal?.aborted) {
      throw new AmosError("NETWORK_CANCELLED", "The request was cancelled before it started.");
    }

    // One controller aborts fetch and the body stream; `phase` records why, so errors can be told apart.
    const controller = new AbortController();
    let phase: AbortPhase | undefined;
    const abort = (p: AbortPhase) => {
      if (phase === undefined) {
        phase = p;
        controller.abort();
      }
    };
    const timers = new Set<NodeJS.Timeout>();
    const startTimer = (ms: number, p: AbortPhase) => {
      const t = setTimeout(() => abort(p), ms);
      t.unref();
      timers.add(t);
      return t;
    };
    const onCancel = () => abort("cancelled");
    req.signal?.addEventListener("abort", onCancel, { once: true });
    const cleanup = () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      req.signal?.removeEventListener("abort", onCancel);
    };
    const fail = (error: unknown) => {
      cleanup();
      return this.#classify(error, phase, url);
    };

    startTimer(this.#timeouts.requestTimeoutMs, "total");
    const headersTimer = startTimer(this.#timeouts.headersTimeoutMs, "headers");
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ?? null,
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      throw fail(error);
    }
    clearTimeout(headersTimer);
    timers.delete(headersTimer);

    let consumed = false;
    const maxBytes = this.#maxBytes;
    const idleMs = this.#timeouts.idleTimeoutMs;
    const close = () => {
      abort("closed");
      cleanup();
    };

    async function* chunks(): AsyncGenerator<Uint8Array, void, undefined> {
      if (consumed) throw new AmosError("NETWORK", "The response body was already read.");
      consumed = true;
      const reader = response.body?.getReader();
      if (!reader) {
        cleanup();
        return;
      }
      let received = 0;
      let idleTimer: NodeJS.Timeout | undefined;
      try {
        for (;;) {
          if (idleTimer) {
            clearTimeout(idleTimer);
            timers.delete(idleTimer);
          }
          idleTimer = startTimer(idleMs, "idle");
          let result: Awaited<ReturnType<typeof reader.read>>;
          try {
            result = await reader.read();
          } catch (error) {
            throw fail(error);
          }
          if (phase !== undefined && phase !== "closed") throw fail(new Error("aborted"));
          if (result.done) return;
          received += result.value.byteLength;
          if (received > maxBytes) {
            abort("too_large");
            throw fail(new Error("response too large"));
          }
          yield result.value;
        }
      } finally {
        cleanup();
        reader.cancel().catch(() => {});
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      chunks,
      async text() {
        const decoder = new TextDecoder();
        let out = "";
        for await (const chunk of chunks()) out += decoder.decode(chunk, { stream: true });
        return out + decoder.decode();
      },
      close,
    };
  }

  #classify(error: unknown, phase: AbortPhase | undefined, url: URL): AmosError {
    if (error instanceof AmosError) return error;
    const target = { host: url.host };
    switch (phase) {
      case "cancelled":
      case "closed":
        return new AmosError("NETWORK_CANCELLED", "The request was cancelled.", {
          details: target,
        });
      case "headers":
      case "idle":
      case "total": {
        const ms =
          phase === "headers"
            ? this.#timeouts.headersTimeoutMs
            : phase === "idle"
              ? this.#timeouts.idleTimeoutMs
              : this.#timeouts.requestTimeoutMs;
        return new AmosError("NETWORK_TIMEOUT", `${url.host} timed out (${phase}, ${ms} ms).`, {
          details: { ...target, phase, timeoutMs: ms },
        });
      }
      case "too_large":
        return new AmosError(
          "NETWORK",
          `Response from ${url.host} exceeded ${this.#maxBytes} bytes.`,
          {
            details: { ...target, cause: "TOO_LARGE" },
          },
        );
      default: {
        const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
        const code =
          cause?.code ?? (/redirect/i.test(cause?.message ?? "") ? "REDIRECT_REFUSED" : "UNKNOWN");
        return new AmosError("NETWORK", `Request to ${url.host} failed (${code}).`, {
          details: { ...target, cause: code },
          cause: error,
        });
      }
    }
  }
}

/** The transport configured from validated settings (network.* in config.yaml). */
export function httpClientFromConfig(config: AmosConfig): HttpClient {
  const { headersTimeoutMs, idleTimeoutMs, requestTimeoutMs, offline } = config.network;
  return new HttpClient({
    timeouts: { headersTimeoutMs, idleTimeoutMs, requestTimeoutMs },
    offline,
  });
}
