import { TrashSettings, type TrashSettingsUpdateRequest } from "@fdrive/contracts";
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
}): TrashSettingsService {
  function defaults(providerId: string): TrashSettings {
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
    if (raw === null) return { raw, value: defaults(providerId) };
    const parsed = TrashSettings.safeParse(raw);
    if (!parsed.success || parsed.data.providerId !== providerId)
      throw new ApiHttpError("internal", "Stored Trash configuration is invalid.");
    return { raw, value: parsed.data };
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
          "The active SFTPGo provider changed. Reload Trash settings and try again.",
        );
      const current = await read(activeProviderId);
      if (input.revision !== current.value.revision)
        throw new ApiHttpError(
          "conflict",
          "Trash settings changed in another session. Reload and try again.",
        );
      const next = TrashSettings.parse({ ...input, revision: input.revision + 1 });
      if (
        !(await deps.settings.compareAndSet(trashSettingsKey(activeProviderId), current.raw, next))
      )
        throw new ApiHttpError(
          "conflict",
          "Trash settings changed in another session. Reload and try again.",
        );
      return next;
    },
  };
}
