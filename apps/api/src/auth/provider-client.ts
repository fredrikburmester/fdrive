import type { Repos } from "@fdrive/db";
import type { SftpgoClient } from "@fdrive/sftpgo";
import type { ConnectionStore } from "../connection/store.js";
import { ApiHttpError } from "../errors.js";

export type ClientForBaseUrl = (baseUrl: string) => SftpgoClient;
export type ClientForIdentity = (identityId: string) => Promise<SftpgoClient>;

/** Compare exact configured URLs; a stored credential must never follow configuration changes. */
export async function requireCurrentConnection(
  connections: Pick<ConnectionStore, "current">,
  baseUrl: string,
): Promise<void> {
  const current = await connections.current();
  if (current?.baseUrl !== baseUrl)
    throw new ApiHttpError("upstream_unavailable", "identity provider unavailable");
}

/** Each resolution returns an immutable client, never a connection-aware lazy adapter. */
export function createIdentityClientResolver(deps: {
  identities: Repos["identities"];
  providers: Repos["providers"];
  connections: Pick<ConnectionStore, "current">;
  clientForBaseUrl: ClientForBaseUrl;
}): ClientForIdentity {
  return async (identityId) => {
    const identity = await deps.identities.get(identityId);
    if (identity === null)
      throw new ApiHttpError("reauth_required", "identity not found; sign in again");
    const provider = await deps.providers.get(identity.providerId);
    if (provider === null || provider.type !== "sftpgo")
      throw new ApiHttpError("upstream_unavailable", "identity provider unavailable");
    const baseUrl = provider.baseUrl;
    await requireCurrentConnection(deps.connections, baseUrl);
    return deps.clientForBaseUrl(baseUrl);
  };
}
