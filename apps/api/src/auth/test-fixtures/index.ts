import { type Identity, IdentityLinksError, type Repos, type Session } from "@fdrive/db";
import type { AccountIdentityOperations } from "../../accounts/types.ts";

/** Test double only. PostgreSQL ownership/lock guarantees have separate integration coverage. */
export function memoryIdentityOperations(repos: Repos): AccountIdentityOperations {
  const changed = new Map<string, Identity>();
  const sessions = new Map<string, Session>();
  const baseIdentities = { ...repos.identities };
  const baseSessions = { ...repos.sessions };
  repos.identities.get = async (id) => changed.get(id) ?? baseIdentities.get(id);
  repos.identities.listAll = async () => {
    const all = new Map((await baseIdentities.listAll()).map((row) => [row.id, row]));
    for (const [id, row] of changed) all.set(id, row);
    return [...all.values()];
  };
  repos.identities.listByAccount = async (accountId) =>
    (await repos.identities.listAll()).filter((row) => row.accountId === accountId);
  repos.identities.findByProviderUsername = async (providerId, username) =>
    (await repos.identities.listAll()).find(
      (row) => row.providerId === providerId && row.externalUsername === username,
    ) ?? null;
  repos.sessions.create = async (input) => {
    const row = await baseSessions.create(input);
    sessions.set(row.idHash, row);
    return row;
  };
  repos.sessions.delete = async (id) => {
    sessions.delete(id);
    await baseSessions.delete(id);
  };
  let tail = Promise.resolve();
  async function atomic<T>(run: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }
  // Match the provider-row lock held by production login/link transactions.
  const updateProvider = repos.providers.update.bind(repos.providers);
  repos.providers.update = (id, patch) => atomic(() => updateProvider(id, patch));
  async function live(accountId: string, hash: string, at: Date) {
    const session = await repos.sessions.getByIdHash(hash, at);
    if (session === null || session.accountId !== accountId)
      throw new IdentityLinksError("invalid_session");
    return session;
  }
  async function owned(accountId: string, id: string) {
    const identity = await repos.identities.get(id);
    if (identity === null) throw new IdentityLinksError("missing_identity");
    if (identity.accountId !== accountId) throw new IdentityLinksError("forbidden");
    return identity;
  }
  async function revoke(identity: Identity) {
    for (const token of await repos.apiTokens.listByAccount(identity.accountId))
      if (token.identityId === identity.id)
        await repos.apiTokens.delete(token.id, identity.accountId);
  }
  async function verifyProvider(input: {
    providerId: string;
    verifiedProvider?: { type: string; baseUrl: string; allowDisabled?: boolean };
  }) {
    const provider = await repos.providers.get(input.providerId);
    if (!provider) throw new IdentityLinksError("missing_provider");
    const expected = input.verifiedProvider;
    if (
      expected !== undefined &&
      (provider.type !== expected.type ||
        provider.baseUrl !== expected.baseUrl ||
        (!provider.enabled && !expected.allowDisabled))
    )
      throw new IdentityLinksError("invalid_session");
  }
  return {
    loginVerified: (input) =>
      atomic(async () => {
        await verifyProvider(input);
        let identity = await repos.identities.findByProviderUsername(
          input.providerId,
          input.username,
        );
        const setupClaim = input.setupClaim;
        if (setupClaim !== undefined) {
          const current = await repos.settings.get(setupClaim.key);
          if (current !== null) {
            const desired = {
              version: 1,
              state: "claiming",
              accountId: identity?.accountId,
              baseUrl: setupClaim.baseUrl,
            };
            if (
              identity === null ||
              !(await repos.settings.compareAndSet(setupClaim.key, desired, desired))
            )
              throw new IdentityLinksError("setup_claimed");
          }
        }
        if (identity === null) {
          const account = await repos.accounts.create({ displayName: input.username });
          identity = await repos.identities.create({
            accountId: account.id,
            providerId: input.providerId,
            externalUsername: input.username,
          });
        }
        const revoke =
          input.compareCredential?.(identity.id, await repos.credentials.get(identity.id)) ??
          input.revokeOtherSessions;
        if (setupClaim !== undefined) {
          const desired = {
            version: 1,
            state: "claiming",
            accountId: identity.accountId,
            baseUrl: setupClaim.baseUrl,
          };
          await repos.settings.compareAndSet(setupClaim.key, null, desired);
        }
        identity = { ...identity, lastLoginAt: input.at };
        changed.set(identity.id, identity);
        await repos.credentials.put({
          identityId: identity.id,
          ...input.sealCredential(identity.id),
        });
        if (revoke === true)
          for (const session of [...sessions.values()])
            if (session.accountId === identity.accountId)
              await repos.sessions.delete(session.idHash);
        const session = await repos.sessions.create({
          ...input.session,
          accountId: identity.accountId,
          activeIdentityId: identity.id,
        });
        await repos.sessions.touch(session.idHash, {
          lastSeenAt: input.at,
          expiresAt: session.expiresAt,
        });
        return { identity, session };
      }),
    linkVerified: (input) =>
      atomic(async () => {
        await verifyProvider(input);
        if (input.requestingSessionIdHash)
          await live(input.accountId, input.requestingSessionIdHash, input.at);
        let identity = await repos.identities.findByProviderUsername(
          input.providerId,
          input.username,
        );
        if (identity === null)
          identity = await repos.identities.create({
            accountId: input.accountId,
            providerId: input.providerId,
            externalUsername: input.username,
          });
        if (identity.accountId !== input.accountId) {
          for (const session of sessions.values())
            if (
              session.accountId === identity.accountId &&
              session.activeIdentityId === identity.id
            )
              await repos.sessions.delete(session.idHash);
          await revoke(identity);
        }
        identity = { ...identity, accountId: input.accountId, lastLoginAt: input.at };
        changed.set(identity.id, identity);
        await repos.credentials.put({
          identityId: identity.id,
          ...input.sealCredential(identity.id),
        });
        return identity;
      }),
    unlink: (input) =>
      atomic(async () => {
        if (input.requestingSessionIdHash)
          await live(input.accountId, input.requestingSessionIdHash, input.at);
        const identity = await owned(input.accountId, input.identityId);
        const remaining = (await repos.identities.listByAccount(input.accountId))
          .filter((row) => row.id !== input.identityId)
          .sort((a, b) => a.id.localeCompare(b.id))[0];
        if (!remaining) throw new IdentityLinksError("last_identity");
        const account = await repos.accounts.create({ displayName: identity.externalUsername });
        const moved = { ...identity, accountId: account.id };
        changed.set(moved.id, moved);
        await revoke(identity);
        for (const session of [...sessions.values()])
          if (session.accountId === input.accountId && session.activeIdentityId === identity.id) {
            await repos.sessions.delete(session.idHash);
            if (session.idHash === input.requestingSessionIdHash)
              await repos.sessions.create({ ...session, activeIdentityId: remaining.id });
          }
        return { identity: moved, remainingIdentityId: remaining.id };
      }),
    switchActive: (input) =>
      atomic(async () => {
        await owned(input.accountId, input.identityId);
        const session = await live(input.accountId, input.sessionIdHash, input.at);
        await repos.sessions.delete(session.idHash);
        await repos.sessions.create({ ...session, activeIdentityId: input.identityId });
      }),
    rotateSession: (input) =>
      atomic(async () => {
        const previous = await live(input.accountId, input.oldSessionIdHash, input.at);
        await owned(input.accountId, input.activeIdentityId);
        const next = await repos.sessions.create({
          ...previous,
          idHash: input.newSessionIdHash,
          activeIdentityId: input.activeIdentityId,
        });
        await repos.sessions.delete(previous.idHash);
        return next;
      }),
  };
}
