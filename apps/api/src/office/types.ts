import type { StorageProvider } from "@fdrive/core";
import type {
  Identity,
  OfficeFile,
  OfficeFileRepo,
  Repos,
  Session,
  WopiLockRepo,
} from "@fdrive/db";
import type { PersonalActivityService } from "../activity/service.js";
import type { Principal } from "../auth/principal.js";
import type { FileOperations } from "../files/operations.js";
import type { LocalGrantService } from "../local/grants.js";
import type { MetadataService } from "../metadata/service.js";
import type { DiscoveryCache } from "./protocol/discovery-cache.ts";
import type { OfficeTokenCodec } from "./tokens.ts";

export type { OfficeFile, OfficeFileLocation, OfficeFileRepo } from "@fdrive/db";
export interface OfficeConfig {
  readonly product: "onlyoffice" | "collabora";
  readonly serverUrl: string;
  readonly publicUrl: string;
  readonly wopiUrl: string;
  readonly appUrl: string;
  readonly maxBytes: number;
  readonly timeoutMs?: number;
}
export interface OfficeDeps {
  readonly canEdit?: ((actor: OfficeActor, virtualPath: string) => Promise<boolean>) | undefined;
  readonly config: OfficeConfig | null;
  readonly discovery: DiscoveryCache | null;
  /** Resolves one coherent settings/config/discovery snapshot for each operation. */
  readonly resolveRuntime?:
    | (() => Promise<{ config: OfficeConfig; discovery: DiscoveryCache } | null>)
    | undefined;
  readonly tokens: OfficeTokenCodec;
  readonly repos: Pick<Repos, "sessions" | "identities" | "accounts">;
  readonly files: OfficeFileRepo;
  /** On the write scope's pool: lock requests wait for the document locks writes hold. */
  readonly locks: WopiLockRepo;
  /** One transaction holding the document locks a write takes; see `createOfficeWriteScope`. */
  readonly withWriteScope: <T>(
    callback: (scope: { files: OfficeFileRepo; locks: WopiLockRepo }) => Promise<T>,
  ) => Promise<T>;
  readonly clock: () => Date;
  /**
   * Where a login's path lies in its owner's files and back
   * (`LocalGrantService`): documents are keyed by owner and owner's path, so
   * everyone a folder is shared with opens its documents under one id.
   */
  readonly grants: Pick<LocalGrantService, "ownerPath" | "pathFor">;
  readonly storageFactory: (identityId: string) => StorageProvider | Promise<StorageProvider>;
  /** Writes and renames documents the way every change to files is made. */
  readonly operations: FileOperations;
  /** Recently opened, which opening a document touches. */
  readonly metadata: Pick<MetadataService, "touchRecent">;
  /** Optional so office tests and deployments without history keep working.
   * Explicitly `undefined` is allowed so a caller can clear it in a spread. */
  readonly activity?: PersonalActivityService | undefined;
}
export interface OfficeActor {
  readonly identity: Identity;
  readonly session: Session;
  readonly storage: StorageProvider;
}
export interface OpenedFile {
  readonly actor: OfficeActor;
  readonly file: OfficeFile;
  readonly path: string;
  readonly mode: "view" | "edit";
  readonly editAllowed: boolean;
}
export interface BrowserOfficeInput {
  readonly principal: Principal;
  readonly sessionId: string;
}
