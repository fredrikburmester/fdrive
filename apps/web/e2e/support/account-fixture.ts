import type { SeedUser } from "@fdrive/testkit";

/** Dedicated disposable users keep account mutations isolated from the shared alice fixture. */
export const ACCOUNT_USERS: readonly SeedUser[] = [
  { username: "account_left", password: "account-left-test-password", permissions: { "/": ["*"] } },
  {
    username: "account_right",
    password: "account-right-test-password",
    permissions: { "/": ["*"] },
  },
  {
    // No seed files and no other spec touches it: its favorites, recents and
    // tags sections stay genuinely empty, unlike the shared alice fixture.
    username: "sidebar_empty",
    password: "sidebar-empty-test-password",
    permissions: { "/": ["*"] },
  },
];
export const ACCOUNT_FILES = {
  account_left: { "/same.txt": "Left account file", "/left-only.txt": "Left only" },
  account_right: { "/same.txt": "Right account file", "/right-only.txt": "Right only" },
};
