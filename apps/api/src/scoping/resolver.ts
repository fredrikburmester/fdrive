import { isSafeSegment, type Scope } from "@fdrive/core";
import { SHARED_WITH_ME } from "@fdrive/local";
import { ApiHttpError } from "../errors.js";
import type { ReceivedFolder } from "../local/grants.js";

/**
 * Where each login's files sit in the files folder. Scopes are computed for
 * every request from the username and the grants it has now, so a revoked
 * grant stops at once. See `docs/SCOPING.md`.
 */
export interface ScopeResolver {
  /**
   * The scopes of the login named `username`: its home, `/<username>` in
   * the files folder shown at "/", then one per folder shared with it, at
   * `/Shared with me/<name>`. One grants query; reads neither storage nor
   * the index. An index row these scopes map to and back
   * (`roundTripVirtualPath`) is the login's to see.
   */
  scopesFor(username: string): Promise<readonly Scope[]>;
}

export interface CreateScopeResolverDeps {
  /** The folders others share with `username`, each named as it appears under `Shared with me`. */
  readonly received: (
    username: string,
  ) => Promise<readonly Pick<ReceivedFolder, "owner" | "path" | "name">[]>;
}

/** Builds the `ScopeResolver`, the single source of truth for what logins may read from the index. */
export function createScopeResolver(deps: CreateScopeResolverDeps): ScopeResolver {
  return {
    async scopesFor(username) {
      // The username names the home folder, so it must be exactly one segment.
      if (!isSafeSegment(username)) {
        throw new ApiHttpError("forbidden", "this login has no valid home folder");
      }
      const home: Scope = { fsPrefix: `/${username}`, virtualPrefix: "/" };
      const shared = (await deps.received(username)).map((folder) => ({
        fsPrefix: `/${folder.owner}${folder.path === "/" ? "" : folder.path}`,
        virtualPrefix: `/${SHARED_WITH_ME}/${folder.name}`,
      }));
      return [home, ...shared];
    },
  };
}
