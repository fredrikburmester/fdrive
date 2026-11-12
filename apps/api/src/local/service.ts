import type {
  AdminUser,
  AdminUserCreateRequest,
  AdminUsersResponse,
  AdminUserUpdateRequest,
} from "@fdrive/contracts";
import { ConflictError, type Identity, type LocalUser, type Repos } from "@fdrive/db";
import type { LocalUsers } from "@fdrive/local";
import { KEY_ID, seal } from "../auth/crypto.js";
import { ApiHttpError } from "../errors.js";
import type { SharePasswords } from "../shares/passwords.js";
import { noopSystemEventLog, type SystemEventLog } from "../system/event-log.js";

/** Who is asking: the administrator's account, and their session when they act on themselves. */
export interface UserViewer {
  readonly accountId: string;
  readonly sessionIdHash?: string;
}

export interface ChangeOwnPasswordInput {
  readonly identityId: string;
  readonly sessionIdHash: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface LocalUserService {
  list(viewer: UserViewer): Promise<AdminUsersResponse>;
  create(input: AdminUserCreateRequest, viewer: UserViewer): Promise<AdminUser>;
  update(username: string, patch: AdminUserUpdateRequest, viewer: UserViewer): Promise<AdminUser>;
  /**
   * Removes the user: they can no longer sign in, their sessions and API
   * tokens end and their account is no longer an administrator. Their files
   * and fdrive data stay with the name, so adding the same name again gives
   * them back, without any of the access that was revoked.
   */
  remove(username: string, viewer: UserViewer): Promise<void>;
  /**
   * Setup's first user. Creates the user, or accepts one that already exists
   * with this very password, so an interrupted setup can be resumed.
   * Returns a function that undoes a creation when the setup login fails.
   */
  createOwner(username: string, password: string): Promise<() => Promise<void>>;
  /** The active local login changes its own password; the account's other sessions end. */
  changeOwnPassword(input: ChangeOwnPasswordInput): Promise<void>;
}

export interface LocalUserServiceDeps {
  readonly repos: Pick<
    Repos,
    "localUsers" | "identities" | "accounts" | "sessions" | "credentials" | "apiTokens"
  >;
  readonly store: LocalUsers;
  readonly passwords: SharePasswords;
  readonly master: Uint8Array;
  /** The local provider's row id, or `null` when the deployment serves no folder. */
  readonly providerId: () => Promise<string | null>;
  readonly eventLog?: SystemEventLog;
}

/** Local user administration over `app.local_users` and the logins that name them. */
export function createLocalUserService(deps: LocalUserServiceDeps): LocalUserService {
  const { repos } = deps;
  const eventLog = deps.eventLog ?? noopSystemEventLog;

  async function requireProvider(): Promise<string> {
    const id = await deps.providerId();
    if (id === null) {
      throw new ApiHttpError("unsupported", "this deployment serves no local folder");
    }
    return id;
  }

  async function requireUser(username: string): Promise<LocalUser> {
    const user = await repos.localUsers.get(username);
    if (user === null) throw new ApiHttpError("not_found", "no such user");
    return user;
  }

  /** The user's login on the local provider, created with its own account when there is none. */
  async function ensureIdentity(providerId: string, username: string): Promise<Identity> {
    const existing = await repos.identities.findByProviderUsername(providerId, username);
    if (existing !== null) return existing;
    const account = await repos.accounts.create({ displayName: null });
    return repos.identities.create({ accountId: account.id, providerId, externalUsername: username });
  }

  async function view(providerId: string, user: LocalUser, viewer: UserViewer): Promise<AdminUser> {
    const identity = await repos.identities.findByProviderUsername(providerId, user.username);
    const account = identity === null ? null : await repos.accounts.get(identity.accountId);
    return {
      username: user.username,
      disabled: user.disabled,
      isAdmin: account?.isAdmin ?? false,
      isYou: account !== null && account.id === viewer.accountId,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: identity?.lastLoginAt?.toISOString() ?? null,
    };
  }

  /** Signs the user out everywhere, except the viewer's own session when the user is them. */
  async function endSessions(accountId: string, viewer: UserViewer): Promise<void> {
    await repos.sessions.deleteByAccount(
      accountId,
      accountId === viewer.accountId ? viewer.sessionIdHash : undefined,
    );
  }

  return {
    async list(viewer) {
      const providerId = await deps.providerId();
      if (providerId === null) return { available: false, users: [] };
      const users = await repos.localUsers.list();
      return {
        available: true,
        users: await Promise.all(users.map((user) => view(providerId, user, viewer))),
      };
    },

    async create(input, viewer) {
      const providerId = await requireProvider();
      let user: LocalUser;
      try {
        user = await repos.localUsers.create({
          username: input.username,
          passwordHash: await deps.passwords.hash(input.password),
        });
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new ApiHttpError("conflict", "a user with this name already exists");
        }
        throw error;
      }
      // The login exists from the start, so an administrator can make the
      // user an administrator before they first sign in.
      const identity = await ensureIdentity(providerId, user.username);
      if (input.isAdmin === true) await repos.accounts.setAdmin(identity.accountId, true);
      eventLog.record("general", "info", `User added: ${user.username}`);
      return view(providerId, user, viewer);
    },

    async update(username, patch, viewer) {
      const providerId = await requireProvider();
      const current = await requireUser(username);
      const identity = await ensureIdentity(providerId, current.username);
      const self = identity.accountId === viewer.accountId;
      if (self && (patch.disabled === true || patch.isAdmin === false)) {
        throw new ApiHttpError("forbidden", "you cannot disable yourself or remove your own admin");
      }
      const updated =
        (await repos.localUsers.update(current.username, {
          ...(patch.password === undefined
            ? {}
            : { passwordHash: await deps.passwords.hash(patch.password) }),
          ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
        })) ?? current;
      if (patch.isAdmin !== undefined) await repos.accounts.setAdmin(identity.accountId, patch.isAdmin);
      // A new password or a disabled user ends every session that predates it.
      if (patch.password !== undefined || patch.disabled === true) {
        await endSessions(identity.accountId, viewer);
      }
      const changes = [
        ...(patch.password === undefined ? [] : ["password reset"]),
        ...(patch.disabled === undefined ? [] : [patch.disabled ? "disabled" : "enabled"]),
        ...(patch.isAdmin === undefined
          ? []
          : [patch.isAdmin ? "made an administrator" : "no longer an administrator"]),
      ];
      if (changes.length > 0) {
        eventLog.record("general", "info", `User ${current.username}: ${changes.join(", ")}`);
      }
      return view(providerId, updated, viewer);
    },

    async remove(username, viewer) {
      const providerId = await requireProvider();
      const current = await requireUser(username);
      const identity = await repos.identities.findByProviderUsername(providerId, current.username);
      if (identity !== null && identity.accountId === viewer.accountId) {
        throw new ApiHttpError("forbidden", "you cannot remove yourself");
      }
      await repos.localUsers.delete(current.username);
      if (identity !== null) {
        await endSessions(identity.accountId, viewer);
        await repos.accounts.setAdmin(identity.accountId, false);
        for (const token of await repos.apiTokens.listByAccount(identity.accountId)) {
          await repos.apiTokens.delete(token.id, identity.accountId);
        }
      }
      eventLog.record("general", "info", `User removed: ${current.username}`);
    },

    async createOwner(username, password) {
      await requireProvider();
      const existing = await repos.localUsers.get(username);
      if (existing !== null) {
        const check = await deps.store.verify(username, password);
        if (check.result !== "ok") {
          throw new ApiHttpError("conflict", "a user with this name already exists");
        }
        return async () => {};
      }
      try {
        const created = await repos.localUsers.create({
          username,
          passwordHash: await deps.passwords.hash(password),
        });
        return async () => {
          await repos.localUsers.delete(created.username);
        };
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new ApiHttpError("conflict", "a user with this name already exists");
        }
        throw error;
      }
    },

    async changeOwnPassword(input) {
      const providerId = await requireProvider();
      const identity = await repos.identities.get(input.identityId);
      if (identity === null || identity.providerId !== providerId) {
        throw new ApiHttpError("unsupported", "this login's password is not kept by fdrive");
      }
      const check = await deps.store.verify(identity.externalUsername, input.currentPassword);
      if (check.result === "disabled") {
        throw new ApiHttpError("forbidden", "this user may not sign in");
      }
      if (check.result !== "ok") {
        throw new ApiHttpError("unauthorized", "the current password is not right");
      }
      await repos.localUsers.update(identity.externalUsername, {
        passwordHash: await deps.passwords.hash(input.newPassword),
      });
      // The sealed credential follows, so a later comparison sees the new password.
      await repos.credentials.put({
        identityId: identity.id,
        ciphertext: seal(
          deps.master,
          new TextEncoder().encode(
            JSON.stringify({ username: identity.externalUsername, password: input.newPassword }),
          ),
          identity.id,
        ),
        keyId: KEY_ID,
      });
      await repos.sessions.deleteByAccount(identity.accountId, input.sessionIdHash);
    },
  };
}
