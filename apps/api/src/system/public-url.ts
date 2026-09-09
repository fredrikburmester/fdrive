import {
  PUBLIC_URL_SETTINGS_KEY,
  PublicUrlSettings,
  type PublicUrlUpdateRequest,
} from "@fdrive/contracts";
import type { SettingsRepo } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";

/**
 * The address everyone opens fdrive at (`PublicUrlSettings`), chosen in
 * onboarding. Read by Office (the origin the editor is told fdrive lives
 * at) and by MCP tool results (the base of the links they return).
 */
export interface PublicUrlService {
  configuration(): Promise<PublicUrlSettings>;
  /** The saved origin, or `null` until the owner has set one. */
  current(): Promise<string | null>;
  update(input: PublicUrlUpdateRequest): Promise<PublicUrlSettings>;
}

export function createPublicUrlService(deps: {
  settings: Pick<SettingsRepo, "get" | "compareAndSet">;
  /**
   * The address a deployment configured before it became a setting of its
   * own (Office's per-feature `appUrl`), used as the default until the
   * owner saves one here so an upgrade never disables a working editor.
   */
  legacyUrl?: () => Promise<string | null>;
}): PublicUrlService {
  async function read(): Promise<{ raw: unknown | null; value: PublicUrlSettings }> {
    const raw = await deps.settings.get<unknown>(PUBLIC_URL_SETTINGS_KEY);
    if (raw === null) {
      const legacy = deps.legacyUrl === undefined ? null : await deps.legacyUrl();
      const parsedLegacy = PublicUrlSettings.safeParse({ revision: 0, url: legacy });
      return { raw, value: parsedLegacy.success ? parsedLegacy.data : { revision: 0, url: null } };
    }
    const parsed = PublicUrlSettings.safeParse(raw);
    if (!parsed.success) throw new ApiHttpError("internal", "Stored server address is invalid.");
    return { raw, value: parsed.data };
  }

  return {
    async configuration() {
      return (await read()).value;
    },
    async current() {
      return (await read()).value.url;
    },
    async update(input) {
      const current = await read();
      if (input.revision !== current.value.revision)
        throw new ApiHttpError(
          "conflict",
          "The server address changed in another session. Reload and try again.",
        );
      const next = PublicUrlSettings.parse({ ...input, revision: input.revision + 1 });
      if (!(await deps.settings.compareAndSet(PUBLIC_URL_SETTINGS_KEY, current.raw, next)))
        throw new ApiHttpError(
          "conflict",
          "The server address changed in another session. Reload and try again.",
        );
      return next;
    },
  };
}
