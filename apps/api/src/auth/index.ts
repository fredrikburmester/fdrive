import type { Repos } from "@fdrive/db";
import type { AppHono, AuthedHono } from "../app.js";
import type { AppConfig } from "../config.js";
import type { ProviderService } from "../providers/service.js";
import type { CheckPassword } from "./password.ts";
import type { PrincipalResolver } from "./principal.js";
import { registerAuthRoutes } from "./routes.js";
import { createAuthService } from "./service.js";
import type { IdentityStorageFactory } from "./storage-factory.ts";

export { CryptoError, open, parseMasterKey, seal } from "./crypto.js";
export type { LoginLimiter } from "./login-limiter.js";
export { createLoginLimiter } from "./login-limiter.js";
export type { CheckPassword, PasswordCheckInput } from "./password.ts";
export { createLoginReauthentication, createPasswordCheck, loginIpKey } from "./password.ts";
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

export interface CreateAuthModuleDeps {
  readonly repos: Repos;
  readonly providers: ProviderService;
  readonly clock: () => Date;
  readonly config: AppConfig;
  readonly storageFactory: IdentityStorageFactory;
  /** The one password check, behind the login limiter (`createPasswordCheck`). */
  readonly checkPassword: CheckPassword;
  /**
   * Usernames always treated as admins, in addition to `accounts.is_admin`.
   * Defaults to `config.fdriveAdminUsers`.
   */
  readonly adminUsernames?: readonly string[];
}

export interface AuthModule {
  readonly service: ReturnType<typeof createAuthService>;
  readonly principalResolver: PrincipalResolver;
  registerRoutes(groups: { public: AppHono; authed: AuthedHono }): void;
}

/**
 * Wires the auth module: auth service and route registration, so the
 * app-wiring chunk needs a single call to get a `principalResolver` and a
 * `registerRoutes` function.
 */
export function createAuthModule(deps: CreateAuthModuleDeps): AuthModule {
  const service = createAuthService({
    repos: deps.repos,
    providers: deps.providers,
    clock: deps.clock,
    config: deps.config,
    checkPassword: deps.checkPassword,
    storageFactory: deps.storageFactory,
    adminUsernames: deps.adminUsernames ?? deps.config.fdriveAdminUsers,
  });

  return {
    service,
    principalResolver: (c) => service.resolvePrincipal(c),
    registerRoutes(groups) {
      registerAuthRoutes(groups, { service, config: deps.config });
    },
  };
}
