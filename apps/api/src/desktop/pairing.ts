import { randomBytes, randomUUID } from "node:crypto";
import type {
  DesktopAccessMode,
  DesktopCredential,
  DesktopWriteCapabilities,
  DesktopWriteCredential,
} from "@fdrive/contracts";
import type { ApiTokenRepo, DesktopPublishLock, IdentityRepo, ProviderRepo } from "@fdrive/db";
import { addressBlock } from "../auth/address-block.js";
import type { Principal } from "../auth/principal.js";
import type { IdentityStorageFactory } from "../auth/storage-factory.js";
import { ApiHttpError } from "../errors.js";
import { createResolveTokenPrincipal } from "../tokens/principal.js";
import { createTokenService } from "../tokens/service.js";
import { hashApiToken } from "../tokens/token-format.js";
import { generateDesktopToken, looksLikeDesktopToken } from "./tokens.js";

type IssuedCredential = Omit<DesktopCredential, "location"> & {
  location: DesktopCredential["location"] | DesktopWriteCredential["location"];
};

interface Pair {
  deviceName: string;
  protocolVersion: 1 | 2;
  owner: string;
  code: string;
  secretHash: string;
  expires: number;
  cancelled?: boolean;
  /** The app persisted the issued bundle. Unconfirmed bundles are revoked at expiry. */
  confirmed?: boolean;
  approval?: {
    accountId: string;
    identityIds: string[];
    access: Record<string, DesktopAccessMode>;
  };
  result?: Promise<IssuedCredential[]>;
}
export interface DesktopDeps {
  writeCapabilities?: (principal: Principal) => Promise<DesktopWriteCapabilities>;
  maxUploadBytes?: number;
  apiTokens: ApiTokenRepo;
  identities: IdentityRepo;
  providers: ProviderRepo;
  storageFactory: IdentityStorageFactory;
  clock: () => Date;
  trashPathForStorage: (storage: Principal["storage"]) => string | null;
  /** Serializes Mac desktop commits for one identity; no other fdrive writer
   * takes it. Absent means storage without a lease stays read-only. */
  publishLock?: DesktopPublishLock;
}

/** Pairing is transient, like the existing login limiter. Restart cancels pending requests.
 * One promise issues credentials once; retries with the app's secret retrieve the same bundle.
 * Secrets are retained only for the five-minute pairing window, never in browser responses.
 * A bundle the app never confirms (crash between poll and Keychain) is revoked when the
 * window closes, so an orphaned credential lives at most five minutes.
 */
/** The one way a full-access grant still lands read-only now that every storage publishes. */
const WRITES_OFF =
  "Finder writes are turned off on this server (FDRIVE_DESKTOP_STATE_DIR is not set). Files stay read-only.";

