import type {
  AuthenticateContext,
  AuthenticateResult,
  ProviderContext,
  ProviderCredential,
  ProviderField,
  ProviderInstance,
  ProviderModule,
  StorageProvider,
  StorageSession,
} from "@fdrive/core";
import { StorageError } from "@fdrive/core";
import { createWebdavClient } from "./client.js";
import { WebdavError } from "./errors.js";
import { probeConnection } from "./probe.js";
import { createWebdavStorageProvider } from "./storage-provider.js";
import type { WebdavClient } from "./types.js";

export const WEBDAV_CREDENTIAL_FIELDS: readonly ProviderField[] = [
  { name: "username", label: "Username", kind: "text", required: true, maxLength: 255 },
  { name: "password", label: "Password", kind: "password", required: true },
];

export interface CreateWebdavModuleOptions {
  /**
   * Builds the client for a provider instance. Defaults to a fresh
   * `createWebdavClient` over the context's `fetch`; tests inject a shared
   * client so they can observe or stub its calls.
   */
  readonly clientFor?: (instance: ProviderInstance, ctx: ProviderContext) => WebdavClient;
}

function defaultClientFor(instance: ProviderInstance, ctx: ProviderContext): WebdavClient {
  return createWebdavClient({ baseUrl: instance.baseUrl, fetch: ctx.fetch });
}

/**
 * Verifies a credential by reading the endpoint root: the server must
 * accept the login and the root must be a collection. Kinds follow the
 * `ProviderModule.authenticate` contract: `unauthorized`, `forbidden` or
 * `upstream_unavailable`.
 */
async function verifyCredential(
  client: WebdavClient,
  username: string,
  password: string,
): Promise<void> {
  let kind: string;
  try {
    kind = (await client.user({ username, password }).stat("/")).kind;
  } catch (error) {
    if (!(error instanceof WebdavError)) throw error;
    const storageKind =
      error.kind === "unauthorized" || error.kind === "forbidden"
        ? error.kind
        : "upstream_unavailable";
    throw new StorageError(storageKind, error.message, {
      cause: error,
      ...(error.detail === null ? {} : { details: { detail: error.detail } }),
    });
  }
  if (kind !== "dir") {
    throw new StorageError("upstream_unavailable", "WebDAV endpoint root is not a collection");
  }
}

/** Builds the WebDAV storage backend module; see `webdavModule` for the default instance. */
export function createWebdavModule(options: CreateWebdavModuleOptions = {}): ProviderModule {
  const clientFor = options.clientFor ?? defaultClientFor;
  return {
    type: "webdav",
    label: "WebDAV",
    configFields: [],
    credentialFields: WEBDAV_CREDENTIAL_FIELDS,
    capabilities: {
      zip: false,
      setModifiedAt: false,
      atomicMove: true,
      trash: false,
      shares: false,
      office: false,
      index: false,
      scopeMapping: false,
    },
    trash: "none",

    probe(instance, ctx) {
      return probeConnection(instance.baseUrl, { fetch: ctx.fetch });
    },

    async authenticate(
      instance: ProviderInstance,
      credential: ProviderCredential,
      ctx: AuthenticateContext,
    ): Promise<AuthenticateResult> {
      const username = credential.username ?? ctx.expectedUsername;
      const password = credential.password ?? "";
      if (username === undefined || username.length === 0 || password.length === 0) {
        throw new StorageError("unauthorized", "invalid username or password");
      }
      if (ctx.expectedUsername !== undefined && username !== ctx.expectedUsername) {
        throw new StorageError("unauthorized", "credential names a different user");
      }
      await verifyCredential(clientFor(instance, ctx), username, password);
      return { externalUsername: username };
    },

    createStorage(instance, session: StorageSession, ctx): StorageProvider {
      return createWebdavStorageProvider({
        client: clientFor(instance, ctx),
        // The username is the identity's bound name, never the stored
        // credential's, so a credential can only ever act as its identity.
        credential: async () => ({
          username: session.externalUsername,
          password: (await session.getCredential()).password ?? "",
        }),
      });
    },
  };
}

/** The WebDAV storage backend: Basic-auth logins against any class 1 server. */
export const webdavModule: ProviderModule = createWebdavModule();
