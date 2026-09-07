import { allowsOfficeEdit } from "../../../src/office/edit-policy.ts";
import type { OfficeDeps } from "../../../src/office/types.ts";

import { officeFixtureUsers } from "./seeded-users.ts";

export function fixtureOfficeAuthorizer(providerId: string): NonNullable<OfficeDeps["canEdit"]> {
  const rules = officeFixtureUsers.map((user) => ({
    providerId,
    username: user.username,
    path: "/",
    recursive: true,
    allow: user.permissions["/"]?.includes("*") === true,
  }));
  return async (actor, path) => allowsOfficeEdit(rules, actor.identity, path);
}
