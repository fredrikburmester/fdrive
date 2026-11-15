import { TrashSettings, type TrashSettingsUpdateRequest } from "@fdrive/contracts";
import type { IdentityRepo, SettingsRepo } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";

export const trashSettingsKey = (providerId: string): string => `trash.configuration.${providerId}`;

export interface TrashSettingsService {
  configuration(providerId: string): Promise<TrashSettings>;
  forIdentity(identityId: string): Promise<TrashSettings>;
  pathForIdentity(identityId: string): Promise<string | null>;
  /** Writes `input` for `providerId`; the body's own `providerId` must name the same server. */
  update(providerId: string, input: TrashSettingsUpdateRequest): Promise<TrashSettings>;
}

/**
 * Trash settings per storage row. Every request reads them, so the value is
 * kept in memory once read and replaced when this service saves a new one:
 * fdrive runs one API process, and nothing else writes them.
 */
export function createTrashSettingsService(deps: {
  settings: Pick<SettingsRepo, "get" | "compareAndSet">;
  identities: Pick<IdentityRepo, "get">;
}): TrashSettingsService {
  const cached = new Map<string, TrashSettings>();
  function defaults(providerId: string): TrashSettings {
    return {
      providerId,
      revision: 0,
      enabled: false,
      path: "/.trash",
      retentionHours: null,
    };
  }

  async function read(providerId: string): Promise<{ raw: unknown | null; value: TrashSettings }> {
    const raw = await deps.settings.get<unknown>(trashSettingsKey(providerId));
    if (raw === null) return { raw, value: defaults(providerId) };
    // A row an older version saved may carry keys this one no longer stores;
    // reading drops them, and the next save writes the row without them.
    const stored = TrashSettings.strip();
    let parsed = stored.safeParse(raw);
    if (!parsed.success && typeof raw === "object") {
      // Older versions accepted overlong UTF-8 path segments. Disable that configuration
      // so authentication and the settings editor stay reachable; the next save repairs it.
      parsed = stored.safeParse({ ...raw, path: "/.trash", enabled: false });
    }
    if (!parsed.success || parsed.data.providerId !== providerId)
      throw new ApiHttpError("internal", "Stored Trash configuration is invalid.");
    return { raw, value: parsed.data };
  }

  async function providerIdForIdentity(identityId: string): Promise<string> {
    const identity = await deps.identities.get(identityId);
    if (identity === null) throw new ApiHttpError("unauthorized", "identity no longer exists");
    return identity.providerId;
  }

  async function configuration(providerId: string): Promise<TrashSettings> {
    const known = cached.get(providerId);
    if (known !== undefined) return known;
    const { value } = await read(providerId);
    cached.set(providerId, value);
    return value;
  }

  async function forIdentity(identityId: string): Promise<TrashSettings> {
    return configuration(await providerIdForIdentity(identityId));
  }

  return {
    configuration,
    forIdentity,
    async pathForIdentity(identityId) {
      const value = await forIdentity(identityId);
      return value.enabled ? value.path : null;
    },
    async update(providerId, input) {
      if (input.providerId !== providerId)
        throw new ApiHttpError(
          "conflict",
          "These Trash settings belong to another storage server. Reload and try again.",
        );
      const current = await read(providerId);
      cached.set(providerId, current.value);
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
      if (
        !(await deps.settings.compareAndSet(trashSettingsKey(providerId), current.raw, next.data))
      ) {
        cached.delete(providerId);
        throw new ApiHttpError(
          "conflict",
          "Trash settings changed in another session. Reload and try again.",
        );
      }
      cached.set(providerId, next.data);
      return next.data;
    },
  };
}
