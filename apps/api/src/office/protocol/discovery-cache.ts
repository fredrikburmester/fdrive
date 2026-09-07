import { parseDiscovery, requireHttpUrl, type WopiDiscovery } from "./discovery.ts";

export interface DiscoveryCacheOptions {
  readonly serverUrl: string;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly ttlMs?: number;
}
export interface DiscoveryCache {
  get(): Promise<WopiDiscovery>;
  refresh(): Promise<WopiDiscovery>;
}

async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.ok || !response.body) throw new Error("Discovery request failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  function cancel() {
    void reader.cancel().catch(() => undefined);
  }
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) throw new Error("Discovery exceeds response size limit");
      chunks.push(result.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export function createDiscoveryCache(options: DiscoveryCacheOptions): DiscoveryCache {
  const server = requireHttpUrl(options.serverUrl);
  if (server.search) throw new Error("Discovery server URL cannot contain a query");
  const url = `${server.toString().replace(/\/$/, "")}/hosting/discovery`;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
  for (const value of [timeoutMs, maxBytes, ttlMs]) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Discovery bounds must be positive safe integers");
  }
  let cached: { value: WopiDiscovery; expiresAt: number } | undefined;
  let pending: Promise<WopiDiscovery> | undefined;

  function refresh(): Promise<WopiDiscovery> {
    if (pending) return pending;
    // Once a refresh starts no caller may fall back to potentially invalid keys.
    cached = undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Discovery request timed out"));
      }, timeoutMs);
    });
    const request = Promise.resolve().then(async () => {
      const response = await options.fetch(url, {
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
      });
      return parseDiscovery(await readBounded(response, maxBytes, controller.signal));
    });
    pending = Promise.race([request, deadline])
      .then((value) => {
        cached = { value, expiresAt: now() + ttlMs };
        return value;
      })
      .finally(() => {
        clearTimeout(timer);
        pending = undefined;
      });
    return pending;
  }

  return {
    get() {
      if (pending) return pending;
      if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value);
      return refresh();
    },
    refresh,
  };
}
