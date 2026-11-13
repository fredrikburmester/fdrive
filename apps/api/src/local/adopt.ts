import { ConflictError, type Repos } from "@fdrive/db";
import { isLocalUsername } from "@fdrive/local";
import { open } from "../auth/crypto.js";
import { parseStoredCredential } from "../auth/token-source.js";
import type { SharePasswords } from "../shares/passwords.js";

/** Set once the adoption below has run, so a user removed later is not brought back. */
export const LOCAL_ADOPTION_KEY = "local.adopted.v1";

export interface AdoptSealedPasswordsDeps {
  readonly repos: Pick<
    Repos,
    "identities" | "credentials" | "localUsers" | "settings" | "accounts"
  >;
  readonly master: Uint8Array;
  readonly passwords: SharePasswords;
}

export interface AdoptedUsers {
  /** Administrators, who can sign in right away. */
  readonly enabled: readonly string[];
  /** Everyone else, added disabled until an administrator enables them. */
  readonly disabled: readonly string[];
}

/**
 * Runs once, the first time the API starts with a local folder: gives every
 * login on the local provider `providerId` that has no local user a user of
 * its own, with the password fdrive sealed the last time it signed in. An
 * installation that moved from SFTPGo, whose provider row the migration
 * turned into the local one, keeps every user's password this way.
 *
 * Only administrators come back able to sign in. fdrive cannot tell whether
 * SFTPGo had disabled or removed anyone else since they last signed in, so
 * the rest are added disabled: one click under System > Users lets each one
 * in again. A login whose credential cannot be read (another master key) is
 * skipped; an administrator gives it a password.
 */
export async function adoptSealedPasswords(
  deps: AdoptSealedPasswordsDeps,
  providerId: string,
): Promise<AdoptedUsers> {
  const enabled: string[] = [];
  const disabled: string[] = [];
  if ((await deps.repos.settings.get(LOCAL_ADOPTION_KEY)) === true) return { enabled, disabled };
  for (const identity of await deps.repos.identities.listAll()) {
    if (identity.providerId !== providerId) continue;
    const username = identity.externalUsername;
    if (!isLocalUsername(username) || (await deps.repos.localUsers.get(username)) !== null) {
      continue;
    }
    const stored = await deps.repos.credentials.get(identity.id);
    if (stored === null) continue;
    let password: string | undefined;
    try {
      password = parseStoredCredential(open(deps.master, stored.ciphertext, identity.id)).password;
    } catch {
      continue;
    }
    if (password === undefined || password.length === 0) continue;
    const admin = (await deps.repos.accounts.get(identity.accountId))?.isAdmin === true;
    try {
      await deps.repos.localUsers.create({
        username,
        passwordHash: await deps.passwords.hash(password),
      });
    } catch (error) {
      // Two logins differing only in case: the first keeps the name.
      if (!(error instanceof ConflictError)) throw error;
      continue;
    }
    if (admin) {
      enabled.push(username);
    } else {
      await deps.repos.localUsers.update(username, { disabled: true });
      disabled.push(username);
    }
  }
  await deps.repos.settings.set(LOCAL_ADOPTION_KEY, true);
  return { enabled, disabled };
}
