export type { CreateS3ClientOptions, S3Credential } from "./client.js";
export { createS3Client, DEFAULT_REGION, inferRegion, regionFor } from "./client.js";
export type { S3Endpoint } from "./endpoint.js";
export { candidateProblem, parseEndpoint } from "./endpoint.js";
export { describeSdkError, kindForSdkError, toStorageError } from "./errors.js";
export type {
  FakeS3Key,
  FakeS3Object,
  FakeS3Options,
  FakeS3Server,
  RecordedRequest,
} from "./fake/server.js";
export { createFakeS3Server } from "./fake/server.js";
export { childName, copySource, dirKey, fileKey } from "./keys.js";
export type { CreateS3ModuleOptions } from "./module.js";
export { createS3Module, S3_CONFIG_FIELDS, S3_CREDENTIAL_FIELDS, s3Module } from "./module.js";
export type { ProbeConnectionDeps, ProbeResult } from "./probe.js";
export { errorCode, probeConnection } from "./probe.js";
export type { S3DownloadOpts, S3StorageProviderDeps } from "./storage-provider.js";
export {
  createS3StorageProvider,
  MAX_COPY_BYTES,
  MAX_DIRECTORY_KEYS,
} from "./storage-provider.js";
