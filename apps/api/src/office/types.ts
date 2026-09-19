import type { Scope, StorageProvider } from "@fdrive/core";
import type { Identity, Repos, Session, WopiLockRepo } from "@fdrive/db";
import type { PersonalActivityService } from "../activity/service.js";
import type { Principal } from "../auth/principal.js";
import type { EventBus } from "../events/bus.js";
import type { MetadataService } from "../metadata/service.js";
import type { DiscoveryCache } from "./protocol/discovery-cache.ts";
import type { OfficeTokenCodec } from "./tokens.ts";

export interface OfficeFile {
  readonly id: string;
  readonly providerId: string;
  readonly rootName: string;
  readonly path: string;
  readonly createdAt: Date;
}
export interface OfficeFileRepo {
  ensure(input: { providerId: string; rootName: string; path: string }): Promise<OfficeFile>;
  get(id: string): Promise<OfficeFile | null>;
  movePrefix(input: {
    providerId: string;
    rootName: string;
    from: string;
    to: string;
    at: Date;
  }): Promise<void>;
  deletePrefix(input: {
    providerId: string;
    rootName: string;
    path: string;
    at: Date;
  }): Promise<void>;
}
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
  readonly locks: WopiLockRepo;
  readonly withWriteScope: <T>(
    providerId: string,
    callback: (scope: { files: OfficeFileRepo; locks: WopiLockRepo }) => Promise<T>,
  ) => Promise<T>;
  readonly clock: () => Date;
  /**
   * Resolves `identity`'s trusted, administrator-controlled scope mapping
   * (`ScopeResolver.configuredMappings`, not `verifiedIndexScopes`: office
   * must keep working when the indexer is down), or `null` when the
   * identity's provider does not match the currently configured connection.
   */
  readonly location: (
    identity: Identity,
  ) => Promise<{ providerId: string; scopes: readonly Scope[] } | null>;
  readonly storageFactory: (
    identityId: string,
    providerId: string,
  ) => StorageProvider | Promise<StorageProvider>;
  readonly metadata: MetadataService;
  readonly bus: EventBus;
  /** Optional so office tests and deployments without history keep working.
   * Explicitly `undefined` is allowed so a caller can clear it in a spread. */
  readonly activity?: PersonalActivityService | undefined;
}
export interface OfficeActor {
  readonly identity: Identity;
  readonly session: Session;
  readonly storage: StorageProvider;
  /** The identity's configured scope mapping, resolved once when the actor was built. */
  readonly scopes: readonly Scope[];
}
export interface OpenedFile {
  readonly actor: OfficeActor;
  readonly file: OfficeFile;
  readonly path: string;
  readonly stat: Awaited<ReturnType<StorageProvider["statFile"]>>;
  readonly mode: "view" | "edit";
  readonly editAllowed: boolean;
}
export interface BrowserOfficeInput {
  readonly principal: Principal;
  readonly sessionId: string;
}
