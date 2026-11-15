import type {
  AdminUser,
  AdminUserCreateRequest,
  AdminUsersResponse,
  AdminUserUpdateRequest,
} from "@fdrive/contracts";
import { ConflictError, type Identity, type LocalUser, LoginError, type Repos } from "@fdrive/db";
import type { CheckPassword } from "../auth/password.ts";
import { ApiHttpError } from "../errors.js";
import type { SharePasswords } from "../shares/passwords.js";
import type { HomeUsage } from "../storage/usage.js";
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
  /** The caller's address, for the login limiter the current password is checked behind. */
  readonly ip: string;
}

export interface LocalUserService {
  list(viewer: UserViewer): Promise<AdminUsersResponse>;
  create(input: AdminUserCreateRequest, viewer: UserViewer): Promise<AdminUser>;
  update(username: string, patch: AdminUserUpdateRequest, viewer: UserViewer): Promise<AdminUser>;
  /**
   * Removes the user: they can no longer sign in, their sessions and API
   * tokens end and their account is no longer an administrator. The last
   * enabled administrator cannot be removed, disabled or demoted. Their files
   * and fdrive data stay with the name, so adding the same name again gives
   * them back, without any of the access that was revoked.
   */
  remove(username: string, viewer: UserViewer): Promise<void>;
  /**
   * The active local login changes its own password, checked like a sign-in;
   * the account's other sessions end.
   */
  changeOwnPassword(input: ChangeOwnPasswordInput): Promise<void>;
}

export interface LocalUserServiceDeps {
  readonly repos: Pick<
    Repos,
    "localUsers" | "logins" | "identities" | "accounts" | "sessions" | "apiTokens"
  >;
  readonly checkPassword: CheckPassword;
  readonly passwords: SharePasswords;
  readonly clock?: () => Date;
  readonly eventLog?: SystemEventLog;
  /** What each user's folder holds, shown beside their storage limit. */
  readonly usage?: HomeUsage;
}

/** Local user administration over `app.local_users` and the logins that name them. */
export function createLocalUserService(deps: LocalUserServiceDeps): LocalUserService {
  const { repos } = deps;
  const eventLog = deps.eventLog ?? noopSystemEventLog;
  const clock = deps.clock ?? (() => new Date());

  async function requireUser(username: string): Promise<LocalUser> {
    const user = await repos.localUsers.get(username);
    if (user === null) throw new ApiHttpError("not_found", "no such user");
    return user;
  }

  /** The user's login, which exists from the moment the user does. */
  async function loginOf(username: string): Promise<Identity> {
    const identity = await repos.identities.findByUsername(username);
    if (identity === null) throw new ApiHttpError("internal", "this user has no login");
    return identity;
  }

  async function view(user: LocalUser, viewer: UserViewer): Promise<AdminUser> {
    const identity = await loginOf(user.username);
    const account = await repos.accounts.get(identity.accountId);
    return {
      username: user.username,
      disabled: user.disabled,
      isAdmin: account?.isAdmin ?? false,
      isYou: identity.accountId === viewer.accountId,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: identity.lastLoginAt?.toISOString() ?? null,
      storageUsed: (await deps.usage?.(user.username)) ?? null,
      storageLimit: user.storageLimit,
    };
  }

  /** Runs a change that could leave no enabled administrator; refused when it would. */
  async function keepingAnAdmin<T>(change: () => Promise<T>): Promise<T> {
    try {
      return await change();
    } catch (error) {
      if (error instanceof LoginError && error.code === "last_admin") {
        throw new ApiHttpError("forbidden", "fdrive needs at least one enabled administrator");
      }
      throw error;
    }
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
      const users = await repos.localUsers.list();
      return { users: await Promise.all(users.map((user) => view(user, viewer))) };
    },

    async create(input, viewer) {
      try {
        // The user comes with their account and login, so an administrator
        // can make them an administrator before they first sign in.
        await repos.logins.createUser({
          username: input.username,
          passwordHash: await deps.passwords.hash(input.password),
          isAdmin: input.isAdmin === true,
          at: clock(),
        });
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new ApiHttpError("conflict", "a user with this name already exists");
        }
        throw error;
      }
      const user = await requireUser(input.username);
      eventLog.record("general", "info", `User added: ${user.username}`);
      return view(user, viewer);
    },

    async update(username, patch, viewer) {
      const current = await requireUser(username);
      const identity = await loginOf(current.username);
      const self = identity.accountId === viewer.accountId;
      if (self && (patch.disabled === true || patch.isAdmin === false)) {
        throw new ApiHttpError("forbidden", "you cannot disable yourself or remove your own admin");
      }
      const passwordHash =
        patch.password === undefined ? undefined : await deps.passwords.hash(patch.password);
      const updated =
        (
          await keepingAnAdmin(() =>
            repos.logins.updateUser(current.username, {
              ...(passwordHash === undefined ? {} : { passwordHash }),
              ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
              ...(patch.isAdmin === undefined ? {} : { isAdmin: patch.isAdmin }),
              ...(patch.storageLimit === undefined ? {} : { storageLimit: patch.storageLimit }),
              at: clock(),
            }),
          )
        )?.user ?? current;
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
        ...(patch.storageLimit === undefined
          ? []
          : [
              patch.storageLimit === null
                ? "no storage limit"
                : `storage limit ${patch.storageLimit} bytes`,
            ]),
      ];
      if (changes.length > 0) {
        eventLog.record("general", "info", `User ${current.username}: ${changes.join(", ")}`);
      }
      return view(updated, viewer);
    },

    async remove(username, viewer) {
      const current = await requireUser(username);
      const identity = await loginOf(current.username);
      if (identity.accountId === viewer.accountId) {
        throw new ApiHttpError("forbidden", "you cannot remove yourself");
      }
      await keepingAnAdmin(() => repos.logins.removeUser(current.username));
      await endSessions(identity.accountId, viewer);
      for (const token of await repos.apiTokens.listByAccount(identity.accountId)) {
        await repos.apiTokens.delete(token.id, identity.accountId);
      }
      eventLog.record("general", "info", `User removed: ${current.username}`);
    },

    async changeOwnPassword(input) {
      const identity = await repos.identities.get(input.identityId);
      if (identity === null) throw new ApiHttpError("unauthorized", "sign in again");
      try {
        await deps.checkPassword({
          username: identity.username,
          password: input.currentPassword,
          ip: input.ip,
        });
      } catch (error) {
        // Only the password was typed here, so name it alone.
        if (error instanceof ApiHttpError && error.kind === "unauthorized") {
          throw new ApiHttpError("unauthorized", "the current password is not right");
        }
        throw error;
      }
      await repos.localUsers.update(identity.username, {
        passwordHash: await deps.passwords.hash(input.newPassword),
      });
      await repos.sessions.deleteByAccount(identity.accountId, input.sessionIdHash);
    },
  };
}
