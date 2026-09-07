import type { SeedUser } from "@fdrive/testkit";

/** These exact grants seed only the disposable Office browser fixture. */
export const officeFixtureUsers: readonly SeedUser[] = [
  { username: "alice", password: "alice-password", permissions: { "/": ["*"] } },
  { username: "bob", password: "bob-password", permissions: { "/": ["*"] } },
  { username: "reader", password: "reader-password", permissions: { "/": ["list", "download"] } },
];
