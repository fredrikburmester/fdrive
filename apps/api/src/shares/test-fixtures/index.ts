import type { ProviderModule } from "@fdrive/core";
import { createMemoryShareRepo } from "@fdrive/db";
import { accountsHarness, cookieFrom } from "../../accounts/test-fixtures/index.ts";
import { createApp } from "../../app.ts";
import { createShareCredentialCodec } from "../credentials.ts";
import { createShareLimiter } from "../limiter.ts";
import { registerSharesRoutes } from "../routes.ts";
import { createSharesService } from "../service.ts";
export function sharesHarness(
  options: {
    limiterCapacity?: number;
    modules?: Readonly<Record<string, ProviderModule>>;
    wrapFetch?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
  } = {},
) {
  const h = accountsHarness({
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    ...(options.wrapFetch === undefined ? {} : { wrapFetch: options.wrapFetch }),
  });
  const shares = createMemoryShareRepo();
  const deps = {
    ...h.deps,
    tokenSource: h.tokenSource,
    providers: h.providers,
    shares,
    logger: h.logger,
    clientFor: (_baseUrl: string) => h.client,
  };
  const service = createSharesService(deps);
  const codec = createShareCredentialCodec(h.master, h.clock);
  const limiter = createShareLimiter(h.clock, options.limiterCapacity);
  const app = createApp({
    config: h.config,
    logger: h.logger,
    clock: h.clock,
    version: "test",
    startedAt: h.clock(),
    principalResolver: h.auth.principalResolver,
    registerRoutes: (groups) => {
      h.auth.registerRoutes(groups);
      registerSharesRoutes(groups, {
        service,
        codec,
        limiter,
        config: h.config,
        indexQueries: {
          rootIdsByName: async () => ({}),
          fileByPath: async () => null,
          thumbnail: async () => null,
        },
        resolver: { verifiedIndexScopes: async () => ({ available: false, reason: "no_roots" }) },
        identities: h.repos.identities,
        thumbsDir: undefined,
      });
    },
  });
  async function request(
    path: string,
    options: {
      method?: string;
      cookie?: string;
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    return app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined
        ? options.raw === undefined
          ? {}
          : { body: options.raw }
        : { body: JSON.stringify(options.body) }),
    });
  }
  /** Signs in as a fake SFTPGo user, or as `username` on `providerId` with `password`. */
  async function login(
    username = "alice",
    options: { providerId?: string; password?: string } = {},
  ) {
    const res = await request("/api/v1/auth/login", {
      method: "POST",
      body: {
        ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
        credential: { username, password: options.password ?? `${username}-pass` },
      },
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    return cookieFrom(res);
  }
  async function create(cookie: string, patch: Record<string, unknown> = {}) {
    const response = await request("/api/v1/shares", {
      method: "POST",
      cookie,
      body: { name: "Document", paths: ["/a.docx"], scope: "read", ...patch },
    });
    if (response.status !== 201) throw new Error(await response.text());
    return response.json() as Promise<{ id: string; hasPassword: boolean }>;
  }
  return { ...h, shares, deps, service, codec, limiter, app, request, login, create };
}
