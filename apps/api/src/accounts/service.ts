import type { LinkIdentityRequest, MeResponse } from "@fdrive/contracts";
import type { Session } from "@fdrive/db";
import { KEY_ID, seal } from "../auth/crypto.js";
import { requireCurrentConnection } from "../auth/provider-client.ts";
import { generateSessionId, hashSessionId } from "../auth/sessions.js";
import { ApiHttpError } from "../errors.js";
import { verifyAccountCredentials } from "./credentials.ts";
import { accountRepositoryCall } from "./errors.ts";
import type { AccountRequestContext, AccountsDeps } from "./types.ts";

export interface AccountRotation {
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly me: MeResponse;
}
export async function liveAccountSession(
  deps: Pick<AccountsDeps, "repos" | "clock">,
  input: AccountRequestContext,
): Promise<Session & { activeIdentityId: string }> {
  const session = await deps.repos.sessions.getByIdHash(
    hashSessionId(input.sessionId),
    deps.clock(),
  );
  if (
    session === null ||
    session.accountId !== input.principal.accountId ||
    session.activeIdentityId === null
  )
    throw new ApiHttpError("unauthorized", "live account session required");
  const identity = await deps.repos.identities.get(input.principal.identityId);
  if (identity?.accountId !== session.accountId)
    throw new ApiHttpError("forbidden", "identity does not belong to this account");
  return { ...session, activeIdentityId: session.activeIdentityId };
}
export function createAccountsService(deps: AccountsDeps) {
  async function rotate(session: Session, identityId: string): Promise<AccountRotation> {
    const sessionId = generateSessionId();
    const rotated = await accountRepositoryCall(() =>
      deps.links.rotateSession({
        accountId: session.accountId,
        oldSessionIdHash: session.idHash,
        newSessionIdHash: hashSessionId(sessionId),
        activeIdentityId: identityId,
        at: deps.clock(),
      }),
    );
    try {
      return {
        sessionId,
        expiresAt: rotated.expiresAt,
        me: await deps.auth.me(rotated.accountId, identityId),
      };
    } catch (error) {
      await deps.repos.sessions.delete(rotated.idHash);
      throw error;
    }
  }
  return {
    async link(
      input: AccountRequestContext,
      credentials: LinkIdentityRequest & { ip: string },
    ): Promise<AccountRotation> {
      await liveAccountSession(deps, input);
      const verified = await verifyAccountCredentials(deps, credentials);
      const session = await liveAccountSession(deps, input);
      await requireCurrentConnection(deps.connectionStore, verified.provider.baseUrl);
      const identity = await accountRepositoryCall(() =>
        deps.links.linkVerified({
          accountId: session.accountId,
          providerId: verified.provider.id,
          username: credentials.username,
          requestingSessionIdHash: session.idHash,
          at: deps.clock(),
          sealCredential: (id) => ({
            ciphertext: seal(
              deps.master,
              new TextEncoder().encode(JSON.stringify({ password: credentials.password })),
              id,
            ),
            keyId: KEY_ID,
          }),
        }),
      );
      await deps.tokenSource.invalidate(identity.id);
      await requireCurrentConnection(deps.connectionStore, verified.provider.baseUrl);
      await deps.tokenSource.prime(identity.id, verified.token);
      return rotate(session, identity.id);
    },
    async unlink(input: AccountRequestContext, identityId: string): Promise<AccountRotation> {
      const session = await liveAccountSession(deps, input);
      const result = await accountRepositoryCall(() =>
        deps.links.unlink({
          accountId: session.accountId,
          identityId,
          requestingSessionIdHash: session.idHash,
          at: deps.clock(),
        }),
      );
      await deps.tokenSource.invalidate(identityId);
      return rotate(
        session,
        session.activeIdentityId === identityId
          ? result.remainingIdentityId
          : session.activeIdentityId,
      );
    },
    async switch(input: AccountRequestContext, identityId: string): Promise<MeResponse> {
      const session = await liveAccountSession(deps, input);
      await accountRepositoryCall(() =>
        deps.links.switchActive({
          accountId: session.accountId,
          identityId,
          sessionIdHash: session.idHash,
          at: deps.clock(),
        }),
      );
      await liveAccountSession(deps, input);
      return deps.auth.me(session.accountId, identityId);
    },
  };
}
export type AccountsService = ReturnType<typeof createAccountsService>;
