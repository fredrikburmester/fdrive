import { StorageError } from "@fdrive/core";
import { XMLParser } from "fast-xml-parser";
import { createWebdavClient } from "./client.js";
import {
  basicAuthHeader,
  buildUrl,
  cancelBody,
  combineSignals,
  readTextBounded,
  safeFetch,
} from "./http.js";
import type { WebdavClient, WebdavCredential } from "./types.js";

const LOCK_BODY =
  '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>fdrive</D:owner></D:lockinfo>';
const MUTATIONS = new Set(["PUT", "POST", "PATCH", "MKCOL", "MOVE", "COPY", "DELETE"]);
export interface WriteLeaseOptions {
  baseUrl: string;
  credential: WebdavCredential;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** Dependency injection for renewal tests. Production renews every 20 seconds. */
  renewIntervalMs?: number;
}

/**
 * Class-2 WebDAV lease, qualified against Apache mod_dav. Callers must opt in
 * only when every writer uses this WebDAV endpoint; SFTPGo's other protocols
 * bypass its DAV locks and are deliberately not supported by this contract.
 */
export async function withWebdavWriteLease<T>(
  options: WriteLeaseOptions,
  action: (client: WebdavClient) => Promise<T>,
): Promise<T> {
  const fetch = options.fetch ?? globalThis.fetch;
  const root = buildUrl(options.baseUrl, "/", { collection: true });
  const authorization = basicAuthHeader(options.credential.username, options.credential.password);
  const aborted = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, aborted.signal])
    : aborted.signal;
  signal.throwIfAborted();
  async function lock(token?: string) {
    const response = await safeFetch(fetch, root, {
      method: "LOCK",
      headers: {
        Authorization: authorization,
        Timeout: "Second-60",
        ...(token
          ? { If: `(${token})` }
          : { Depth: "infinity", "Content-Type": "application/xml" }),
      },
      ...(token ? {} : { body: LOCK_BODY }),
      signal: combineSignals(signal, 10_000),
    });
    const next = response.headers.get("Lock-Token");
    const xml = await readTextBounded(response, 64 * 1024);
    const parsed = xml
      ? new XMLParser({ removeNSPrefix: true, processEntities: false }).parse(xml)
      : {};
    const granted = parsed?.prop?.lockdiscovery?.activelock;
    const timeout = granted?.timeout ?? response.headers.get("Timeout");
    const server = response.headers.get("Server") ?? "";
    await cancelBody(response);
    if (!response.ok)
      throw new StorageError(
        response.status === 423 ? "conflict" : "upstream_unavailable",
        "Could not acquire or renew the storage write lock",
      );
    if (token === undefined && (!next || !/^<[^<>\s]{1,1024}>$/.test(next))) {
      throw new StorageError("upstream_unavailable", "Storage returned an invalid write lock");
    }
    // A server may grant less time than requested. Never start work under a
    // lease shorter than the renewal/retry budget. Unknown timeouts fail closed.
    if (
      !server.startsWith("Apache/") ||
      granted?.depth !== "infinity" ||
      !Object.hasOwn(granted?.lockscope ?? {}, "exclusive") ||
      !Object.hasOwn(granted?.locktype ?? {}, "write") ||
      (token !== undefined && next !== null && next !== token) ||
      typeof timeout !== "string" ||
      !/^Second-\d+$/.test(timeout) ||
      Number(timeout?.slice(7)) < 60 ||
      Number(timeout?.slice(7)) > 120
    ) {
      if (next ?? token) await unlock((next ?? token) as string);
      throw new StorageError(
        "upstream_unavailable",
        "Storage cannot provide the required exclusive write lease",
      );
    }
    return token ?? (next as string);
  }
  async function unlock(token: string) {
    try {
      const response = await safeFetch(fetch, root, {
        method: "UNLOCK",
        headers: { Authorization: authorization, "Lock-Token": token },
        signal: AbortSignal.timeout(10_000),
      });
      await cancelBody(response);
    } catch {
      /* The bounded lease expires; never replay a completed mutation because release failed. */
    }
  }
  const token = await lock();
  let active = true;
  let renewal: Promise<void> | undefined;
  const interval = setInterval(() => {
    if (renewal || !active) return;
    renewal = lock(token)
      .then(
        () => {},
        (error) => aborted.abort(error),
      )
      .finally(() => {
        renewal = undefined;
      });
  }, options.renewIntervalMs ?? 20_000);
  interval.unref();
  const scopedFetch: typeof globalThis.fetch = async (input, init) => {
    if (!active) throw new StorageError("conflict", "The storage write lease has ended");
    signal.throwIfAborted();
    const url = String(input);
    const headers = new Headers(init?.headers);
    const method = init?.method?.toUpperCase() ?? "GET";
    if (MUTATIONS.has(method)) {
      // For a new resource there is no state token at its own URL. Authorize
      // against the root and insist on exclusive creation. Existing resources
      // must evaluate their own token: a root-only tagged If can be ignored by
      // Apache once the lease is gone, which would permit an unfenced overwrite.
      if (method === "MKCOL" || (method === "PUT" && headers.get("If-None-Match") === "*")) {
        headers.set("If", `<${root}> (${token})`);
      } else {
        let condition = `<${url}> (${token}) <${root}> (${token})`;
        const destination = headers.get("Destination");
        if (destination && headers.get("Overwrite") !== "F")
          condition += ` <${destination}> (${token})`;
        headers.set("If", condition);
      }
    }
    const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
    return fetch(input, { ...init, headers, signal: requestSignal, redirect: "manual" });
  };
  try {
    const result = await action(
      createWebdavClient({ baseUrl: options.baseUrl, fetch: scopedFetch }),
    );
    return result;
  } finally {
    active = false;
    clearInterval(interval);
    await renewal;
    aborted.abort();
    await unlock(token);
  }
}
