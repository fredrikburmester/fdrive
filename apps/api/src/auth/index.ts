import type { Repos } from "@fdrive/db";
import type { AccountIdentityOperations } from "../accounts/types.ts";
import type { AppHono, AuthedHono } from "../app.js";
import type { AppConfig } from "../config.js";
import type { ProviderService } from "../providers/service.js";
import { createLoginLimiter, type LoginLimiter } from "./login-limiter.js";
import type { PrincipalResolver } from "./principal.js";
import { registerAuthRoutes } from "./routes.js";
import { createAuthService } from "./service.js";
import type { IdentityStorageFactory } from "./storage-factory.ts";
import { createTokenSource, type TokenSource } from "./token-source.js";

export { CryptoError, KEY_ID, open, parseMasterKey, seal } from "./crypto.js";
export type { LoginLimiter } from "./login-limiter.js";
export { createLoginLimiter } from "./login-limiter.js";
export type { AuthService, LoginInput, LoginResult } from "./service.js";
export { createAuthService } from "./service.js";
export {
  buildCookie,
  COOKIE_NAME,
  clearCookie,
  cookieSecureFor,
  generateSessionId,
  hashSessionId,
} from "./sessions.js";
export type { TokenSource } from "./token-source.js";
export { createTokenSource } from "./token-source.js";

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_BLOCK_MS = 60_000;

export interface CreateAuthModuleDeps {
  readonly repos: Repos;
  readonly identityLinks: AccountIdentityOperations;
  readonly providers: ProviderService;
  readonly fetch: typeof globalThis.fetch;
  readonly master: Uint8Array;
  readonly clock: () => Date;
  readonly config: AppConfig;
  readonly storageFactory: IdentityStorageFactory;
  readonly limiter?: LoginLimiter;
  /**
   * Usernames always treated as admins, in addition to `accounts.is_admin`.
   * Defaults to `config.fdriveAdminUsers`.
   */
  readonly adminUsernames?: readonly string[];
  /**
   * The `TokenSource` the auth service primes upstream tokens into.
   * Defaults to a freshly built one when omitted; a caller that also needs
   * a `TokenSource` elsewhere (for example to build the storage provider
   * passed as `storageFactory`) should build it once and pass it here so
   * both share the same in-process token cache.
   */
  readonly tokenSource?: TokenSource;
}

export interface AuthModule {
  readonly service: ReturnType<typeof createAuthService>;
  readonly tokenSource: TokenSource;
  readonly principalResolver: PrincipalResolver;
  registerRoutes(groups: { public: AppHono; authed: AuthedHono }): void;
}

/**
 * Wires the auth module: rate limiter, token source, auth service, and
 * route registration, so the app-wiring chunk needs a single call to get a
 * `principalResolver` and a `registerRoutes` function.
 */
export function createAuthModule(deps: CreateAuthModuleDeps): AuthModule {
  const limiter =
    deps.limiter ??
    createLoginLimiter({
      clock: deps.clock,
      maxFailures: LOGIN_MAX_FAILURES,
      windowMs: LOGIN_WINDOW_MS,
      blockMs: LOGIN_BLOCK_MS,
    });

  const tokenSource =
    deps.tokenSource ??
    createTokenSource({
      repos: deps.repos,
      providers: deps.providers,
      master: deps.master,
      clock: deps.clock,
      fetch: deps.fetch,
    });

  const service = createAuthService({
    repos: deps.repos,
    identityLinks: deps.identityLinks,
    providers: deps.providers,
    fetch: deps.fetch,
    master: deps.master,
    clock: deps.clock,
    config: deps.config,
    limiter,
    tokenSource,
    storageFactory: deps.storageFactory,
    adminUsernames: deps.adminUsernames ?? deps.config.fdriveAdminUsers,
  });

  return {
    service,
    tokenSource,
    principalResolver: (c) => service.resolvePrincipal(c),
    registerRoutes(groups) {
      registerAuthRoutes(groups, { service, config: deps.config });
    },
  };
}
