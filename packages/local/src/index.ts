export type { DiskChange, DiskChangeListener, DiskContent, IndexChange } from "./changes.js";
export { codeOf, toStorageError } from "./errors.js";
export type {
  FilesFolderFacts,
  FilesFolderGuard,
  FilesFolderGuardOptions,
  FilesFolderVerdict,
} from "./files-marker.js";
export {
  createFilesFolderGuard,
  FILES_FOLDER_REASONS,
  FILES_MARKER,
  verifyFilesFolder,
} from "./files-marker.js";
export type { Home } from "./home.js";
export { createHome } from "./home.js";
export type {
  CreateLocalModuleOptions,
  LocalUserCheck,
  LocalUserStatus,
  LocalUsers,
} from "./module.js";
export {
  createLocalModule,
  isLocalUsername,
  LOCAL_CREDENTIAL_FIELDS,
  probeRoot,
} from "./module.js";
export type { SharedFolder, SharedGrant, UserStorageOptions } from "./shared.js";
export {
  closedToShares,
  createUserStorage,
  namedSharedGrants,
  SHARED_WITH_ME,
  sharedFolderNames,
} from "./shared.js";
export type {
  LocalStorage,
  LocalStorageOptions,
  MoveOptions,
  ZipItem,
} from "./storage-provider.js";
export { createLocalStorage } from "./storage-provider.js";
