export { createSftpgoClient } from "./client.js";
export { DEFAULT_PROBE_MAX_BYTES, probeDirectoryStream } from "./directory-probe.js";
export type { SftpgoErrorKind } from "./errors.js";
export { mapStatusToKind, SftpgoError } from "./errors.js";
export type {
  FakeSftpgoServer,
  FakeShareRecord,
  FakeState,
  FakeTokenRecord,
  FakeUserRecord,
} from "./fake/server.js";
export { createFakeSftpgoServer } from "./fake/server.js";
export type { FakeSeed, FakeSeedUser } from "./fake/types.js";
export type { CreateSftpgoModuleOptions } from "./module.js";
export {
  createSftpgoModule,
  DEFAULT_SFTPGO_HOME_TEMPLATE,
  SFTPGO_CONFIG_FIELDS,
  SFTPGO_CREDENTIAL_FIELDS,
  SFTPGO_SOURCE_URL,
  sftpgoHomeTemplate,
  sftpgoModule,
} from "./module.js";
export type { ProbeConnectionDeps, ProbeResult } from "./probe.js";
export { probeConnection } from "./probe.js";
export type {
  SftpgoDownloadOpts,
  SftpgoStorageProviderDeps,
  WithToken,
} from "./storage-provider.js";
export { createSftpgoStorageProvider, toStorageError } from "./storage-provider.js";
export type {
  ByteRange,
  DownloadOptions,
  DownloadResult,
  EntryKind,
  SftpgoClient,
  SftpgoClientOptions,
  SftpgoEntry,
  SftpgoFileStat,
  SftpgoProfile,
  SftpgoPublicShareApi,
  SftpgoShare,
  SftpgoShareInput,
  SftpgoToken,
  SftpgoUserApi,
  SftpgoUserShares,
  ShareScope,
  UploadOptions,
} from "./types.js";
