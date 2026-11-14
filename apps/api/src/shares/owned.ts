import {
  CreateShareRequest,
  type ManagedShare,
  type PublicShare,
  type UpdateShareRequest,
} from "@fdrive/contracts";
import { normalizePath } from "@fdrive/core";
import type { ShareRecord, ShareRepo } from "@fdrive/db";
import type { IdentityStorageFactory } from "../auth/storage-factory.ts";
import { ApiHttpError } from "../errors.ts";
import type { PublicShareAccess } from "./access.ts";
import { shareCall } from "./access.ts";
import type { ShareCredential } from "./credentials.ts";
import { type PublicThumbTarget, type ShareLimits, unavailableReason } from "./limits.ts";
import {
  archiveConflict,
  hiddenFromLinks,
  ownedShareAccess,
  restrictedRoots as restrictedFor,
} from "./owned-access.ts";
import type { SharePasswords } from "./passwords.ts";
import { createShareZipSlots, type ShareZipLimits } from "./zip-limits.ts";

export interface OwnedSharesDeps {
  readonly shares: ShareRepo;
  readonly storageFor: IdentityStorageFactory;
  readonly trashPathFor: (identityId: string) => Promise<string | null>;
  readonly passwords: SharePasswords;
  readonly zipLimits: ShareZipLimits;
  readonly clock: () => Date;
}

/** The row is the whole share. */
export function ownedManagedShare(row: ShareRecord): ManagedShare {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    paths: [...row.paths],
    publicPath: `/s/${row.id}`,
    hasPassword: row.hasPassword,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    maxDownloads: row.maxDownloads,
    usedDownloads: row.views,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    presentation: row.presentation,
  };
}

export function ownedLimits(row: ShareRecord): ShareLimits {
  return { expiresAt: row.expiresAt, maxDownloads: row.maxDownloads, usedDownloads: row.views };
}

const PASSWORD_REJECTED = () =>
  new ApiHttpError("unauthorized", "Share password required or incorrect", {
    reason: "password",
  });

/**
 * Public links fdrive serves itself: rows in `app.shares`, read and written
 * through the owner's own storage. The owner's stored credential is the only
 * way to the bytes, so a share reaches storage only through the identity
 * storage factory, only inside its paths, and only for the operations its
 * scope allows; the password, expiry and download limit are fdrive's to
 * enforce.
 */
