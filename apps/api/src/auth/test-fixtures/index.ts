import { type ProviderModule, StorageError, type StorageProvider } from "@fdrive/core";
import { type Identity, IdentityLinksError, type Repos, type Session } from "@fdrive/db";
import type { AccountIdentityOperations } from "../../accounts/types.ts";
import { fakeProviderModule } from "../../providers/test-fixtures/index.ts";

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
  repos.sessions.touch = async (id, input) => {
    await baseSessions.touch(id, input);
    const session = sessions.get(id);
    if (session !== undefined) sessions.set(id, { ...session, ...input });
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
  async function storeCredential(
    identityId: string,
    seal: (id: string) => { ciphertext: Uint8Array; keyId: string },
  ) {
    await repos.credentials.put({ identityId, ...seal(identityId) });
    await repos.credentials.setCachedToken(identityId, null);
  }
  async function transferMetadata(identity: Identity, accountId: string) {
    const targets = new Map((await repos.tags.list(accountId)).map((tag) => [tag.name, tag]));
    const remapped = new Map<string, string>();
    const paths = new Set<string>();
    for (const source of await repos.tags.list(identity.accountId)) {
      const tagged = await repos.fileTags.pathsForTag(identity.id, source.id);
      if (tagged.length === 0) continue;
      const target =
        targets.get(source.name) ??
        (await repos.tags.create(accountId, {
          name: source.name,
          color: source.color,
        }));
      targets.set(source.name, target);
      remapped.set(source.id, target.id);
      for (const path of tagged) paths.add(path);
    }
    for (const [path, tags] of await repos.fileTags.tagsForPaths(identity.id, [...paths])) {
      await repos.fileTags.setTags(
        identity.id,
        path,
        tags.map((id) => remapped.get(id) ?? id),
      );
    }
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
        await storeCredential(identity.id, input.sealCredential);
        if (revoke === true)
          for (const session of [...sessions.values()])
            if (session.accountId === identity.accountId)
              await repos.sessions.delete(session.idHash);
        const sessionInput = {
          ...input.session,
          accountId: identity.accountId,
          activeIdentityId: identity.id,
          createdAt: input.at,
          lastSeenAt: input.at,
        };
        const session = await repos.sessions.create(sessionInput);
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
          await transferMetadata(identity, input.accountId);
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
        await storeCredential(identity.id, input.sealCredential);
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
        await transferMetadata(identity, account.id);
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
        const rotated = {
          ...previous,
          idHash: input.newSessionIdHash,
          activeIdentityId: input.activeIdentityId,
          lastSeenAt: input.at,
        };
        const next = await repos.sessions.create(rotated);
        await repos.sessions.delete(previous.idHash);
        return next;
      }),
  };
}

export interface FakeTokenServer {
  readonly fetch: typeof globalThis.fetch;
  /** Every token the server has minted. */
  readonly state: { readonly tokens: Set<string> };
}

/**
 * A storage server that hands out short-lived tokens: `POST /token` with
 * Basic credentials answers `{ token, expiresAt }`, 401 for a wrong
 * password and 403 for a `disabled` user. Anything else is 404.
 */
export function createFakeTokenServer(options: {
  readonly users: readonly { username: string; password: string; disabled?: boolean }[];
  readonly tokenTtlMs?: number;
  readonly now?: () => Date;
}): FakeTokenServer {
  const tokens = new Set<string>();
  const now = options.now ?? (() => new Date());
  return {
    state: { tokens },
    async fetch(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/token" || init?.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const basic = new Headers(init.headers).get("authorization")?.replace(/^Basic /, "") ?? "";
      const [username, password] = Buffer.from(basic, "base64").toString().split(":");
      const user = options.users.find(
        (candidate) => candidate.username === username && candidate.password === password,
      );
      if (user === undefined) return new Response("unauthorized", { status: 401 });
      if (user.disabled === true) return new Response("disabled", { status: 403 });
      const token = `token-${tokens.size + 1}-${user.username}`;
      tokens.add(token);
      return Response.json({
        token,
        expiresAt: new Date(now().getTime() + (options.tokenTtlMs ?? 20 * 60 * 1000)),
      });
    },
  };
}

/**
 * Storage that signs requests with a token minted from the stored password
 * at `<baseUrl>/token` (see `createFakeTokenServer`), registered as `webdav`
 * so the registry accepts its rows. Its `list` sends one authorized request
 * to `<baseUrl>/files` and, on a 401, forgets the token and tries once more
 * with a fresh one, as token-based backends do.
 */
export function tokenMintingModule(overrides: Partial<ProviderModule> = {}): ProviderModule {
  return fakeProviderModule({
    async mint(instance, session, ctx) {
      const basic = `${session.externalUsername}:${session.credential.password ?? ""}`;
      const response = await ctx.fetch(`${instance.baseUrl}/token`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(basic).toString("base64")}` },
      });
      if (response.status === 401) throw new StorageError("unauthorized", "invalid password");
      if (response.status === 403) throw new StorageError("forbidden", "user disabled");
      if (!response.ok) {
        throw new StorageError(
          "upstream_unavailable",
          `token endpoint answered ${response.status}`,
        );
      }
      const body = (await response.json()) as { token: string; expiresAt: string };
      return { token: body.token, expiresAt: new Date(body.expiresAt) };
    },
    createStorage(instance, session, ctx) {
      const send = async () =>
        ctx.fetch(`${instance.baseUrl}/files`, {
          headers: { authorization: `Bearer ${await session.getToken()}` },
        });
      const unsupported = (): never => {
        throw new StorageError("internal", "not part of this fake");
      };
      return {
        async list() {
          let response = await send();
          if (response.status === 401) {
            await session.invalidateToken();
            response = await send();
          }
          if (!response.ok) throw new StorageError("upstream_unavailable", "listing failed");
          return [];
        },
        stat: unsupported,
        statFile: unsupported,
        download: unsupported,
        upload: unsupported,
        mkdir: unsupported,
        move: unsupported,
        copy: unsupported,
        deleteFile: unsupported,
        deleteDir: unsupported,
      } satisfies StorageProvider;
    },
    ...overrides,
  });
}
