import { isSafeSegment } from "@fdrive/core";

/**
 * Where a provider row points: the S3 endpoint, the bucket and an optional
 * key prefix, all parsed from the row's `baseUrl`
 * (`https://host[:port]/bucket[/prefix]`). Rows are unique by `baseUrl`,
 * so two buckets on one server are two rows without any other key.
 */
export interface S3Endpoint {
  /** Origin the SDK signs for; never a server-chosen host. */
  readonly endpoint: string;
  readonly bucket: string;
  /** Key prefix without leading or trailing slash; `""` for the bucket root. */
  readonly prefix: string;
}

const PROHIBITED_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "169.254.169.253",
  "100.100.100.200",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata.google",
]);

/** Bucket naming shared by AWS, MinIO and Garage: 3–63 lowercase letters, digits, dots and hyphens. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * A reason `baseUrl` can never be a usable S3 address, before any request is
 * sent: bad scheme, embedded credentials, a metadata host, no bucket, an
 * invalid bucket name or an unsafe prefix segment. `null` when it parses.
 */
export function candidateProblem(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "S3 address is invalid";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "S3 address must use http or https";
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return "S3 address must not include credentials";
  }
  if (parsed.search || parsed.hash) return "S3 address must not include a query or fragment";
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (PROHIBITED_METADATA_HOSTS.has(host)) return "S3 address targets a prohibited metadata host";
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const bucket = segments[0];
  if (bucket === undefined) {
    return "S3 address must name the bucket in its path, for example https://minio.local:9000/media";
  }
  if (!BUCKET_NAME.test(bucket)) return `S3 bucket name is invalid: ${bucket}`;
  for (const segment of segments.slice(1)) {
    const decoded = decodeSegment(segment);
    if (decoded === null || !isSafeSegment(decoded)) {
      return `S3 prefix segment is invalid: ${segment}`;
    }
  }
  return null;
}

/** Parses a row's `baseUrl`; throws for anything `candidateProblem` rejects. */
export function parseEndpoint(baseUrl: string): S3Endpoint {
  const problem = candidateProblem(baseUrl);
  if (problem !== null) throw new Error(problem);
  const parsed = new URL(baseUrl);
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  return {
    endpoint: parsed.origin,
    bucket: segments[0] as string,
    prefix: segments
      .slice(1)
      .map((segment) => decodeURIComponent(segment))
      .join("/"),
  };
}