export function createOwnedShares(deps: OwnedSharesDeps) {
  const zipSlots = createShareZipSlots(deps.zipLimits.perShare);
  async function storage(identityId: string) {
    try {
      return await deps.storageFor(identityId);
    } catch {
      throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
    }
  }
  /** The folders no link of `identityId`'s may reach (`restrictedRoots`). */
  async function restrictedRoots(identityId: string): Promise<string[]> {
    return restrictedFor(await deps.trashPathFor(identityId));
  }
  /**
   * Every shared path, canonical and outside the restricted and backup
   * folders; several must be able to share one archive, the only way they
   * are served.
   */
  async function admittedPaths(identityId: string, paths: readonly string[]): Promise<string[]> {
    const restricted = await restrictedRoots(identityId);
    const admitted = paths.map((path) => {
      let canonical: string;
      try {
        canonical = normalizePath(path);
      } catch {
        throw new ApiHttpError("bad_request", "Invalid shared path");
      }
      if (hiddenFromLinks(canonical, restricted))
        throw new ApiHttpError(
          "forbidden",
          "The Trash, backup folders and folders shared with you can't be shared",
        );
      return canonical;
    });
    if (archiveConflict(admitted))
      throw new ApiHttpError(
        "bad_request",
        "Two shared items overlap or have the same name. Share them from one folder instead.",
      );
    return admitted;
  }
  /**
   * A single-path share must name something that exists, and an upload
   * share a directory. Many paths are an archive.
   */
  async function layout(
    identityId: string,
    scope: ShareRecord["scope"],
    paths: readonly string[],
  ): Promise<PublicShare["layout"]> {
    const path = paths[0];
    if (path === undefined || paths.length !== 1) return "archive";
    const stat = await shareCall(async () => (await storage(identityId)).stat(path));
    if (scope === "write") {
      if (stat.kind !== "dir")
        throw new ApiHttpError("bad_request", "An upload share must name a directory");
      return "directory";
    }
    return stat.kind === "dir" ? "directory" : "single-file";
  }
  /** Whether `credential` was issued for the password the share has now. */
  async function verify(row: ShareRecord, credential: ShareCredential): Promise<boolean> {
    return credential.verified === deps.passwords.version(await deps.shares.passwordHash(row.id));
  }
  return {
    managedShare: ownedManagedShare,
    async create(identityId: string, body: CreateShareRequest): Promise<ManagedShare> {
      const paths = await admittedPaths(identityId, body.paths);
      await layout(identityId, body.scope, paths);
      const passwordHash =
        body.password === undefined || body.password === ""
          ? null
          : await deps.passwords.hash(body.password);
      const row = await deps.shares.insert({
        identityId,
        name: body.name,
        description: body.description,
        scope: body.scope,
        paths,
        expiresAt: body.expiresAt === null ? null : new Date(body.expiresAt),
        maxDownloads: body.maxDownloads,
        presentation: body.presentation,
        passwordHash,
        at: deps.clock(),
      });
      return ownedManagedShare(row);
    },
    /** A patch is merged onto the row and re-validated as a whole request. */
    async update(row: ShareRecord, patch: UpdateShareRequest): Promise<ManagedShare> {
      const base: CreateShareRequest = {
        name: row.name,
        description: row.description,
        paths: [...row.paths],
        scope: row.scope,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        maxDownloads: row.maxDownloads,
        presentation: row.presentation,
      };
      const merged = CreateShareRequest.parse({ ...base, ...patch });
      const paths = await admittedPaths(row.identityId, merged.paths);
      // An empty password removes it; an absent one keeps what is stored.
      const passwordHash =
        merged.password === undefined
          ? undefined
          : merged.password === ""
            ? null
            : await deps.passwords.hash(merged.password);
      const updated = await deps.shares.updateOwned(row.identityId, row.id, {
        name: merged.name,
        description: merged.description,
        scope: merged.scope,
        paths,
        expiresAt: merged.expiresAt === null ? null : new Date(merged.expiresAt),
        maxDownloads: merged.maxDownloads,
        presentation: merged.presentation,
        ...(passwordHash === undefined ? {} : { passwordHash }),
        at: deps.clock(),
      });
      if (updated === null) throw new ApiHttpError("not_found", "Share unavailable");
      return ownedManagedShare(updated);
    },
    async remove(row: ShareRecord): Promise<void> {
      await deps.shares.removeOwned(row.identityId, row.id);
    },
    /**
     * The one place the password is checked: wrong is refused now, right
     * earns a marker for the current password that every later request
     * compares at the cost of one row read, never a hash. A hash this
     * scheme cannot read matches no password until the owner sets a new one.
     */
    async credential(row: ShareRecord, password: string): Promise<ShareCredential> {
      const hash = row.hasPassword ? await deps.shares.passwordHash(row.id) : null;
      if (row.hasPassword && !(await deps.passwords.verify(password, hash)))
        throw PASSWORD_REJECTED();
      return { verified: deps.passwords.version(hash) };
    },
    async publicMetadata(
      row: ShareRecord,
      credential: ShareCredential | undefined,
    ): Promise<PublicShare> {
      const unavailable = unavailableReason(ownedLimits(row), deps.clock());
      const verifiable = row.hasPassword && unavailable === null;
      const verified =
        verifiable && credential !== undefined ? await verify(row, credential) : false;
      const revealed = !row.hasPassword || verified;
      const kind = revealed ? await layout(row.identityId, row.scope, row.paths) : "directory";
      return {
        name: revealed ? row.name : "",
        description: revealed ? row.description : "",
        scope: row.scope,
        layout: kind,
        presentation: row.presentation,
        fileName:
          revealed && kind === "single-file" ? (row.paths[0]?.split("/").at(-1) ?? null) : null,
        hasPassword: row.hasPassword,
        credentialPresent: credential !== undefined && (!verifiable || verified),
        expiresAt: revealed ? (row.expiresAt?.toISOString() ?? null) : null,
        maxDownloads: revealed ? row.maxDownloads : 0,
        usedDownloads: revealed ? row.views : 0,
        unavailableReason: unavailable,
      };
    },
    async publicAccess(
      row: ShareRecord,
      credential: ShareCredential | undefined,
      scope: "read" | "write",
    ): Promise<PublicShareAccess> {
      if (row.scope !== scope)
        throw new ApiHttpError("forbidden", "This share does not allow this operation");
      const reason = unavailableReason(ownedLimits(row), deps.clock());
      if (reason !== null)
        throw new ApiHttpError(
          "forbidden",
          reason === "expired" ? "Share expired" : "Share download limit reached",
          { reason },
        );
      if (row.hasPassword && (credential === undefined || !(await verify(row, credential))))
        throw PASSWORD_REJECTED();
      const [store, restricted] = await Promise.all([
        storage(row.identityId),
        restrictedRoots(row.identityId),
      ]);
      return ownedShareAccess({
        storage: store,
        view: {
          name: row.name,
          scope: row.scope,
          paths: [...row.paths],
          hasPassword: row.hasPassword,
          maxDownloads: row.maxDownloads,
        },
        restricted,
        consume: async () => (await deps.shares.consume(row.id, deps.clock())) !== null,
        zip: { limits: deps.zipLimits, acquire: () => zipSlots.acquire(row.id) },
      });
    },
    async thumbTarget(
      row: ShareRecord,
      credential: ShareCredential | undefined,
    ): Promise<PublicThumbTarget> {
      return {
        identityId: row.identityId,
        scope: row.scope,
        paths: [...row.paths],
        unavailableReason: unavailableReason(ownedLimits(row), deps.clock()),
        unlocked: !row.hasPassword || (credential !== undefined && (await verify(row, credential))),
      };
    },
  };
}
export type OwnedShares = ReturnType<typeof createOwnedShares>;
