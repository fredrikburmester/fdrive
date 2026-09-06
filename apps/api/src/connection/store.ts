import type { SettingsRepo } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";

/** The settings key the SFTPGo connection is stored under. */
export const CONNECTION_SETTINGS_KEY = "connection.sftpgo";

/** How long `ConnectionStore.current()` caches a resolved connection before re-reading settings. */
export const CONNECTION_CACHE_TTL_MS = 5000;

/**
 * The SFTPGo connection fdrive currently talks to: where to reach it and
 * how to derive a user's home directory. `source` is `"env"` when
 * `SFTPGO_URL` is set (in which case `baseUrl` can never be changed at
 * runtime, though `homeTemplate` still can) and `"settings"` when the base
 * URL itself was configured through `/setup` or the admin connection page.
 */
export interface Connection {
  readonly baseUrl: string;
  readonly homeTemplate: string;
  readonly source: "env" | "settings";
}

/**
 * The shape stored at `CONNECTION_SETTINGS_KEY`. `baseUrl` is present only
 * when the base URL itself is settings-managed; when `SFTPGO_URL` is set,
 * only `homeTemplate` (an override of the env default) is ever stored
 * here.
 */
export interface StoredConnection {
  readonly baseUrl?: string;
  readonly homeTemplate?: string;
}

export interface ConnectionStorePatch {
  readonly baseUrl?: string;
  readonly homeTemplate?: string;
}

export interface ConnectionStore {
  /**
   * Returns the active connection, or null while setup is required. Cached
   * for `CONNECTION_CACHE_TTL_MS` so a hot path (every authenticated
   * request) does not read `settings` on every call.
   */
  current(): Promise<Connection | null>;
  /**
   * Applies `patch` to the stored connection (creating it when none
   * exists yet) and returns the result. Throws `ApiHttpError("forbidden",
   * ...)` when `patch.baseUrl` is given while the active source is `"env"`,
   * and `ApiHttpError("bad_request", ...)` when no `baseUrl` is available
   * at all (neither `patch` nor a previously stored connection has one,
   * and there is no `SFTPGO_URL`).
   */
  update(patch: ConnectionStorePatch): Promise<Connection>;
}

export interface CreateConnectionStoreDeps {
  readonly settings: SettingsRepo;
  readonly envUrl: string | undefined;
  readonly defaultHomeTemplate: string;
  readonly clock?: () => Date;
}

/**
 * Builds a `ConnectionStore` resolving, in order: the `SFTPGO_URL`
 * environment variable (source `"env"`, `homeTemplate` still overridable
 * from `settings`), then a base URL previously stored in `settings`
 * (source `"settings"`), then `null` (setup required).
 */
export function createConnectionStore(deps: CreateConnectionStoreDeps): ConnectionStore {
  const clock = deps.clock ?? (() => new Date());
  let cache: { value: Connection | null; expiresAtMs: number } | null = null;

  async function resolveUncached(): Promise<Connection | null> {
    const stored = await deps.settings.get<StoredConnection>(CONNECTION_SETTINGS_KEY);

    if (deps.envUrl !== undefined && deps.envUrl.length > 0) {
      return {
        baseUrl: deps.envUrl,
        homeTemplate: stored?.homeTemplate ?? deps.defaultHomeTemplate,
        source: "env",
      };
    }

    if (stored?.baseUrl === undefined) {
      return null;
    }
    return {
      baseUrl: stored.baseUrl,
      homeTemplate: stored.homeTemplate ?? deps.defaultHomeTemplate,
      source: "settings",
    };
  }

  function fillCache<T extends Connection | null>(value: T): T {
    cache = { value, expiresAtMs: clock().getTime() + CONNECTION_CACHE_TTL_MS };
    return value;
  }

  return {
    async current() {
      const nowMs = clock().getTime();
      if (cache !== null && cache.expiresAtMs > nowMs) {
        return cache.value;
      }
      return fillCache(await resolveUncached());
    },

    async update(patch) {
      const existing = await resolveUncached();

      if (existing !== null && existing.source === "env") {
        if (patch.baseUrl !== undefined) {
          throw new ApiHttpError(
            "forbidden",
            "the SFTPGo base URL is set by SFTPGO_URL and cannot be changed here",
          );
        }

        const stored = await deps.settings.get<StoredConnection>(CONNECTION_SETTINGS_KEY);
        const nextHomeTemplate =
          patch.homeTemplate ?? stored?.homeTemplate ?? deps.defaultHomeTemplate;
        await deps.settings.set(CONNECTION_SETTINGS_KEY, {
          baseUrl: stored?.baseUrl,
          homeTemplate: nextHomeTemplate,
        });
        return fillCache({
          baseUrl: existing.baseUrl,
          homeTemplate: nextHomeTemplate,
          source: "env",
        });
      }

      const stored = await deps.settings.get<StoredConnection>(CONNECTION_SETTINGS_KEY);
      const nextBaseUrl = patch.baseUrl ?? stored?.baseUrl;
      if (nextBaseUrl === undefined) {
        throw new ApiHttpError("bad_request", "baseUrl is required");
      }
      const nextHomeTemplate =
        patch.homeTemplate ?? stored?.homeTemplate ?? deps.defaultHomeTemplate;

      await deps.settings.set(CONNECTION_SETTINGS_KEY, {
        baseUrl: nextBaseUrl,
        homeTemplate: nextHomeTemplate,
      });

      return fillCache({
        baseUrl: nextBaseUrl,
        homeTemplate: nextHomeTemplate,
        source: "settings",
      }) as Connection;
    },
  };
}
