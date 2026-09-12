import {
  TrashConfiguration,
  TrashSettings,
  type TrashSettingsUpdateRequest,
  type TrashStrategy,
} from "@fdrive/contracts";
import type { IdentityRepo, SettingsRepo } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";

export const trashSettingsKey = (providerId: string): string => `trash.configuration.${providerId}`;

export interface TrashSettingsService {
  configuration(providerId: string): Promise<TrashSettings>;
  forIdentity(identityId: string): Promise<TrashSettings>;
  pathForIdentity(identityId: string): Promise<string | null>;
  update(activeProviderId: string, input: TrashSettingsUpdateRequest): Promise<TrashSettings>;
}

export function createTrashSettingsService(deps: {
  settings: Pick<SettingsRepo, "get" | "compareAndSet">;
  identities: Pick<IdentityRepo, "get">;
  /**
   * The provider module's Trash strategy for a row: `native` (the backend
   * recycles deletes itself), `move` (fdrive moves them) or `none`. Only
   * the stored configuration is persisted; the strategy is read fresh so a
   * module change never leaves a stale value behind.
   */
  strategyFor: (providerId: string) => Promise<TrashStrategy>;
}): TrashSettingsService {
  function defaults(providerId: string): TrashConfiguration {
    return {
      providerId,
      revision: 0,
      enabled: false,
      path: "/.trash",
      retentionHours: null,
      rulesConfirmed: false,
    };
  }

  async function read(providerId: string): Promise<{ raw: unknown | null; value: TrashSettings }> {
    const raw = await deps.settings.get<unknown>(trashSettingsKey(providerId));
    const strategy = await deps.strategyFor(providerId);
    if (raw === null) return { raw, value: { ...defaults(providerId), strategy } };
    const parsed = TrashConfiguration.safeParse(raw);
    if (!parsed.success || parsed.data.providerId !== providerId)
      throw new ApiHttpError("internal", "Stored Trash configuration is invalid.");
    // A stored row that predates a module change may be enabled for a
    // strategy that no longer allows it; the strategy wins.
    const value = TrashSettings.safeParse({ ...parsed.data, strategy });
    return {
      raw,
      value: value.success ? value.data : { ...parsed.data, strategy, enabled: false },
    };
  }

  async function providerIdForIdentity(identityId: string): Promise<string> {
    const identity = await deps.identities.get(identityId);
    if (identity === null) throw new ApiHttpError("unauthorized", "identity no longer exists");
    return identity.providerId;
  }

  async function forIdentity(identityId: string): Promise<TrashSettings> {
    return (await read(await providerIdForIdentity(identityId))).value;
  }

  return {
    async configuration(providerId) {
      return (await read(providerId)).value;
    },
    forIdentity,
    async pathForIdentity(identityId) {
      const value = await forIdentity(identityId);
      return value.enabled ? value.path : null;
    },
    async update(activeProviderId, input) {
      if (input.providerId !== activeProviderId)
        throw new ApiHttpError(
          "conflict",
          "The active storage provider changed. Reload Trash settings and try again.",
        );
      const current = await read(activeProviderId);
      if (input.strategy !== current.value.strategy)
        throw new ApiHttpError(
          "conflict",
          "The storage provider's Trash strategy changed. Reload Trash settings and try again.",
        );
      if (input.revision !== current.value.revision)
        throw new ApiHttpError(
          "conflict",
          "Trash settings changed in another session. Reload and try again.",
        );
      const next = TrashSettings.safeParse({ ...input, revision: input.revision + 1 });
      if (!next.success)
        throw new ApiHttpError("bad_request", "Invalid Trash settings.", {
          issues: next.error.issues,
        });
      const { strategy, ...stored } = next.data;
      if (
        !(await deps.settings.compareAndSet(
          trashSettingsKey(activeProviderId),
          current.raw,
          TrashConfiguration.parse(stored),
        ))
      )
        throw new ApiHttpError(
          "conflict",
          "Trash settings changed in another session. Reload and try again.",
        );
      return { ...stored, strategy };
    },
  };
}
