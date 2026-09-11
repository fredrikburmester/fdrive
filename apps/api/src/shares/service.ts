import {
  CreateShareRequest,
  MAX_SHARE_DOWNLOADS,
  type ManagedShare,
  type PublicShare,
  type UpdateShareRequest,
} from "@fdrive/contracts";
import type { Repos, ShareRecord, ShareRepo } from "@fdrive/db";
import {
  type SftpgoClient,
  SftpgoError,
  type SftpgoShare,
  type SftpgoShareInput,
  type SftpgoUserApi,
} from "@fdrive/sftpgo";
import type { Logger } from "pino";
import { liveAccountSession } from "../accounts/service.ts";
import type { AccountRequestContext } from "../accounts/types.ts";
import type { TokenSource } from "../auth/token-source.ts";
import { ApiHttpError } from "../errors.ts";
import type { ProviderService } from "../providers/service.ts";

export interface SharesDeps {
  repos: Repos;
  shares: ShareRepo;
  clientFor: (baseUrl: string) => SftpgoClient;
  tokenSource: Pick<TokenSource, "get" | "invalidate">;
  providers: Pick<ProviderService, "forIdentity">;
  clock: () => Date;
  logger: Logger;
}
export function unavailableReason(share: SftpgoShare, now: Date): "expired" | "limit" | null {
  if (share.expiresAt !== null && share.expiresAt.getTime() <= now.getTime()) return "expired";
  if (share.maxTokens > 0 && share.usedTokens >= share.maxTokens) return "limit";
  return null;
}
/**
 * Everything the public share thumb route needs to decide whether a
 * thumbnail may be served, without reaching into `ShareRepo` or the SFTPGo
 * client itself: see `SharesService.publicThumbTarget`.
 */
