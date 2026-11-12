/** A user of the disposable Office browser fixture and what they may do, by folder. */
export interface OfficeFixtureUser {
  readonly username: string;
  readonly password: string;
  /** Actions allowed under each folder; `*` is everything, which is what editing needs. */
  readonly permissions: Readonly<Record<string, readonly string[]>>;
}

/** These exact grants seed only the disposable Office browser fixture. */
export const officeFixtureUsers: readonly OfficeFixtureUser[] = [
  { username: "alice", password: "alice-password", permissions: { "/": ["*"] } },
  { username: "bob", password: "bob-password", permissions: { "/": ["*"] } },
  { username: "reader", password: "reader-password", permissions: { "/": ["list", "download"] } },
];
