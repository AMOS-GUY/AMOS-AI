/**
 * Network reachability probe for the target laptop (ROADMAP M0).
 *
 * Measures, for each endpoint: DNS resolution, time to response headers and HTTP status. It sends
 * NO credentials and NO personal data — plain unauthenticated GET requests, so an API answering
 * 401/404 still counts as "reachable". Self-contained (Node built-ins only) so it can be copied to
 * the laptop and run with a bare Node 24 install:
 *
 *   node scripts/probe-connectivity.ts [--json report.json] [--timeout 8000] [--targets file.json]
 *
 * Results from a machine with a VPN say nothing about the laptop. Run it on the laptop, without a
 * VPN, and record the output in docs/STATUS.md.
 */
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import { parseArgs } from "node:util";

export interface Target {
  readonly name: string;
  readonly url: string;
  readonly purpose: string;
}

export const DEFAULT_TARGETS: readonly Target[] = [
  { name: "npm registry", url: "https://registry.npmjs.org/", purpose: "packages" },
  {
    name: "npmmirror registry",
    url: "https://registry.npmmirror.com/",
    purpose: "packages (CN mirror)",
  },
  { name: "nodejs.org", url: "https://nodejs.org/dist/index.json", purpose: "Node.js downloads" },
  { name: "github.com", url: "https://github.com/", purpose: "source, releases" },
  { name: "api.github.com", url: "https://api.github.com/", purpose: "GitHub API" },
  { name: "pypi.org", url: "https://pypi.org/simple/", purpose: "Python packages" },
  {
    name: "tuna pypi mirror",
    url: "https://pypi.tuna.tsinghua.edu.cn/simple/",
    purpose: "Python packages (CN mirror)",
  },
  { name: "DeepSeek API", url: "https://api.deepseek.com/", purpose: "model provider" },
  {
    name: "Model Studio (CN)",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
    purpose: "model provider (Qwen)",
  },
  {
    name: "Model Studio (intl)",
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    purpose: "model provider (Qwen)",
  },
  {
    name: "Anthropic API",
    url: "https://api.anthropic.com/",
    purpose: "model provider (only where supported)",
  },
  {
    name: "Ollama registry",
    url: "https://registry.ollama.ai/v2/",
    purpose: "local model downloads",
  },
  { name: "ModelScope", url: "https://www.modelscope.cn/", purpose: "model files (CN)" },
  { name: "Hugging Face", url: "https://huggingface.co/", purpose: "model files" },
  {
    name: "Tailscale control",
    url: "https://controlplane.tailscale.com/",
    purpose: "remote access (M5)",
  },
  { name: "local Ollama", url: "http://127.0.0.1:11434/api/version", purpose: "local models" },
];

export interface ProbeResult {
  readonly name: string;
  readonly url: string;
  readonly purpose: string;
  readonly reachable: boolean;
  readonly dnsMs: number | null;
  readonly responseMs: number | null;
  readonly status: number | null;
  readonly error: string | null;
}

export async function probe(target: Target, timeoutMs: number): Promise<ProbeResult> {
  const url = new URL(target.url);
  const base = { name: target.name, url: target.url, purpose: target.purpose };
  let dnsMs: number | null = null;
  const t0 = performance.now();
  try {
    await withTimeout(dns.lookup(url.hostname), timeoutMs, "DNS timeout");
    dnsMs = Math.round(performance.now() - t0);
  } catch (error) {
    return {
      ...base,
      reachable: false,
      dnsMs,
      responseMs: null,
      status: null,
      error: describe(error),
    };
  }
  const t1 = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "amos-connectivity-probe" },
    });
    const responseMs = Math.round(performance.now() - t1);
    await response.body?.cancel();
    return { ...base, reachable: true, dnsMs, responseMs, status: response.status, error: null };
  } catch (error) {
    return {
      ...base,
      reachable: false,
      dnsMs,
      responseMs: null,
      status: null,
      error: describe(error),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return "timeout";
  const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
  const code = (error as NodeJS.ErrnoException).code ?? cause?.code;
  return code ? `${code}` : (cause?.message ?? error.message);
}

export function formatTable(results: readonly ProbeResult[]): string {
  const nameWidth = Math.max(...results.map((r) => r.name.length));
  return results
    .map((r) => {
      const state = r.reachable ? "OK  " : "FAIL";
      const timing = r.reachable
        ? `${r.status} in ${r.responseMs} ms (dns ${r.dnsMs} ms)`
        : r.error;
      return `[${state}] ${r.name.padEnd(nameWidth)}  ${timing}`;
    })
    .join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      json: { type: "string" },
      timeout: { type: "string", default: "8000" },
      targets: { type: "string" },
    },
  });
  const timeoutMs = Number(values.timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout must be positive");
  const targets: Target[] = values.targets
    ? JSON.parse(fs.readFileSync(values.targets, "utf8"))
    : [...DEFAULT_TARGETS];

  const proxyVars = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].filter(
    (v) => process.env[v],
  );
  console.log(`AMOS connectivity probe — ${new Date().toISOString()}`);
  console.log(`node ${process.version}, ${process.platform}/${os.arch()}, timeout ${timeoutMs} ms`);
  // Kept self-contained (no src/ imports) so the script runs on a bare Node install.
  const envProxyMode =
    !["", "0", "false"].includes((process.env["NODE_USE_ENV_PROXY"] ?? "").trim().toLowerCase()) ||
    process.execArgv.includes("--use-env-proxy") ||
    /(^|\s)--use-env-proxy(=|\s|$)/.test(process.env["NODE_OPTIONS"] ?? "");
  if (envProxyMode) {
    console.log(
      "WARNING: Node env-proxy mode is on (NODE_USE_ENV_PROXY / --use-env-proxy): these results describe the proxy route, not direct access. AMOS itself refuses to send requests in this mode.",
    );
  } else if (proxyVars.length > 0) {
    console.log(
      `note: proxy variables set (${proxyVars.join(", ")}); Node fetch ignores them, so results are for direct access.`,
    );
  }
  // Probes run concurrently; each has its own timeout.
  const results = await Promise.all(targets.map((t) => probe(t, timeoutMs)));
  console.log(formatTable(results));
  if (values.json) {
    const report = {
      time: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      results,
    };
    fs.writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report written to ${values.json}`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
