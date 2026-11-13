import { SEED_FILES, SEED_USERS, type SeedFiles, type SeedUser } from "@fdrive/testkit";
import { ACCOUNT_FILES, ACCOUNT_USERS } from "./account-fixture.js";
import { PEOPLE_FILES, PEOPLE_GRANTS, PEOPLE_USERS } from "./people-fixture.js";
import { SHARE_FILES, SHARE_USERS } from "./share-fixture.js";

/** `folder-view.spec.ts`'s own user, whose folder views no other spec changes. */
const FOLDER_VIEWS_USER: SeedUser = {
  username: "folder_views",
  password: "folder-views-test-password",
};

/**
 * Everyone with a home in the shared e2e folder. The testkit's grants
 * (alice's docs shared with bob) are left out on purpose: bob's search
 * would then reach alice's indexed readme, which `search.spec.ts` proves
 * it does not. Specs about sharing use their own users.
 */
export const E2E_USERS: readonly SeedUser[] = [
  ...SEED_USERS,
  ...ACCOUNT_USERS,
  ...SHARE_USERS,
  ...PEOPLE_USERS,
  FOLDER_VIEWS_USER,
];

export const E2E_FILES: SeedFiles = {
  ...SEED_FILES,
  ...ACCOUNT_FILES,
  ...SHARE_FILES,
  ...PEOPLE_FILES,
};

export const E2E_GRANTS = PEOPLE_GRANTS;
