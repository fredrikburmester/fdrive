import { S3Client } from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";

/** A key pair as people type it at login. */
export interface S3Credential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface CreateS3ClientOptions {
  /** Origin only (`https://minio.local:9000`); the bucket goes in each request's path. */
  readonly endpoint: string;
  readonly region: string;
  readonly credential: S3Credential;
  /** The network the client uses; tests inject a fake. */
  readonly fetch: typeof globalThis.fetch;
  /**
   * Bound on one attempt, from the first request byte to the response
   * headers: a part upload must finish sending within it. Response bodies
   * stream without a timeout.
   */
  readonly requestTimeoutMs?: number;
}

export const DEFAULT_REGION = "us-east-1";
/** Matches the backup destination: an 8 MiB part over a slow uplink fits comfortably. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;

/**
 * Builds an `S3Client` bound to one endpoint, region and key pair. Every
 * request goes through the injected `fetch`, path-style, signed for the
 * configured origin only. Checksums stay off unless an operation requires
 * one: the SDK's default CRC32 trailers are refused by older MinIO, Garage
 * and Backblaze B2, as the backup destination already found.
 */
export function createS3Client(options: CreateS3ClientOptions): S3Client {
  return new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.credential.accessKeyId,
      secretAccessKey: options.credential.secretAccessKey,
    },
    maxAttempts: MAX_ATTEMPTS,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: new FetchHttpHandler({
      customFetch: options.fetch,
      requestTimeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    }),
  });
}

/** `us-west-004`, `eu-central-1`, `ap-southeast-2`: a region label as hosted endpoints spell it. */
const REGION_LABEL = /^[a-z]{2}-[a-z]+-\d{1,3}$/;

/**
 * The signing region a hosted endpoint's hostname reveals, or `null` for a
 * self-hosted one: `s3.<region>.backblazeb2.com` and
 * `s3.<region>.amazonaws.com` name it, Cloudflare R2 wants `auto`, and a
 * Hetzner location (`fsn1.your-objectstorage.com`) doubles as its region.
 * B2 refuses a signature for the wrong region, so this saves the field.
 */
export function inferRegion(endpoint: string): string | null {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split(".");
  if (host.endsWith(".r2.cloudflarestorage.com")) return "auto";
  if (host.endsWith(".your-objectstorage.com") && labels.length === 3) return labels[0] as string;
  const candidate = labels[1];
  if (labels[0] === "s3" && candidate !== undefined && REGION_LABEL.test(candidate)) {
    return candidate;
  }
  return null;
}

/**
 * The region a provider row's configuration names, else the one its
 * endpoint reveals, else the S3 default.
 */
export function regionFor(config: Readonly<Record<string, unknown>>, endpoint?: string): string {
  const value = config.region;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return (endpoint === undefined ? null : inferRegion(endpoint)) ?? DEFAULT_REGION;
}
