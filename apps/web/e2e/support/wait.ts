function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `url` until it responds with an ok (2xx) status, or throws once
 * `timeoutMs` elapses. Used to wait for the API and web servers to come up
 * during global setup, since neither exposes a "ready" signal other than
 * accepting HTTP requests.
 */
export async function waitForHttpOk(
  url: string,
  timeoutMs: number,
  intervalMs = 300,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        return;
      }
      lastError = new Error(`unexpected status ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${url} to respond ok: ${String(lastError)}`,
  );
}
