/** Result of probing a candidate or active SFTPGo base URL. */
export interface ProbeResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProbeConnectionDeps {
  readonly fetch: typeof globalThis.fetch;
}

/** Strips a trailing slash from `baseUrl`, so joining a path never doubles it up. */
function stripTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : "network error";
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
  const base = stripTrailingSlash(baseUrl);

  let healthRes: Response;
  try {
    healthRes = await deps.fetch(`${base}/healthz`);
  } catch (err) {
    return { ok: false, detail: `could not reach ${base}/healthz: ${messageFor(err)}` };
  }
  if (healthRes.status !== 200) {
    return {
      ok: false,
      detail: `GET /healthz returned ${healthRes.status}, expected 200`,
    };
  }
  const healthBody = (await healthRes.text()).trim();
  if (healthBody !== "ok") {
    return { ok: false, detail: 'GET /healthz did not return the expected body "ok"' };
  }

  let tokenRes: Response;
  try {
    tokenRes = await deps.fetch(`${base}/api/v2/user/token`);
  } catch (err) {
    return {
      ok: false,
      detail: `could not reach ${base}/api/v2/user/token: ${messageFor(err)}`,
    };
  }
  if (tokenRes.status !== 401) {
    return {
      ok: false,
      detail: `GET /api/v2/user/token returned ${tokenRes.status}, expected 401`,
    };
  }

  return { ok: true, detail: "SFTPGo is reachable" };
}
