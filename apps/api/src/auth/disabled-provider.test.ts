import { MeResponse, ROUTES } from "@fdrive/contracts";
import { expect, it } from "vitest";
import { accountsHarness } from "../accounts/test-fixtures/index.ts";

/**
 * Disabling a provider stops file access for its logins, not their
 * sessions: an admin who disables the provider they are signed in through
 * must still reach `/auth/me`, logout and the routes that let them undo it.
 */
it("keeps me and logout working for a login whose provider was disabled", async () => {
  const h = accountsHarness();
  const row = await h.seeded;
  const alice = await h.login();
  await h.providers.update(row.id, { enabled: false });

  const me = await h.call(ROUTES.auth.me, { cookie: alice.cookie });
  expect(me.status).toBe(200);
  expect(MeResponse.parse(await me.json()).activeIdentityId).toBe(alice.me.activeIdentityId);

  // The principal itself carries storage that fails, so file routes 502
  // instead of the whole authed group.
  const storage = await h
    .storageFactory(alice.me.activeIdentityId)
    .catch((error: unknown) => error);
  expect(storage).toMatchObject({ kind: "upstream_unavailable" });

  const logout = await h.call(ROUTES.auth.logout, { method: "POST", cookie: alice.cookie });
  expect(logout.status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie: alice.cookie })).status).toBe(401);

  // New logins to the disabled provider are still refused.
  const again = await h.call(ROUTES.auth.login, {
    method: "POST",
    body: { credential: { username: "alice", password: "alice-pass" } },
  });
  expect(again.status).toBe(503);
  expect(await again.json()).toMatchObject({ error: { kind: "setup_required" } });
});
