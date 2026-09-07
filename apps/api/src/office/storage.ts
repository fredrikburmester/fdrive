import type { Repos } from "@fdrive/db";
import { createSftpgoClient } from "@fdrive/sftpgo";
import type { TokenSource } from "../auth/token-source.js";
import type { ConnectionStore } from "../connection/store.js";
import { createSftpgoStorageProvider } from "../storage/sftpgo-provider.js";
import { WopiError } from "./errors.ts";
import type { OfficeDeps } from "./types.ts";

/** Resolve database-backed credentials before any write transaction is acquired. */
export function createOfficeStorageFactory(deps: {
  connections: Pick<ConnectionStore, "current">;
  providers: Repos["providers"];
  tokens: Pick<TokenSource, "get">;
  fetch: typeof globalThis.fetch;
}): OfficeDeps["storageFactory"] {
  return async (identityId, providerId) => {
    const connection = await deps.connections.current();
    if (connection === null) throw new WopiError(401);
    const provider = await deps.providers.ensure({ type: "sftpgo", baseUrl: connection.baseUrl });
    if (provider.id !== providerId) throw new WopiError(401);
    const token = await deps.tokens.get(identityId);
    const current = await deps.connections.current();
    if (current?.baseUrl !== connection.baseUrl) throw new WopiError(401);
    // Token refresh must happen on the next request, never while a SQL write scope
    // holds a connection. The direct client also avoids lazy configuration DB reads.
    return createSftpgoStorageProvider({
      client: createSftpgoClient({ baseUrl: connection.baseUrl, fetch: deps.fetch }),
      withToken: (fn) => fn(token),
    });
  };
}
