import type { StorageProvider } from "@fdrive/core";
import type { Identity, IdentityLinksRepo, Repos } from "@fdrive/db";
import type { LoginLimiter } from "../auth/login-limiter.js";
import type { Principal } from "../auth/principal.js";
import type { AuthService } from "../auth/service.js";
import type { ProviderService } from "../providers/service.js";

export type AccountIdentityOperations = IdentityLinksRepo;
export interface VerifiedCredentialDeps {
  readonly repos: Repos;
  readonly providers: Pick<ProviderService, "resolve" | "enabled">;
  readonly limiter: LoginLimiter;
  readonly fetch: typeof globalThis.fetch;
}
export interface AccountRequestContext {
  readonly principal: Principal;
  readonly sessionId: string;
}
export interface AccountsDeps extends VerifiedCredentialDeps {
  readonly links: AccountIdentityOperations;
  readonly auth: AuthService;
  readonly master: Uint8Array;
  readonly clock: () => Date;
  readonly storageForIdentity: (identity: Identity) => StorageProvider | Promise<StorageProvider>;
}
