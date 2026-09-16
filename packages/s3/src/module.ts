import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
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
import { createS3Client, regionFor, type S3Credential } from "./client.js";
import { parseEndpoint, type S3Endpoint } from "./endpoint.js";
import { toStorageError } from "./errors.js";
import { probeConnection } from "./probe.js";
import { createS3StorageProvider } from "./storage-provider.js";

export const S3_CONFIG_FIELDS: readonly ProviderField[] = [
  {
    name: "region",
    label: "Region",
    kind: "text",
    required: false,
    maxLength: 64,
    help: "Signing region. MinIO accepts any value; use auto for Cloudflare R2, otherwise the bucket's region.",
  },
];

export const S3_CREDENTIAL_FIELDS: readonly ProviderField[] = [
  { name: "username", label: "Access key ID", kind: "text", required: true, maxLength: 255 },
  { name: "password", label: "Secret key", kind: "password", required: true },
];

export interface CreateS3ModuleOptions {
  /**
   * Builds the client for a provider instance and key pair. Defaults to
   * `createS3Client` over the context's `fetch`; tests inject a shared
   * client so they can observe or stub its calls.
   */
  readonly clientFor?: (
    instance: ProviderInstance,
    endpoint: S3Endpoint,
    credential: S3Credential,
    ctx: ProviderContext,
  ) => S3Client;
}

function defaultClientFor(
  instance: ProviderInstance,
  endpoint: S3Endpoint,
  credential: S3Credential,
  ctx: ProviderContext,
): S3Client {
  return createS3Client({
    endpoint: endpoint.endpoint,
    region: regionFor(instance.config),
    credential,
    fetch: ctx.fetch,
  });
}

/** Parses the row's address, reporting a malformed one as the backend being unusable. */
function endpointOf(instance: ProviderInstance): S3Endpoint {
  try {
    return parseEndpoint(instance.baseUrl);
  } catch (error) {
    throw new StorageError("upstream_unavailable", "S3 address is invalid", { cause: error });
  }
}

/**
 * Verifies a key pair by listing one key under the row's prefix: it proves
 * the pair and list access on the scope people will browse, which
 * `HeadBucket` does not for a prefix-scoped policy. Kinds follow the
 * `ProviderModule.authenticate` contract: `unauthorized`, `forbidden` or
 * `upstream_unavailable`.
 */
async function verifyCredential(client: S3Client, endpoint: S3Endpoint): Promise<void> {
  try {
    await client.send(
      new ListObjectsV2Command({
        Bucket: endpoint.bucket,
        ...(endpoint.prefix.length === 0 ? {} : { Prefix: `${endpoint.prefix}/` }),
        MaxKeys: 1,
      }),
    );
  } catch (error) {
    const mapped = toStorageError(error);
    if (mapped.kind === "unauthorized" || mapped.kind === "forbidden") throw mapped;
    throw new StorageError("upstream_unavailable", mapped.message, {
      cause: error,
      details: { ...mapped.details },
    });
  }
}

/** Builds the S3 storage backend module; see `s3Module` for the default instance. */
export function createS3Module(options: CreateS3ModuleOptions = {}): ProviderModule {
  const clientFor = options.clientFor ?? defaultClientFor;
  return {
    type: "s3",
    label: "S3",
    configFields: S3_CONFIG_FIELDS,
    credentialFields: S3_CREDENTIAL_FIELDS,
    capabilities: {
      zip: false,
      setModifiedAt: false,
      // Copy then delete per object; the API's caution copy for folder moves applies.
      atomicMove: false,
      trash: true,
      shares: false,
      office: false,
      index: false,
      scopeMapping: false,
    },
    // No recycle bin in S3: the API storage factory moves deleted objects
    // into the configured folder itself (`withMoveToTrash`).
    trash: "move",

    probe(instance, ctx) {
      return probeConnection(instance.baseUrl, { fetch: ctx.fetch });
    },

    async authenticate(
      instance: ProviderInstance,
      credential: ProviderCredential,
      ctx: AuthenticateContext,
    ): Promise<AuthenticateResult> {
      const accessKeyId = credential.username ?? ctx.expectedUsername;
      const secretAccessKey = credential.password ?? "";
      if (accessKeyId === undefined || accessKeyId.length === 0 || secretAccessKey.length === 0) {
        throw new StorageError("unauthorized", "invalid access key or secret");
      }
      if (ctx.expectedUsername !== undefined && accessKeyId !== ctx.expectedUsername) {
        throw new StorageError("unauthorized", "credential names a different access key");
      }
      const endpoint = endpointOf(instance);
      await verifyCredential(
        clientFor(instance, endpoint, { accessKeyId, secretAccessKey }, ctx),
        endpoint,
      );
      return { externalUsername: accessKeyId };
    },

    createStorage(instance, session: StorageSession, ctx): StorageProvider {
      const endpoint = endpointOf(instance);
      let cached: { secret: string; client: S3Client } | null = null;
      return createS3StorageProvider({
        bucket: endpoint.bucket,
        prefix: endpoint.prefix,
        // The access key is the identity's bound name, never the stored
        // credential's, so a credential can only ever act as its identity.
        // The client is rebuilt when the secret changes.
        client: async () => {
          const secret = (await session.getCredential()).password ?? "";
          if (cached === null || cached.secret !== secret) {
            cached = {
              secret,
              client: clientFor(
                instance,
                endpoint,
                { accessKeyId: session.externalUsername, secretAccessKey: secret },
                ctx,
              ),
            };
          }
          return cached.client;
        },
      });
    },
  };
}

/** The S3 storage backend: access-key logins against any S3-compatible bucket. */
export const s3Module: ProviderModule = createS3Module();
