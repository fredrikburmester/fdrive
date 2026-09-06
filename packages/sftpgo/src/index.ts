export { createSftpgoClient } from "./client.js";
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
