import type { CreateShareRequest, PublicShare, UpdateShareRequest } from "@fdrive/contracts";
import type { Repos, ShareRecord, ShareRepo } from "@fdrive/db";
import { liveAccountSession } from "../accounts/service.ts";
import type { AccountRequestContext } from "../accounts/types.ts";
import type { IdentityStorageFactory } from "../auth/storage-factory.ts";
import { ApiHttpError } from "../errors.ts";
import type { ProviderService } from "../providers/service.ts";
import type { PublicShareAccess } from "./access.ts";
import type { ShareCredential } from "./credentials.ts";
import type { PublicThumbTarget } from "./limits.ts";
import { createOwnedShares } from "./owned.ts";
import type { SharePasswords } from "./passwords.ts";
import { DEFAULT_SHARE_ZIP_LIMITS, type ShareZipLimits } from "./zip-limits.ts";

export interface SharesDeps {
  repos: Repos;
  shares: ShareRepo;
  providers: Pick<ProviderService, "forIdentity">;
  /** The owner's storage as every feature gets it: the only way a share reaches bytes. */
  storageFor: IdentityStorageFactory;
  /** The owner's Trash folder while Trash is on: never shared and never listed through a share. */
  trashPathFor: (identityId: string) => Promise<string | null>;
  passwords: SharePasswords;
  /** Ceilings on public archive downloads; each one left out keeps its default. */
  zipLimits?: Partial<ShareZipLimits>;
  clock: () => Date;
}

/**
 * Public links: rows in `app.shares` that fdrive serves through the owner's
 * storage. This layer decides who may act on a share, the owner's live
 * session for management and the owner's module for everything, and leaves
 * what a share is to `createOwnedShares`.
 */
export function createSharesService(deps: SharesDeps) {
  const owned = createOwnedShares({
    shares: deps.shares,
    storageFor: deps.storageFor,
    trashPathFor: deps.trashPathFor,
    passwords: deps.passwords,
    zipLimits: { ...DEFAULT_SHARE_ZIP_LIMITS, ...deps.zipLimits },
    clock: deps.clock,
  });
  /**
   * Checks that `identityId` still exists and that its storage serves
   * shares: the module's share strategy decides, never its type, and `none`
   * is refused with the capability the web reads to state the limit. Which
   * account may act for the identity is the live session's to check.
   */
  async function owner(identityId: string): Promise<void> {
    if ((await deps.repos.identities.get(identityId)) === null)
      throw new ApiHttpError("not_found", "Share unavailable");
    let strategy: string;
    try {
      strategy = (await deps.providers.forIdentity(identityId)).module.shares;
    } catch {
      throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
    }
    if (strategy !== "owned")
      throw new ApiHttpError("unsupported", "Sharing is not available for this storage", {
        capability: "shares",
      });
  }
  /** The caller's live session and the share it names, once its storage still shares. */
  async function managed(input: AccountRequestContext, id: string): Promise<ShareRecord> {
    await liveAccountSession(deps, input);
    await owner(input.principal.identityId);
    const row = await deps.shares.getOwned(input.principal.identityId, id);
    if (row === null) throw new ApiHttpError("not_found", "Share unavailable");
    return row;
  }
  /** A public row, once its owner's storage still shares. */
  async function loadPublic(id: string): Promise<ShareRecord> {
    const row = await deps.shares.get(id);
    if (row === null) throw new ApiHttpError("not_found", "Share unavailable");
    await owner(row.identityId);
    return row;
  }
  return {
    /** Cheap local admission check for the public route limiter. */
    async publicShareExists(id: string): Promise<boolean> {
      return (await deps.shares.get(id)) !== null;
    },
    async list(input: AccountRequestContext) {
      await liveAccountSession(deps, input);
      await owner(input.principal.identityId);
      const rows = await deps.shares.listOwned(input.principal.identityId, { limit: 1000 });
      return { items: rows.map(owned.managedShare) };
    },
    async get(input: AccountRequestContext, id: string) {
      return owned.managedShare(await managed(input, id));
    },
    /** The row as history records it, read before a change so it can report what it replaced. */
    async activitySnapshot(input: AccountRequestContext, id: string) {
      const row = await managed(input, id);
      return { ...row, expiresAt: row.expiresAt?.toISOString() ?? null };
    },
    async create(input: AccountRequestContext, body: CreateShareRequest) {
      await liveAccountSession(deps, input);
      await owner(input.principal.identityId);
      return owned.create(input.principal.identityId, body);
    },
    async update(input: AccountRequestContext, id: string, patch: UpdateShareRequest) {
      return owned.update(await managed(input, id), patch);
    },
    async remove(input: AccountRequestContext, id: string) {
      await owned.remove(await managed(input, id));
    },
    /**
     * Possessing a share's UUID reveals nothing about it: for a
     * password-protected share the name, description, file name, layout,
     * expiry and download counts are withheld until the credential verifies.
     * The password is checked when the cookie is issued, so a write share
     * reveals itself to a verified visitor too.
     */
    async publicMetadata(
      id: string,
      credential: ShareCredential | undefined,
    ): Promise<PublicShare> {
      return owned.publicMetadata(await loadPublic(id), credential);
    },
    /**
     * The share as the public routes may use it, once its scope, expiry,
     * download budget and the visitor's credential allow `scope`.
     */
    async publicAccess(
      id: string,
      credential: ShareCredential | undefined,
      scope: "read" | "write",
    ): Promise<PublicShareAccess> {
      return owned.publicAccess(await loadPublic(id), credential, scope);
    },
    /** What the credential cookie seals once `password` checks out; a wrong one is refused. */
    async credential(id: string, password: string): Promise<ShareCredential> {
      return owned.credential(await loadPublic(id), password);
    },
    /**
     * Loads just enough of a share for the public thumb route to decide
     * whether it may serve a thumbnail, including whether `credential` opens
     * it, without spending any of its budget. Throws (never distinguishing
     * why) when the row is gone or its owner's storage no longer shares; the
     * route turns every one of those into the same 404.
     */
    async publicThumbTarget(
      id: string,
      credential: ShareCredential | undefined,
    ): Promise<PublicThumbTarget> {
      return owned.thumbTarget(await loadPublic(id), credential);
    },
  };
}
export type SharesService = ReturnType<typeof createSharesService>;
