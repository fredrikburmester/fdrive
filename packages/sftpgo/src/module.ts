import type {
  AuthenticateContext,
  AuthenticateResult,
  ProviderContext,
  ProviderCredential,
  ProviderField,
  ProviderInstance,
  ProviderModule,
  ProviderToken,
  StorageProvider,
  StorageSession,
} from "@fdrive/core";
import { parseHomeTemplate, StorageError } from "@fdrive/core";
import { createSftpgoClient } from "./client.js";
import { SftpgoError } from "./errors.js";
import { probeConnection } from "./probe.js";
import { createSftpgoStorageProvider, toStorageError, type WithToken } from "./storage-provider.js";
import type { SftpgoClient } from "./types.js";
import {
  SFTPGO_OPTIMISTIC_MODE,
  SFTPGO_WRITE_PROTOCOL,
  withSftpgoWriteLease,
} from "./write-lease.js";

/** Default used by deployment setup; never inferred for an unmapped provider row. */
export const DEFAULT_SFTPGO_HOME_TEMPLATE = "sftpgo:/{username}";

export const SFTPGO_CONFIG_FIELDS: readonly ProviderField[] = [
  {
    name: "desktopWriteMode",
    label: "Native write enforcement",
    kind: "text",
    required: false,
    maxLength: 64,
    help: 'Use "verified-optimistic" for stock SFTPGo: fdrive serializes its own writers and rechecks the file immediately before replacing it, but a direct SFTP/FTP write in that instant is lost. Use "fdrive-local-v1" only with the qualified fdrive SFTPGo image. Leave blank for read-only Finder access.',
  },
  {
    name: "homeTemplate",
    label: "Home template",
    kind: "text",
    required: false,
    help: 'Written as "<root>:<path>", where "{username}" is replaced by each person\'s SFTPGo username.',
    maxLength: 512,
  },
];

export const SFTPGO_CREDENTIAL_FIELDS: readonly ProviderField[] = [
  { name: "username", label: "Username", kind: "text", required: true, maxLength: 255 },
  { name: "password", label: "Password", kind: "password", required: true },
  {
    name: "otp",
    label: "One-time code",
    kind: "otp",
    required: false,
    maxLength: 32,
    transient: true,
    help: "Only when SFTPGo asks for two-factor authentication.",
  },
];

/** Explicit index mapping only; remote rows never inherit another server's root. */
export function sftpgoHomeTemplate(instance: Pick<ProviderInstance, "config">): string | null {
  const value = instance.config.homeTemplate;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface CreateSftpgoModuleOptions {
  /**
   * Builds the client for a provider instance. Defaults to a fresh
   * `createSftpgoClient` over the context's `fetch`; tests inject a shared
   * client so they can observe or stub its calls.
   */
  readonly clientFor?: (instance: ProviderInstance, ctx: ProviderContext) => SftpgoClient;
}

function defaultClientFor(instance: ProviderInstance, ctx: ProviderContext): SftpgoClient {
  return createSftpgoClient({ baseUrl: instance.baseUrl, fetch: ctx.fetch });
}

function toToken(token: { accessToken: string; expiresAt: Date }): ProviderToken {
  return { token: token.accessToken, expiresAt: token.expiresAt };
}

async function login(
  client: SftpgoClient,
  username: string,
  credential: ProviderCredential,
): Promise<ProviderToken> {
  try {
    return toToken(
      await client.login({
        username,
        password: credential.password ?? "",
        ...(credential.otp === undefined ? {} : { otp: credential.otp }),
      }),
    );
  } catch (error) {
    return toStorageError(error);
  }
}

/**
 * Runs each storage call with the session's current JWT and retries exactly
 * once, with a freshly minted one, when SFTPGo answers 401: the cached
 * token expired or SFTPGo restarted without a signing passphrase.
 */
function withTokenFor(session: StorageSession): WithToken {
  const token = async (): Promise<string> => {
    const value = await session.getToken();
    if (value === null) {
      throw new StorageError("unauthorized", "no SFTPGo token available");
    }
    return value;
  };
  return async (fn, options) => {
    try {
      return await fn(await token());
    } catch (error) {
      if (error instanceof SftpgoError && error.kind === "unauthorized") {
        await session.invalidateToken();
        if (options?.retry === false) throw error;
        return await fn(await token());
      }
      throw error;
    }
  };
}

/** Builds the SFTPGo storage backend module; see `sftpgoModule` for the default instance. */
export function createSftpgoModule(options: CreateSftpgoModuleOptions = {}): ProviderModule {
  const clientFor = options.clientFor ?? defaultClientFor;
  return {
    type: "sftpgo",
    label: "SFTPGo",
    configFields: SFTPGO_CONFIG_FIELDS,
    credentialFields: SFTPGO_CREDENTIAL_FIELDS,
    capabilities: {
      zip: true,
      setModifiedAt: true,
      atomicMove: true,
      trash: true,
      shares: true,
      office: true,
      index: true,
      scopeMapping: true,
    },
    trash: "native",

    indexRootName(instance) {
      try {
        const template = sftpgoHomeTemplate(instance);
        return template === null ? null : parseHomeTemplate(template).rootName;
      } catch {
        return null;
      }
    },

    probe(instance, ctx) {
      return probeConnection(instance.baseUrl, { fetch: ctx.fetch });
    },

    async authenticate(
      instance: ProviderInstance,
      credential: ProviderCredential,
      ctx: AuthenticateContext,
    ): Promise<AuthenticateResult> {
      const username = credential.username ?? ctx.expectedUsername;
      if (username === undefined || username.length === 0) {
        throw new StorageError("unauthorized", "invalid username or password");
      }
      if (ctx.expectedUsername !== undefined && username !== ctx.expectedUsername) {
        throw new StorageError("unauthorized", "credential names a different user");
      }
      const token = await login(clientFor(instance, ctx), username, credential);
      return { externalUsername: username, token };
    },

    async mint(instance, session, ctx) {
      return login(clientFor(instance, ctx), session.externalUsername, session.credential);
    },

    createStorage(instance, session, ctx): StorageProvider {
      const withToken = withTokenFor(session);
      const storage = createSftpgoStorageProvider({
        client: clientFor(instance, ctx),
        withToken,
      });
      if (instance.config.desktopWriteMode === SFTPGO_OPTIMISTIC_MODE)
        // No lease: publication safety comes from fdrive-side serialization and
        // the destination recheck in the desktop write path.
        return { ...storage, optimisticPublish: true };
      if (instance.config.desktopWriteMode !== SFTPGO_WRITE_PROTOCOL) return storage;
      return {
        ...storage,
        withWriteLease: (action, signal) =>
          withSftpgoWriteLease(
            {
              baseUrl: instance.baseUrl,
              fetch: ctx.fetch,
              withToken,
              ...(signal ? { signal } : {}),
            },
            action,
          ),
      };
    },
  };
}

/** The SFTPGo storage backend: credential-mode login, JWT re-minting, native shares and trash. */
export const sftpgoModule: ProviderModule = createSftpgoModule();
