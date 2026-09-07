import type { SearchQuery, SearchResponse } from "@fdrive/contracts";
import type { StorageProvider } from "@fdrive/core";
import type { Identity, IdentityLinksRepo, Repos } from "@fdrive/db";
import type { LoginLimiter } from "../auth/login-limiter.js";
import type { Principal } from "../auth/principal.js";
import type { ClientForBaseUrl } from "../auth/provider-client.ts";
import type { AuthService } from "../auth/service.js";
import type { TokenSource } from "../auth/token-source.js";
import type { ConnectionStore } from "../connection/store.js";

export type AccountIdentityOperations = IdentityLinksRepo;
export interface VerifiedCredentialDeps {
  readonly repos: Repos;
  readonly clientForBaseUrl: ClientForBaseUrl;
  readonly limiter: LoginLimiter;
  readonly connectionStore: ConnectionStore;
}
export interface AccountRequestContext {
  readonly principal: Principal;
  readonly sessionId: string;
}
export interface AccountsDeps extends VerifiedCredentialDeps {
  readonly links: AccountIdentityOperations;
  readonly auth: AuthService;
  readonly tokenSource: TokenSource;
  readonly master: Uint8Array;
  readonly clock: () => Date;
  readonly storageForIdentity: (identity: Identity) => StorageProvider | Promise<StorageProvider>;
  readonly searchForIdentity: (identity: Identity, query: SearchQuery) => Promise<SearchResponse>;
}
