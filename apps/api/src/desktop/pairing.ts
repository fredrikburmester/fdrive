import { randomBytes, randomUUID } from "node:crypto";
import type {
  DesktopAccessMode,
  DesktopCredential,
  DesktopWriteCapabilities,
  DesktopWriteCredential,
} from "@fdrive/contracts";
import type { ApiTokenRepo, LoginRepo } from "@fdrive/db";
import { addressBlock } from "../auth/address-block.js";
import type { Principal, PrincipalFactory } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { createResolveTokenPrincipal } from "../tokens/principal.js";
import { createTokenService } from "../tokens/service.js";
import { hashApiToken } from "../tokens/token-format.js";
import type { IndexedContentLookup } from "./indexed-content.js";
import { generateDesktopToken, looksLikeDesktopToken } from "./tokens.js";
import { DESKTOP_MAX_UPLOAD_BYTES, NO_WRITES } from "./writes.js";

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
    identityId: string;
    access: DesktopAccessMode;
  };
  result?: Promise<IssuedCredential[]>;
}
export interface DesktopDeps {
  /** What a grant may write; absent when desktop writes are not wired. */
  writeCapabilities?: (principal: Principal) => DesktopWriteCapabilities;
  /** Whether the server has the change feed, which covers every location. */
  changeFeed?: boolean;
  apiTokens: ApiTokenRepo;
  /** Reads a credential's token and login in one query. */
  logins: Pick<LoginRepo, "byToken">;
  /**
   * The files folder's id (`ensureStorageId`), which the Mac compares as a
   * location's `providerId`, and the installation's storage name, its `displayName`.
   */
  storage: { readonly id: string; name(): Promise<string> };
  principalFor: PrincipalFactory;
  clock: () => Date;
  /**
   * The index rows behind a connection's files, which answer a version check
   * without reading a file whose row provably describes it. Absent when
   * nothing is indexed: every check hashes.
   */
  indexedContent?: IndexedContentLookup;
}

/** Pairing is transient, like the existing login limiter. Restart cancels pending requests.
 * One promise issues credentials once; retries with the app's secret retrieve the same bundle.
 * Secrets are retained only for the five-minute pairing window, never in browser responses.
 * A bundle the app never confirms (crash between poll and Keychain) is revoked when the
 * window closes, so an orphaned credential lives at most five minutes.
 */
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
    const common = {
      accountId: principal.accountId,
      identityId: principal.identityId,
      providerId: deps.storage.id,
      displayName: await deps.storage.name(),
      username: principal.username,
      paths: principal.tokenAccess?.paths ?? [],
    };
    if (protocolVersion === 1)
      return { ...common, protocolVersion: 1 as const, readOnly: true as const };
    const capabilities = deps.writeCapabilities?.(principal) ?? NO_WRITES;
    const readOnly = !Object.values(capabilities).some(Boolean);
    return {
      ...common,
      protocolVersion: 2 as const,
      readOnly,
      capabilities,
      maxUploadBytes: DESKTOP_MAX_UPLOAD_BYTES,
      // Folder checks are served by the same write service that reports capabilities.
      ...(deps.writeCapabilities ? { listingChecks: true as const } : {}),
      ...(deps.changeFeed === true ? { changeFeed: true as const } : {}),
    };
  }
  /**
   * Issues the one credential an approval grants, for the approving login.
   * The bundle stays a list: that is the shape every Mac app reads.
   */
  async function issue(pair: Pair): Promise<IssuedCredential[]> {
    const approval = pair.approval;
    if (!approval) throw new ApiHttpError("conflict", "Connection has not been approved");
    if (pair.cancelled || pair.expires <= deps.clock().getTime())
      throw new ApiHttpError("not_found", "Connection request expired");
    const credential = await tokens.create(approval, {
      name: `Mac: ${pair.deviceName}`,
      expiresInDays: 365,
      access: { mode: approval.access, paths: ["/"] },
    });
    try {
      if (pair.cancelled || pair.expires <= deps.clock().getTime())
        throw new ApiHttpError("not_found", "Connection request expired");
      const principal = await resolve(credential.token);
      if (!principal)
        throw new ApiHttpError("unauthorized", "Storage login changed. Connect again.");
      return [
        {
          token: credential.token,
          tokenId: credential.item.id,
          expiresAt: credential.item.expiresAt as string,
          location: await location(principal, pair.protocolVersion),
        },
      ];
    } catch (error) {
      await tokens.revoke(credential.item.id, approval.accountId);
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
    /** Connects the Mac to the approving session's login, which its session already admitted. */
    async approve(
      id: string,
      owner: { readonly accountId: string; readonly identityId: string },
      access: DesktopAccessMode,
    ) {
      const pair = get(id);
      if (pair.approval) throw new ApiHttpError("conflict", "Connection already approved");
      if (pair.protocolVersion === 1 && access !== "read") {
        throw new ApiHttpError(
          "bad_request",
          "Write access requires a new connection from an updated Mac app",
        );
      }
      pair.approval = { accountId: owner.accountId, identityId: owner.identityId, access };
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
      // require working storage, an existing login, or an unexpired read grant to disconnect.
      if (!looksLikeDesktopToken(bearer))
        throw new ApiHttpError("unauthorized", "Invalid desktop credential");
      const token = await deps.apiTokens.findByHash(hashApiToken(bearer));
      if (!token) throw new ApiHttpError("unauthorized", "Invalid desktop credential");
      await tokens.revoke(token.id, token.accountId);
    },
  };
}
