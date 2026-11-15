/** A user of the disposable Office browser fixture. */
export interface OfficeFixtureUser {
  readonly username: string;
  readonly password: string;
}

/**
 * The disposable Office browser fixture's users. alice and bob are its
 * editors; reader is not, and alice's team folder is shared with reader to
 * view only (`office-e2e/setup.ts`).
 */
export const officeFixtureUsers: readonly OfficeFixtureUser[] = [
  { username: "alice", password: "alice-password" },
  { username: "bob", password: "bob-password" },
  { username: "reader", password: "reader-password" },
];
