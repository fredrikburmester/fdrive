import { isProhibitedMetadataHost } from "@fdrive/core";

/** Result of probing a candidate or active SFTPGo base URL. */
export interface ProbeResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProbeConnectionDeps {
  readonly fetch: typeof globalThis.fetch;
}

const PROBE_TIMEOUT_MS = 5_000;
const MAX_HEALTH_RESPONSE_BYTES = 1024;
/** Strips a trailing slash from `baseUrl`, so joining a path never doubles it up. */
function stripTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : "network error";
}

function candidateProblem(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "SFTPGo URL is invalid";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "SFTPGo URL must use http or https";
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return "SFTPGo URL must not include credentials";
  }
  return isProhibitedMetadataHost(parsed.hostname)
    ? "SFTPGo URL targets a prohibited metadata host"
    : null;
}

function probeRequest(): RequestInit {
  return { redirect: "error", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) };
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null || response.bodyUsed) return;
  await response.body.cancel().catch(() => undefined);
}

async function readTextWithin(response: Response, maxBytes: number): Promise<string | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    await cancelResponseBody(response);
    return null;
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    if (!complete) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Probes `baseUrl` the same way for setup and the admin connection page:
 * `GET /healthz` must return 200 with the body "ok", and
 * `GET /api/v2/user/token` without credentials must return 401 (SFTPGo
 * requires Basic auth there; anything else means this is not a working
 * SFTPGo, or authentication is misconfigured in a way fdrive cannot use).
 */
export async function probeConnection(
  baseUrl: string,
  deps: ProbeConnectionDeps,
): Promise<ProbeResult> {
  const problem = candidateProblem(baseUrl);
  if (problem !== null) return { ok: false, detail: problem };
  const base = stripTrailingSlash(baseUrl);

  let healthRes: Response;
  try {
    healthRes = await deps.fetch(`${base}/healthz`, probeRequest());
  } catch (err) {
    return { ok: false, detail: `could not reach ${base}/healthz: ${messageFor(err)}` };
  }
  if (healthRes.status !== 200) {
    await cancelResponseBody(healthRes);
    return {
      ok: false,
      detail: `GET /healthz returned ${healthRes.status}, expected 200`,
    };
  }
  const healthBody = await readTextWithin(healthRes, MAX_HEALTH_RESPONSE_BYTES);
  if (healthBody === null) {
    return { ok: false, detail: "GET /healthz response could not be read safely" };
  }
  if (healthBody.trim() !== "ok") {
    return { ok: false, detail: 'GET /healthz did not return the expected body "ok"' };
  }

  let tokenRes: Response;
  try {
    tokenRes = await deps.fetch(`${base}/api/v2/user/token`, probeRequest());
  } catch (err) {
    return {
      ok: false,
      detail: `could not reach ${base}/api/v2/user/token: ${messageFor(err)}`,
    };
  }
  await cancelResponseBody(tokenRes);
  if (tokenRes.status !== 401) {
    return {
      ok: false,
      detail: `GET /api/v2/user/token returned ${tokenRes.status}, expected 401`,
    };
  }

  return { ok: true, detail: "SFTPGo is reachable" };
}
