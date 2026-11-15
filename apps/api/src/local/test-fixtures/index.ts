import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Identity, Provider, Repos } from "@fdrive/db";
import { createFilesFolder, type FilesFolder } from "@fdrive/local";
import { onTestFinished } from "vitest";
import { createScryptSharePasswords, type SharePasswords } from "../../shares/passwords.js";
import { createLocalUserStore, type LocalUserStore } from "../users.js";

/** scrypt at a cost tests can afford; the hashes are real and verify like production ones. */
export const FAST_PASSWORDS: SharePasswords = createScryptSharePasswords({
  cost: 1024,
  blockSize: 8,
  parallelization: 1,
});

/**
 * A fresh folder that stands in for `FDRIVE_STORAGE_ROOT`, removed when the
 * test that made it finishes (left to the OS when made outside a test).
 */
export function temporaryStorageRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fdrive-api-local-")));
  try {
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  } catch {
    // Made in a hook or at import: nothing to attach the cleanup to.
  }
  return root;
}

/** Writes `files` (path → contents) into `<root>/<username>`, creating parents. */
export function writeHomeFiles(
  root: string,
  username: string,
  files: Readonly<Record<string, string>>,
): void {
  mkdirSync(join(root, username), { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, username, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

export interface SeedLocalUser {
  readonly username: string;
  readonly password: string;
  readonly disabled?: boolean;
}

/** The files folder's row in `app.providers`, as the API ensures it at startup. */
export function seedStorageRow(repos: Pick<Repos, "providers">): Promise<Provider> {
  return repos.providers.ensure({ type: "local", baseUrl: "local" });
}

/**
 * Creates `users`, each with their account and login, with real (cheap)
 * password hashes. Their logins name the files folder's row, created here
 * first as the API creates it at startup. Resolves to the logins.
 */
export async function seedLocalUsers(
  repos: Pick<Repos, "localUsers" | "logins" | "providers">,
  users: readonly SeedLocalUser[],
  passwords: SharePasswords = FAST_PASSWORDS,
): Promise<Identity[]> {
  const provider = await seedStorageRow(repos);
  const logins: Identity[] = [];
  for (const user of users) {
    logins.push(
      await repos.logins.createUser({
        providerId: provider.id,
        username: user.username,
        passwordHash: await passwords.hash(user.password),
        isAdmin: false,
        at: new Date(),
      }),
    );
    if (user.disabled === true) await repos.localUsers.update(user.username, { disabled: true });
  }
  return logins;
}

export interface FilesFolderFixture {
  readonly root: string;
  /** The store the folder and the password check ask; spy on its methods to shape what they see. */
  readonly users: LocalUserStore;
  readonly folder: FilesFolder;
}

/** The files folder over `root` (a fresh temporary folder by default) and the repos' users. */
export function filesFolderFixture(
  repos: Pick<Repos, "localUsers" | "localGrants">,
  options: { root?: string; passwords?: SharePasswords } = {},
): FilesFolderFixture {
  const root = options.root ?? temporaryStorageRoot();
  const users = createLocalUserStore({
    repo: repos.localUsers,
    grants: repos.localGrants,
    passwords: options.passwords ?? FAST_PASSWORDS,
  });
  return {
    root,
    users,
    folder: createFilesFolder({ root, users }),
  };
}
