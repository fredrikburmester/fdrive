import { candidateProblem, parseEndpoint } from "./endpoint.js";

/** Result of probing a candidate or active S3 address. */
export interface ProbeResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProbeConnectionDeps {
  readonly fetch: typeof globalThis.fetch;
}

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_BODY_BYTES = 1024;

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : "network error";
}

async function readBounded(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < PROBE_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, PROBE_BODY_BYTES));
}

/** The `<Code>` of an S3 XML error body, when the body is one. */
export function errorCode(body: string): string | null {
  const match = /<Code>([A-Za-z0-9_.]+)<\/Code>/.exec(body);
  return match === null ? null : (match[1] as string);
}

function looksLikeS3(response: Response, body: string): boolean {
  return (
    response.headers.has("x-amz-request-id") ||
    response.headers.has("x-amz-id-2") ||
    errorCode(body) !== null ||
    body.includes("<ListBucketResult")
  );
}

/**
 * Probes the bucket with an unsigned `GET`. Every target refuses anonymous
 * listing, and an S3-shaped refusal (an `x-amz-request-id` header or an XML
 * `<Error>` body) proves a reachable S3 endpoint that has the bucket. A
 * `NoSuchBucket` answer or a redirect is not usable as entered.
 */
export async function probeConnection(
  baseUrl: string,
  deps: ProbeConnectionDeps,
): Promise<ProbeResult> {
  const problem = candidateProblem(baseUrl);
  if (problem !== null) return { ok: false, detail: problem };
  const { endpoint, bucket } = parseEndpoint(baseUrl);
  const url = `${endpoint}/${bucket}/`;

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, detail: `could not reach ${endpoint}: ${messageFor(err)}` };
  }
  const status = response.status;
  const body = await readBounded(response);
  const code = errorCode(body);

  if (status >= 300 && status < 400) {
    return {
      ok: false,
      detail: `bucket request redirected with ${status}; enter the final endpoint URL`,
    };
  }
  if (code === "NoSuchBucket") {
    return { ok: false, detail: `bucket ${bucket} was not found on this endpoint` };
  }
  if (!looksLikeS3(response, body)) {
    return { ok: false, detail: `bucket request returned ${status}; not an S3 endpoint` };
  }
  if (status === 401 || status === 403) {
    return { ok: true, detail: `S3 bucket ${bucket} is reachable and requires a login` };
  }
  if (status >= 200 && status < 300) {
    return { ok: true, detail: `S3 bucket ${bucket} is reachable and allows anonymous listing` };
  }
  return {
    ok: false,
    detail: `bucket request returned ${status}${code === null ? "" : ` (${code})`}`,
  };
}
