import { ConflictError, type Repos } from "@fdrive/db";
import { isLocalUsername } from "@fdrive/local";
import { open } from "../auth/crypto.js";
import { parseStoredCredential } from "../auth/token-source.js";
import type { SharePasswords } from "../shares/passwords.js";

/** Set once the adoption below has run, so a user removed later is not brought back. */
export const LOCAL_ADOPTION_KEY = "local.adopted.v1";

export interface AdoptSealedPasswordsDeps {
  readonly repos: Pick<Repos, "identities" | "credentials" | "localUsers" | "settings">;
  readonly master: Uint8Array;
  readonly passwords: SharePasswords;
}

/**
 * Runs once, the first time the API starts with a local folder: gives every
 * login on the local provider `providerId` that has no local user a user of
 * its own, with the password fdrive sealed the last time it signed in. An
 * installation that moved from SFTPGo, whose provider row the migration
 * turned into the local one, keeps every user's password this way. A login
 * whose credential cannot be read (another master key) is skipped; an
 * administrator gives it a password. Returns the usernames adopted.
 */
export async function adoptSealedPasswords(
  deps: AdoptSealedPasswordsDeps,
  providerId: string,
): Promise<string[]> {
  if ((await deps.repos.settings.get(LOCAL_ADOPTION_KEY)) === true) return [];
  const adopted: string[] = [];
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
    try {
      await deps.repos.localUsers.create({
        username,
        passwordHash: await deps.passwords.hash(password),
      });
      adopted.push(username);
    } catch (error) {
      // Two logins differing only in case: the first keeps the name.
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  await deps.repos.settings.set(LOCAL_ADOPTION_KEY, true);
  return adopted;
}
