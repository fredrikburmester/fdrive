import { isStorageError, StorageError, type StorageProvider } from "@fdrive/core";
import { createSftpgoClient } from "./client.js";
import { SftpgoError } from "./errors.js";
import { buildUrl, combineSignals, fetchChecked } from "./http.js";
import { createSftpgoStorageProvider, toStorageError, type WithToken } from "./storage-provider.js";

export const SFTPGO_WRITE_PROTOCOL = "fdrive-local-v1";
export const SFTPGO_LEASE_HEADER = "X-Fdrive-Write-Lease";
interface LeaseOptions {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  withToken: WithToken;
  signal?: AbortSignal;
  /** Tests only; production renews every 20 seconds. */
  renewIntervalMs?: number;
}

async function readLease(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new StorageError("upstream_unavailable", "Storage returned no write lease");
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) throw new Error("Oversized lease response");
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (cause) {
    throw new StorageError("upstream_unavailable", "Storage returned an invalid write lease", {
      cause,
    });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only the pinned, opt-in SFTPGo filesystem integration implements this protocol. */
export async function withSftpgoWriteLease<T>(
  options: LeaseOptions,
  action: (storage: StorageProvider) => Promise<T>,
): Promise<T> {
  const endpoint = buildUrl(options.baseUrl, "/api/v2/user/fdrive/lease");
  const userPrefix = buildUrl(options.baseUrl, "/api/v2/user/");
  const aborted = new AbortController();
  const signal = combineSignals(options.signal, null);
  const scopeSignal = AbortSignal.any([signal, aborted.signal]);
  scopeSignal.throwIfAborted();
  let leaseToken: string | undefined;
  let active = true;
  let renewal: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  async function request(method: string, release = false) {
    try {
      return await options.withToken((jwt) =>
        fetchChecked(options.fetch, endpoint, {
          method,
          headers: {
            Authorization: `Bearer ${jwt}`,
            ...(leaseToken ? { [SFTPGO_LEASE_HEADER]: leaseToken } : {}),
          },
          signal: release ? AbortSignal.timeout(10_000) : combineSignals(scopeSignal, 10_000),
        }),
      );
    } catch (error) {
      // Contention/lease loss is retryable. A missing lease endpoint is not a
      // missing file: Finder must preserve and retry the existing operation.
      if (
        error instanceof SftpgoError &&
        (error.kind === "conflict" || error.kind === "not_found")
      ) {
        throw new StorageError(
          "upstream_unavailable",
          "Storage write enforcement is busy or unavailable",
          { cause: error },
        );
      }
      toStorageError(error);
    }
  }

  async function lock() {
    const value = await readLease(await request(leaseToken ? "PATCH" : "POST"));
    const record = value as {
      protocol?: unknown;
      token?: unknown;
      timeoutSeconds?: unknown;
    } | null;
    const next = record?.token;
    // Keep a syntactically valid token for cleanup even if the rest of the contract is invalid.
    const validToken = typeof next === "string" && /^[a-f0-9]{64}$/.test(next);
    const changed = leaseToken !== undefined && next !== leaseToken;
    if (leaseToken === undefined && validToken) leaseToken = next;
    if (
      !validToken ||
      changed ||
      record?.protocol !== SFTPGO_WRITE_PROTOCOL ||
      record.timeoutSeconds !== 60
    ) {
      throw new StorageError(
        "upstream_unavailable",
        "Storage cannot enforce the required write lease",
      );
    }
  }

  const scopedFetch: typeof globalThis.fetch = async (input, init) => {
    if (!active) throw new StorageError("conflict", "The storage write lease has ended");
    scopeSignal.throwIfAborted();
    if (!String(input).startsWith(userPrefix) || !leaseToken) {
      throw new StorageError("forbidden", "Write lease request escaped its user endpoint");
    }
    const headers = new Headers(init?.headers);
    headers.set(SFTPGO_LEASE_HEADER, leaseToken);
    return options.fetch(input, {
      ...init,
      headers,
      redirect: "manual",
      signal: init?.signal ? AbortSignal.any([scopeSignal, init.signal]) : scopeSignal,
    });
  };

  try {
    await lock();
    interval = setInterval(() => {
      if (renewal || !active) return;
      renewal = lock()
        .catch((error) => aborted.abort(error))
        .finally(() => {
          renewal = undefined;
        });
    }, options.renewIntervalMs ?? 20_000);
    interval.unref();
    const storage = createSftpgoStorageProvider({
      client: createSftpgoClient({ baseUrl: options.baseUrl, fetch: scopedFetch }),
      withToken: (fn, opts) => {
        if (!active) throw new StorageError("conflict", "The storage write lease has ended");
        scopeSignal.throwIfAborted();
        return options.withToken(fn, opts);
      },
    });
    async function absent(path: string) {
      try {
        await storage.stat(path);
      } catch (error) {
        if (isStorageError(error) && error.kind === "not_found") return;
        throw error;
      }
      throw new StorageError("conflict", "The destination already exists");
    }
    // Stock REST ignores overwrite=false. The check is safe only inside this
    // storage-enforced lease; expiry fences the subsequent filesystem mutation.
    return await action({
      ...storage,
      async upload(path, body, opts) {
        if (opts?.overwrite === false) await absent(path);
        await storage.upload(path, body, opts);
      },
      async move(path, target, opts) {
        if (opts?.overwrite === false) await absent(target);
        await storage.move(path, target, opts);
      },
    });
  } finally {
    active = false;
    clearInterval(interval);
    await renewal;
    aborted.abort();
    if (leaseToken) {
      try {
        await (await request("DELETE", true)).body?.cancel();
      } catch {
        /* Bounded expiry; release failure must never replay a completed operation. */
      }
    }
  }
}
