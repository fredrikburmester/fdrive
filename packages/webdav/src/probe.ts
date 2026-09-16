import { isProhibitedMetadataHost } from "@fdrive/core";
import { cancelBody } from "./http.js";

/** Result of probing a candidate or active WebDAV endpoint. */
export interface ProbeResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProbeConnectionDeps {
  readonly fetch: typeof globalThis.fetch;
}

const PROBE_TIMEOUT_MS = 5_000;
function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : "network error";
}

/** A reason `baseUrl` can never be a usable endpoint, before any request is sent. */
export function candidateProblem(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "WebDAV URL is invalid";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "WebDAV URL must use http or https";
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return "WebDAV URL must not include credentials";
  }
  if (parsed.search || parsed.hash) return "WebDAV URL must not include a query or fragment";
  return isProhibitedMetadataHost(parsed.hostname)
    ? "WebDAV URL targets a prohibited metadata host"
    : null;
}

/** The compliance classes a `DAV` header advertises, trimmed and lower-cased. */
export function davClasses(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function offersBasic(challenge: string | null): boolean {
  return challenge !== null && /(^|[\s,])basic(\s|$)/i.test(challenge);
}

/**
 * Probes `baseUrl` with an unauthenticated `OPTIONS`. A 2xx must advertise
 * class 1 in its `DAV` header; a 401 or 403 that challenges with Basic
 * proves a reachable endpoint that only needs a login. Anything else,
 * including a redirect, is not a WebDAV endpoint fdrive can use.
 */
export async function probeConnection(
  baseUrl: string,
  deps: ProbeConnectionDeps,
): Promise<ProbeResult> {
  const problem = candidateProblem(baseUrl);
  if (problem !== null) return { ok: false, detail: problem };
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith("/")) url.pathname += "/";

  let response: Response;
  try {
    response = await deps.fetch(url.toString(), {
      method: "OPTIONS",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, detail: `could not reach ${url.origin}: ${messageFor(err)}` };
  }
  await cancelBody(response);
  const status = response.status;

  if (status >= 300 && status < 400) {
    return { ok: false, detail: `OPTIONS redirected with ${status}; enter the final endpoint URL` };
  }
  if (status === 401 || status === 403) {
    const challenge = response.headers.get("www-authenticate");
    if (offersBasic(challenge)) {
      return { ok: true, detail: "WebDAV endpoint is reachable and requires a login" };
    }
    return {
      ok: false,
      detail:
        challenge === null
          ? `OPTIONS returned ${status} without an authentication challenge`
          : `OPTIONS returned ${status} without offering Basic authentication`,
    };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, detail: `OPTIONS returned ${status}, expected 200` };
  }
  const classes = davClasses(response.headers.get("dav"));
  if (classes.length === 0) {
    return { ok: false, detail: "OPTIONS did not return a DAV header; not a WebDAV endpoint" };
  }
  if (!classes.includes("1")) {
    return { ok: false, detail: `DAV header lacks class 1 (got ${classes.join(", ")})` };
  }
  return { ok: true, detail: `WebDAV is reachable (class ${classes.join(", ")})` };
}
