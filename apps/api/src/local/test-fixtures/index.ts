import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderModule } from "@fdrive/core";
import type { Repos } from "@fdrive/db";
import { createLocalModule, type LocalUsers } from "@fdrive/local";
import { onTestFinished } from "vitest";
import { createScryptSharePasswords, type SharePasswords } from "../../shares/passwords.js";
import { createLocalUserStore } from "../users.js";

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

/** Adds `users` to `app.local_users` with real (cheap) password hashes. */
export async function seedLocalUsers(
  repos: Pick<Repos, "localUsers">,
  users: readonly SeedLocalUser[],
  passwords: SharePasswords = FAST_PASSWORDS,
): Promise<void> {
  for (const user of users) {
    await repos.localUsers.create({
      username: user.username,
      passwordHash: await passwords.hash(user.password),
    });
    if (user.disabled === true) await repos.localUsers.update(user.username, { disabled: true });
  }
}

export interface LocalModuleFixture {
  readonly root: string;
  /** The store the module asks; spy on its methods to shape what the module sees. */
  readonly users: LocalUsers;
  readonly module: ProviderModule;
}

/** The local module over `root` (a fresh temporary folder by default) and the repos' users. */
export function localModuleFixture(
  repos: Pick<Repos, "localUsers" | "localGrants">,
  options: { root?: string; indexRoot?: string | null; passwords?: SharePasswords } = {},
): LocalModuleFixture {
  const root = options.root ?? temporaryStorageRoot();
  const users = createLocalUserStore({
    repo: repos.localUsers,
    grants: repos.localGrants,
    passwords: options.passwords ?? FAST_PASSWORDS,
  });
  return {
    root,
    users,
    module: createLocalModule({ root, users, indexRoot: options.indexRoot ?? null }),
  };
}
