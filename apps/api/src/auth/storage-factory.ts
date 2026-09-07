import type { StorageProvider } from "@fdrive/core";
import { createSftpgoStorageProvider } from "../storage/sftpgo-provider.js";
import type { ClientForIdentity } from "./provider-client.ts";
import type { TokenSource } from "./token-source.js";

export type IdentityStorageFactory = (identityId: string) => Promise<StorageProvider>;

/** Delayed jobs retain this client; token validation can deny execution but cannot retarget it. */
export function createIdentityStorageFactory(deps: {
  clientForIdentity: ClientForIdentity;
  tokenSource: Pick<TokenSource, "withToken">;
}): IdentityStorageFactory {
  return async (identityId) => {
    const client = await deps.clientForIdentity(identityId);
    return createSftpgoStorageProvider({
      client,
      withToken: (fn) => deps.tokenSource.withToken(identityId, fn),
    });
  };
}
