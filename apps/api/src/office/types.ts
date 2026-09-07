import type { HomeTemplate, StorageProvider } from "@fdrive/core";
import type { Identity, Repos, Session, WopiLockRepo } from "@fdrive/db";
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
  readonly tokens: OfficeTokenCodec;
  readonly repos: Pick<Repos, "sessions" | "identities" | "accounts">;
  readonly files: OfficeFileRepo;
  readonly locks: WopiLockRepo;
  readonly withWriteScope: <T>(
    providerId: string,
    callback: (scope: { files: OfficeFileRepo; locks: WopiLockRepo }) => Promise<T>,
  ) => Promise<T>;
  readonly clock: () => Date;
  readonly location: () => Promise<{ providerId: string; homeTemplate: HomeTemplate } | null>;
  readonly storageFactory: (
    identityId: string,
    providerId: string,
  ) => StorageProvider | Promise<StorageProvider>;
  readonly metadata: MetadataService;
  readonly bus: EventBus;
}
export interface OfficeActor {
  readonly identity: Identity;
  readonly session: Session;
  readonly storage: StorageProvider;
  readonly homeTemplate: HomeTemplate;
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