export function createDesktopPairing(deps: DesktopDeps) {
  const pairs = new Map<string, Pair>();
  const tokens = createTokenService({ ...deps, generateToken: generateDesktopToken });
  const resolve = createResolveTokenPrincipal({ ...deps, acceptsToken: looksLikeDesktopToken });
  const revocations = new Set<Promise<void>>();
  let sweeper: ReturnType<typeof setInterval> | undefined;
  async function revokeIssued(pair: Pair) {
    // A poll already issuing credentials must finish/roll back before revocation.
    const credentials = await pair.result?.catch(() => []);
    if (!pair.approval || !credentials) return;
    const accountId = pair.approval.accountId;
    await Promise.all(
      credentials.map((credential) => tokens.revoke(credential.tokenId, accountId)),
    );
  }
  function track(promise: Promise<void>) {
    const tracked = promise.catch(() => undefined).finally(() => revocations.delete(tracked));
    revocations.add(tracked);
  }
  function prune() {
    const now = deps.clock().getTime();
    for (const [id, pair] of pairs) {
      if (pair.expires > now) continue;
      pairs.delete(id);
      if (pair.result && !pair.confirmed) track(revokeIssued(pair));
    }
  }
  function get(id: string): Pair {
    prune();
    const pair = pairs.get(id);
    if (!pair)
      throw new ApiHttpError(
        "not_found",
        "Connection request expired. Start again in the Mac app.",
      );
    return pair;
  }
  async function location(principal: Principal, protocolVersion: 1 | 2 = 1) {
    const identity = await deps.identities.get(principal.identityId);
    const provider = identity && (await deps.providers.get(identity.providerId));
    if (!identity || identity.accountId !== principal.accountId || !provider?.enabled)
      throw new ApiHttpError("unauthorized", "Storage login is no longer available");
    const common = {
      accountId: principal.accountId,
      identityId: identity.id,
      providerId: provider.id,
      displayName: provider.label || new URL(provider.baseUrl).host,
      username: identity.externalUsername,
      paths: principal.tokenAccess?.paths ?? [],
    };
    if (protocolVersion === 1)
      return { ...common, protocolVersion: 1 as const, readOnly: true as const };
    const capabilities =
      principal.tokenAccess?.mode === "full" && deps.writeCapabilities
        ? await deps.writeCapabilities(principal)
        : { create: false, update: false, move: false, trash: false, restore: false };
    return {
      ...common,
      protocolVersion: 2 as const,
      readOnly: !Object.values(capabilities).some(Boolean),
      capabilities,
      maxUploadBytes: deps.maxUploadBytes ?? 16 * 1024 ** 3,
      ...(principal.tokenAccess?.mode === "full" && !Object.values(capabilities).some(Boolean)
        ? { writeUnavailableReason: WRITES_OFF }
        : {}),
    };
  }
  async function issue(pair: Pair): Promise<IssuedCredential[]> {
    const approval = pair.approval;
    if (!approval) throw new ApiHttpError("conflict", "Connection has not been approved");
    const created: IssuedCredential[] = [];
    const issued: string[] = [];
    try {
      for (const identityId of approval.identityIds) {
        if (pair.cancelled || pair.expires <= deps.clock().getTime())
          throw new ApiHttpError("not_found", "Connection request expired");
        const credential = await tokens.create(approval.accountId, {
          name: `Mac: ${pair.deviceName}`,
          identityId,
          expiresInDays: 365,
          access: { mode: approval.access[identityId] ?? "read", paths: ["/"] },
        });
        issued.push(credential.item.id);
        if (pair.cancelled || pair.expires <= deps.clock().getTime())
          throw new ApiHttpError("not_found", "Connection request expired");
        const principal = await resolve(credential.token);
        if (!principal)
          throw new ApiHttpError("unauthorized", "Storage login changed. Connect again.");
        created.push({
          token: credential.token,
          tokenId: credential.item.id,
          expiresAt: credential.item.expiresAt as string,
          location: await location(principal, pair.protocolVersion),
        });
      }
      return created;
    } catch (error) {
      await Promise.all(issued.map((id) => tokens.revoke(id, approval.accountId)));
      throw error;
    }
  }
  return {
    resolve,
    location,
    create(deviceName: string, address: string, protocolVersion: 1 | 2 = 1) {
      const owner = addressBlock(address);
      prune();
      if (
        pairs.size >= 512 ||
        [...pairs.values()].filter((pair) => pair.owner === owner).length >= 8
      )
        throw new ApiHttpError("rate_limited", "Too many connection requests. Try again shortly.");
      const id = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const code = randomBytes(4).toString("hex").toUpperCase();
      const expires = deps.clock().getTime() + 300_000;
      if (!sweeper) {
        // Expiry revocation must not depend on another request arriving.
        sweeper = setInterval(prune, 60_000);
        sweeper.unref();
      }
      pairs.set(id, {
        deviceName,
        protocolVersion,
        owner,
        code,
        expires,
        secretHash: hashApiToken(secret),
      });
      return { id, secret, code, expiresAt: new Date(expires).toISOString() };
    },
    info(id: string) {
      const pair = get(id);
      return {
        deviceName: pair.deviceName,
        code: pair.code,
        expiresAt: new Date(pair.expires).toISOString(),
        approved: pair.approval !== undefined,
        ...(pair.protocolVersion === 2 ? { supportsWrites: true } : {}),
      };
    },
    async approve(
      id: string,
      accountId: string,
      identityIds: string[],
      access: Record<string, DesktopAccessMode> = {},
    ) {
      const pair = get(id);
      if (pair.approval) throw new ApiHttpError("conflict", "Connection already approved");
      if (
        Object.keys(access).some((identityId) => !identityIds.includes(identityId)) ||
        (pair.protocolVersion === 1 && Object.values(access).some((mode) => mode !== "read"))
      ) {
        throw new ApiHttpError(
          "bad_request",
          "Write access requires a new connection from an updated Mac app",
        );
      }
      for (const identityId of identityIds) {
        const identity = await deps.identities.get(identityId);
        const provider = identity && (await deps.providers.get(identity.providerId));
        if (!identity || identity.accountId !== accountId || !provider?.enabled)
          throw new ApiHttpError(
            "forbidden",
            "Select an available login belonging to your account",
          );
      }
      // Recheck after asynchronous ownership reads; two browser approvals cannot race.
      if (get(id) !== pair || pair.approval)
        throw new ApiHttpError("conflict", "Connection already approved");
      pair.approval = { accountId, identityIds: [...new Set(identityIds)], access: { ...access } };
    },
    async poll(id: string, secret: string) {
      const pair = get(id);
      if (pair.secretHash !== hashApiToken(secret))
        throw new ApiHttpError("unauthorized", "Invalid connection secret");
      if (!pair.approval) return { status: "pending" as const };
      pair.result ??= issue(pair);
      return { status: "connected" as const, credentials: await pair.result };
    },
    async confirm(id: string, secret: string) {
      const pair = get(id);
      if (pair.secretHash !== hashApiToken(secret))
        throw new ApiHttpError("unauthorized", "Invalid connection secret");
      if (!pair.result) throw new ApiHttpError("conflict", "Connection has not been redeemed");
      await pair.result;
      pair.confirmed = true;
    },
    async cancel(id: string, secret: string) {
      const pair = get(id);
      if (pair.secretHash !== hashApiToken(secret))
        throw new ApiHttpError("unauthorized", "Invalid connection secret");
      pair.cancelled = true;
      pairs.delete(id);
      // Installed (confirmed) locations are revoked individually by the app, never here.
      if (!pair.confirmed) await revokeIssued(pair);
    },
    /** Expire pairings now and wait for any resulting revocations (tests and shutdown). */
    async sweep() {
      prune();
      await Promise.all([...revocations]);
    },
    async revoke(bearer: string) {
      // Possession of this desktop secret authorizes only its own revocation. Do not
      // require working storage, a linked identity, or an unexpired read grant to disconnect.
      if (!looksLikeDesktopToken(bearer))
        throw new ApiHttpError("unauthorized", "Invalid desktop credential");
      const token = await deps.apiTokens.findByHash(hashApiToken(bearer));
      if (!token) throw new ApiHttpError("unauthorized", "Invalid desktop credential");
      await tokens.revoke(token.id, token.accountId);
    },
  };
}
