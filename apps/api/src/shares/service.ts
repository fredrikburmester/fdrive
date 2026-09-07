import {
  CreateShareRequest,
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
import type { ConnectionStore } from "../connection/store.ts";
import { ApiHttpError } from "../errors.ts";

export interface SharesDeps {
  repos: Repos;
  shares: ShareRepo;
  clientFor: (baseUrl: string) => SftpgoClient;
  tokenSource: TokenSource;
  connectionStore: ConnectionStore;
  clock: () => Date;
  logger: Logger;
}
export function unavailableReason(share: SftpgoShare, now: Date): "expired" | "limit" | null {
  if (share.expiresAt !== null && share.expiresAt.getTime() <= now.getTime()) return "expired";
  if (share.maxTokens > 0 && share.usedTokens >= share.maxTokens) return "limit";
  return null;
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
  async function owner(identityId: string, accountId?: string) {
    const identity = await deps.repos.identities.get(identityId);
    if (identity === null || (accountId !== undefined && identity.accountId !== accountId))
      throw new ApiHttpError("not_found", "Share unavailable");
    const connection = await deps.connectionStore.current();
    const provider = await deps.repos.providers.get(identity.providerId);
    if (connection === null || provider?.baseUrl !== connection.baseUrl)
      throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
    return { identity, baseUrl: connection.baseUrl };
  }
  async function withOwner<T>(
    identityId: string,
    fn: (api: SftpgoUserApi) => Promise<T>,
    accountId?: string,
  ) {
    const location = await owner(identityId, accountId);
    const client = deps.clientFor(location.baseUrl);
    return deps.tokenSource.withToken(identityId, async (token) => {
      const current = await owner(identityId, accountId);
      if (current.baseUrl !== location.baseUrl)
        throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
      return fn(client.user(token));
    });
  }
  async function mirror(
    identityId: string,
    share: SftpgoShare,
    presentation: ManagedShare["presentation"],
  ) {
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
  async function getUpstream(row: ShareRecord, accountId?: string) {
    try {
      const share = await withOwner(
        row.identityId,
        (api) => api.shares.get(row.sftpgoShareId),
        accountId,
      );
      if (share.rawScope !== undefined && share.rawScope !== 1 && share.rawScope !== 2)
        throw new ApiHttpError("bad_request", "This upstream share scope is unsupported");
      return share;
    } catch (error) {
      if (error instanceof SftpgoError && error.kind === "not_found")
        await deps.shares.removeOwned(row.identityId, row.id);
      throw error;
    }
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
  return {
    async list(input: AccountRequestContext) {
      await liveAccountSession(deps, input);
      await owner(input.principal.identityId, input.principal.accountId);
      const rows = await deps.shares.listOwned(input.principal.identityId, { limit: 1000 });
      const items: ManagedShare[] = [];
      for (const row of rows) {
        try {
          const share = await getUpstream(row, input.principal.accountId);
          items.push(managedShare(await mirror(row.identityId, share, row.presentation), share));
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
        maxDownloads: current.maxTokens,
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
    async publicMetadata(id: string, credentialPresent: boolean): Promise<PublicShare> {
      const { row, share } = await loadPublic(id);
      const kind = await layout(row, share);
      return {
        name: share.name,
        description: share.description,
        scope: share.scope,
        layout: kind,
        presentation: row.presentation,
        fileName: kind === "single-file" ? (share.paths[0]?.split("/").at(-1) ?? null) : null,
        hasPassword: share.hasPassword,
        credentialPresent,
        expiresAt: share.expiresAt?.toISOString() ?? null,
        maxDownloads: share.maxTokens,
        usedDownloads: share.usedTokens,
        unavailableReason: unavailableReason(share, deps.clock()),
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
  };
}
export type SharesService = ReturnType<typeof createSharesService>;