export interface PublicThumbTarget {
  readonly identityId: string;
  readonly sftpgoShareId: string;
  readonly scope: SftpgoShare["scope"];
  readonly paths: readonly string[];
  readonly hasPassword: boolean;
  readonly unavailableReason: ReturnType<typeof unavailableReason>;
}
export function managedShare(row: ShareRecord, share: SftpgoShare): ManagedShare {
  return {
    id: row.id,
    name: share.name,
    description: share.description,
    scope: share.scope,
    paths: share.paths,
    publicPath: `/s/${row.id}`,
    hasPassword: share.hasPassword,
    expiresAt: share.expiresAt?.toISOString() ?? null,
    maxDownloads: share.maxTokens,
    usedDownloads: share.usedTokens,
    createdAt: share.createdAt.toISOString(),
    updatedAt: share.updatedAt.toISOString(),
    presentation: row.presentation,
  };
}
export function shareInput(input: CreateShareRequest): SftpgoShareInput {
  return {
    name: input.name,
    description: input.description,
    paths: input.paths,
    scope: input.scope,
    expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
    maxTokens: input.maxDownloads,
    ...(input.password === undefined ? {} : { password: input.password }),
  };
}
export async function shareCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiHttpError) throw error;
    if (error instanceof SftpgoError) {
      if (error.kind === "not_found") throw new ApiHttpError("not_found", "Share unavailable");
      if (error.kind === "unauthorized" || error.kind === "forbidden")
        throw new ApiHttpError("forbidden", "Share access denied");
      if (error.kind === "bad_request")
        throw new ApiHttpError("bad_request", "Share operation rejected by storage");
    }
    throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
  }
}
export function createSharesService(deps: SharesDeps) {
  /**
   * Shares are an SFTPGo feature: the identity's provider must be an
   * enabled SFTPGo row, and the client is bound to that row's endpoint for
   * the operation's lifetime.
   */
  async function owner(identityId: string, accountId?: string) {
    const identity = await deps.repos.identities.get(identityId);
    if (identity === null || (accountId !== undefined && identity.accountId !== accountId))
      throw new ApiHttpError("not_found", "Share unavailable");
    let resolved: Awaited<ReturnType<ProviderService["forIdentity"]>>;
    try {
      resolved = await deps.providers.forIdentity(identityId);
    } catch {
      throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
    }
    if (resolved.provider.type !== "sftpgo")
      throw new ApiHttpError("unsupported", "Sharing is not available for this storage", {
        capability: "shares",
      });
    return { identity, baseUrl: resolved.provider.baseUrl };
  }
  /** Runs `fn` with the owner's JWT, re-minting once when SFTPGo answers 401. */
  async function withOwner<T>(
    identityId: string,
    fn: (api: SftpgoUserApi) => Promise<T>,
    accountId?: string,
  ) {
    const location = await owner(identityId, accountId);
    const client = deps.clientFor(location.baseUrl);
    const call = async (): Promise<T> => {
      const token = await deps.tokenSource.get(identityId);
      if (token === null)
        throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
      const current = await owner(identityId, accountId);
      if (current.baseUrl !== location.baseUrl)
        throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
      return fn(client.user(token));
    };
    try {
      return await call();
    } catch (error) {
      if (error instanceof SftpgoError && error.kind === "unauthorized") {
        await deps.tokenSource.invalidate(identityId);
        return await call();
      }
      throw error;
    }
  }
  /** True when the stored row already holds everything `mirror` would write. */
  function mirrored(
    row: ShareRecord,
    share: SftpgoShare,
    presentation: ManagedShare["presentation"],
  ) {
    return (
      row.sftpgoShareId === share.id &&
      row.name === share.name &&
      row.scope === share.scope &&
      row.paths.length === share.paths.length &&
      row.paths.every((path, index) => path === share.paths[index]) &&
      row.hasPassword === share.hasPassword &&
      (row.expiresAt?.getTime() ?? null) === (share.expiresAt?.getTime() ?? null) &&
      row.views === share.usedTokens &&
      row.presentation === presentation
    );
  }
  /**
   * Reconciles the local mirror with the live upstream share. `current` is the
   * stored row when the caller already holds it: an unchanged row needs no
   * write, which keeps listing N untouched shares at zero writes.
   */
  async function mirror(
    identityId: string,
    share: SftpgoShare,
    presentation: ManagedShare["presentation"],
    current?: ShareRecord,
  ) {
    if (current !== undefined && mirrored(current, share, presentation)) return current;
    return deps.shares.upsert({
      identityId,
      sftpgoShareId: share.id,
      name: share.name,
      scope: share.scope,
      paths: share.paths,
      hasPassword: share.hasPassword,
      expiresAt: share.expiresAt,
      views: share.usedTokens,
      presentation,
      at: deps.clock(),
    });
  }
  function supported(share: SftpgoShare) {
    if (share.rawScope !== undefined && share.rawScope !== 1 && share.rawScope !== 2)
      throw new ApiHttpError("bad_request", "This upstream share scope is unsupported");
    return share;
  }
  /** Single-share read. The only call that may conclude a share is gone upstream. */
  async function getUpstream(row: ShareRecord, accountId?: string) {
    try {
      return supported(
        await withOwner(row.identityId, (api) => api.shares.get(row.sftpgoShareId), accountId),
      );
    } catch (error) {
      if (error instanceof SftpgoError && error.kind === "not_found")
        await deps.shares.removeOwned(row.identityId, row.id);
      throw error;
    }
  }
  /**
   * One bulk upstream read for a whole listing, keyed by SFTPGo share id.
   * SFTPGo caps this page (`SHARES_LIST_LIMIT`) below the local row limit, so
   * absence from the map never proves deletion on its own.
   */
  async function listUpstream(identityId: string, accountId?: string) {
    const shares = await withOwner(identityId, (api) => api.shares.list(), accountId);
    return new Map(shares.map((share) => [share.id, share]));
  }
  async function managed(input: AccountRequestContext, id: string) {
    await liveAccountSession(deps, input);
    await owner(input.principal.identityId, input.principal.accountId);
    const row = await deps.shares.getOwned(input.principal.identityId, id);
    if (row === null) throw new ApiHttpError("not_found", "Share unavailable");
    return row;
  }
  async function loadPublic(id: string) {
    const row = await deps.shares.get(id);
    if (row === null) throw new ApiHttpError("not_found", "Share unavailable");
    const share = await getUpstream(row);
    return { row, share };
  }
  async function layout(
    row: Pick<ShareRecord, "identityId">,
    share: SftpgoShare,
  ): Promise<PublicShare["layout"]> {
    const path = share.paths[0];
    if (path === undefined || share.paths.length !== 1) return "archive";
    if (share.scope === "write") return "directory";
    return withOwner(row.identityId, async (api) => {
      try {
        await api.statFile(path);
        return "single-file";
      } catch (error) {
        if (!(error instanceof SftpgoError) || error.kind !== "bad_request") throw error;
        await api.list(path);
        return "directory";
      }
    });
  }
  /**
   * Verifies `password` for a password-protected share by listing its
   * root through the public-share API, the same call `/entries` already
   * makes: it consumes no download token, unlike an actual file
   * download. `false` for a rejected password. SFTPGo checks the
   * password before checking whether the share is a listable directory,
   * so a single-file share (the common case for one shared image)
   * answers a *correct* password with `bad_request` ("listing requires a
   * single directory share") rather than a listing; reaching that error
   * still proves the password was accepted, so it counts as verified
   * too. Any other failure (the owner's connection, upstream
   * reachability) propagates so the caller does not cache a transient
   * failure as a settled "wrong password".
   */
  async function verifyPassword(
    identityId: string,
    sftpgoShareId: string,
    password: string,
  ): Promise<boolean> {
    const location = await owner(identityId);
    try {
      await deps.clientFor(location.baseUrl).publicShare(sftpgoShareId, password).list();
      return true;
    } catch (error) {
      if (
        error instanceof SftpgoError &&
        (error.kind === "unauthorized" || error.kind === "forbidden")
      )
        return false;
      if (error instanceof SftpgoError && error.kind === "bad_request") return true;
      throw error;
    }
  }
  return {
    /** Cheap local admission check for the public route limiter. */
    async publicShareExists(id: string): Promise<boolean> {
      return (await deps.shares.get(id)) !== null;
    },
    async list(input: AccountRequestContext) {
      await liveAccountSession(deps, input);
      await owner(input.principal.identityId, input.principal.accountId);
      const rows = await deps.shares.listOwned(input.principal.identityId, { limit: 1000 });
      const items: ManagedShare[] = [];
      if (rows.length === 0) return { items };
      // One bulk read replaces the per-row upstream GET. The page is smaller
      // than the row limit, so a row missing from it is either deleted
      // upstream or merely past the page end; only the single-share read can
      // tell those apart, and only it prunes.
      const upstream = await listUpstream(input.principal.identityId, input.principal.accountId);
      for (const row of rows) {
        try {
          const listed = upstream.get(row.sftpgoShareId);
          const share =
            listed === undefined
              ? await getUpstream(row, input.principal.accountId)
              : supported(listed);
          items.push(
            managedShare(await mirror(row.identityId, share, row.presentation, row), share),
          );
        } catch (error) {
          if (!(error instanceof SftpgoError) || error.kind !== "not_found") throw error;
        }
      }
      return { items };
    },
    async get(input: AccountRequestContext, id: string) {
      const row = await managed(input, id);
      const share = await getUpstream(row, input.principal.accountId);
      return managedShare(await mirror(row.identityId, share, row.presentation), share);
    },
    async create(input: AccountRequestContext, body: CreateShareRequest) {
      await liveAccountSession(deps, input);
      return withOwner(
        input.principal.identityId,
        async (api) => {
          const { id } = await api.shares.create(shareInput(body));
          try {
            const share = await api.shares.get(id);
            await layout({ identityId: input.principal.identityId }, share);
            const row = await mirror(input.principal.identityId, share, body.presentation);
            return managedShare(row, share);
          } catch (error) {
            try {
              await api.shares.remove(id);
            } catch {
              deps.logger.error("Share creation compensation failed");
            }
            throw error;
          }
        },
        input.principal.accountId,
      );
    },
    async update(input: AccountRequestContext, id: string, patch: UpdateShareRequest) {
      const row = await managed(input, id);
      const current = await getUpstream(row, input.principal.accountId);
      const base: CreateShareRequest = {
        name: current.name,
        description: current.description,
        paths: current.paths,
        scope: current.scope,
        expiresAt: current.expiresAt?.toISOString() ?? null,
        // A patch is merged onto the stored share and re-validated as a whole
        // request, so a limit SFTPGo already holds from before MAX_SHARE_DOWNLOADS
        // existed would otherwise fail every later edit, even a rename. Bring it
        // into range instead: an untouched limit that high never runs out anyway.
        maxDownloads: Math.min(current.maxTokens, MAX_SHARE_DOWNLOADS),
        presentation: row.presentation,
      };
      const merged = CreateShareRequest.parse({ ...base, ...patch });
      await withOwner(
        row.identityId,
        (api) =>
          api.shares.update(row.sftpgoShareId, {
            ...shareInput(merged),
            allowFrom: current.allowFrom,
          }),
        input.principal.accountId,
      );
      const share = await getUpstream(row, input.principal.accountId);
      return managedShare(await mirror(row.identityId, share, merged.presentation), share);
    },
    async remove(input: AccountRequestContext, id: string) {
      const row = await managed(input, id);
      try {
        await withOwner(
          row.identityId,
          (api) => api.shares.remove(row.sftpgoShareId),
          input.principal.accountId,
        );
      } catch (error) {
        if (!(error instanceof SftpgoError) || error.kind !== "not_found") throw error;
      }
      await deps.shares.removeOwned(row.identityId, id);
    },
    /**
     * Possessing a share's UUID reveals nothing about it: for a
     * password-protected share the name, description, file name, layout,
     * expiry and download counts are withheld until `password` verifies
     * (through the same token-free root listing the thumb route uses).
     * A write share cannot be listed, so only its upload ever checks the
     * password: its details stay withheld and `credentialPresent` merely
     * reports that a password cookie is set, as it does for an expired share.
     */
    async publicMetadata(id: string, password: string | undefined): Promise<PublicShare> {
      const { row, share } = await loadPublic(id);
      const unavailable = unavailableReason(share, deps.clock());
      const verifiable = share.hasPassword && share.scope === "read" && unavailable === null;
      const verified =
        verifiable && password !== undefined
          ? await verifyPassword(row.identityId, share.id, password)
          : false;
      const revealed = !share.hasPassword || verified;
      const kind = revealed ? await layout(row, share) : "directory";
      return {
        name: revealed ? share.name : "",
        description: revealed ? share.description : "",
        scope: share.scope,
        layout: kind,
        presentation: row.presentation,
        fileName:
          revealed && kind === "single-file" ? (share.paths[0]?.split("/").at(-1) ?? null) : null,
        hasPassword: share.hasPassword,
        credentialPresent: password !== undefined && (!verifiable || verified),
        expiresAt: revealed ? (share.expiresAt?.toISOString() ?? null) : null,
        maxDownloads: revealed ? share.maxTokens : 0,
        usedDownloads: revealed ? share.usedTokens : 0,
        unavailableReason: unavailable,
      };
    },
    async publicAccess(id: string, password: string | undefined, scope: "read" | "write") {
      const { row, share } = await loadPublic(id);
      if (share.scope !== scope)
        throw new ApiHttpError("forbidden", "This share does not allow this operation");
      const reason = unavailableReason(share, deps.clock());
      if (reason !== null)
        throw new ApiHttpError(
          "forbidden",
          reason === "expired" ? "Share expired" : "Share download limit reached",
          { reason },
        );
      const location = await owner(row.identityId);
      return { share, api: deps.clientFor(location.baseUrl).publicShare(share.id, password) };
    },
    /**
     * Loads just enough of a share for the public thumb route to decide
     * whether it may serve a thumbnail: the owning identity, scope,
     * shared paths, password requirement, and expiry/limit state. Throws
     * (never distinguishing why) when the share row is gone, the upstream
     * share is gone, or the owner's connection is unreachable; the route
     * turns every one of those into the same 404.
     */
    async publicThumbTarget(id: string): Promise<PublicThumbTarget> {
      const { row, share } = await loadPublic(id);
      return {
        identityId: row.identityId,
        sftpgoShareId: share.id,
        scope: share.scope,
        paths: share.paths,
        hasPassword: share.hasPassword,
        unavailableReason: unavailableReason(share, deps.clock()),
      };
    },
    verifySharePassword: verifyPassword,
  };
}
export type SharesService = ReturnType<typeof createSharesService>;
