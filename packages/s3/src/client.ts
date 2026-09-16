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
  /** Time to first response byte for one attempt. Bodies stream without a timeout. */
  readonly requestTimeoutMs?: number;
}

export const DEFAULT_REGION = "us-east-1";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
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

/** The region a provider row's configuration names, else the S3 default. */
export function regionFor(config: Readonly<Record<string, unknown>>): string {
  const value = config.region;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : DEFAULT_REGION;
}
