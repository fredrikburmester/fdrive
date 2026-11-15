import { MeResponse, ROUTES } from "@fdrive/contracts";
import { createFilesFolder, createFilesFolderGuard, FILES_FOLDER_REASONS } from "@fdrive/local";
import { expect, it } from "vitest";
import { temporaryStorageRoot } from "../local/test-fixtures/index.ts";
import { authHarness } from "./test-fixtures/index.ts";

/**
 * A files folder fdrive may not use (a wrong or empty mount) stops file
 * access, not sessions: everyone still reaches `/auth/me` and logout, and
 * administrators the System pages that say why.
 */
it("keeps me and logout working while the files folder is refused", async () => {
  const root = temporaryStorageRoot();
  const guard = createFilesFolderGuard({
    root,
    facts: { installationId: async () => "id", holdsFiles: async () => true },
  });
  const refused = createFilesFolder({
    root,
    guard,
    users: { status: async () => "active", shared: async () => [] },
  });
  const h = authHarness({
    folder: (folder) => ({ admit: folder.admit, storage: refused.storage }),
  });
  const alice = await h.login();

  const me = await h.call(ROUTES.auth.me, { cookie: alice.cookie });
  expect(me.status).toBe(200);
  expect(MeResponse.parse(await me.json()).identity.id).toBe(alice.me.identity.id);

  // The principal's storage fails each operation, so file routes 502 instead
  // of the whole authed group.
  const storage = await h.storageFactory(alice.me.identity.id);
  await expect(storage.list("/")).rejects.toMatchObject({
    kind: "upstream_unavailable",
    message: FILES_FOLDER_REASONS.empty,
  });

  const logout = await h.call(ROUTES.auth.logout, { method: "POST", cookie: alice.cookie });
  expect(logout.status).toBe(200);
  expect((await h.call(ROUTES.auth.me, { cookie: alice.cookie })).status).toBe(401);

  // Signing in again checks only the password.
  const again = await h.call(ROUTES.auth.login, {
    method: "POST",
    body: { username: "alice", password: "alice-pass" },
  });
  expect(again.status).toBe(200);
});

/**
 * A disabled user is different: the folder no longer lets them in, so an
 * existing session stops at once rather than lingering with failing files.
 */
it("refuses every request of a local user an administrator disabled after they signed in", async () => {
  const h = authHarness();
  const alice = await h.login();
  expect((await h.call(ROUTES.auth.me, { cookie: alice.cookie })).status).toBe(200);

  await h.repos.localUsers.update("alice", { disabled: true });

  const me = await h.call(ROUTES.auth.me, { cookie: alice.cookie });
  expect(me.status).toBe(403);
  expect(await me.json()).toMatchObject({ error: { kind: "forbidden" } });

  await h.repos.localUsers.update("alice", { disabled: false });
  expect((await h.call(ROUTES.auth.me, { cookie: alice.cookie })).status).toBe(200);
});
