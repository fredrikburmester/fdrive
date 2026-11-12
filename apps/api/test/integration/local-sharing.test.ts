import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  GrantPeopleResponse,
  GrantsResponse,
  ListResponse,
  OwnedGrant,
  ROUTES,
} from "@fdrive/contracts";
import { startLocalStorage, startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { seedLocalUsers, silentLogger } from "./helpers/local-storage.ts";

const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
const SHELF = "/Shared with me";

/**
 * Folders shared between users of the local folder (`app.local_grants`),
 * end to end through the API: the owner shares, the grantee finds the folder
 * under `Shared with me`, reads it, and changes it only when allowed. Nobody
 * can pass on what was shared with them, by grant or by public link.
 */
describe("sharing folders between local users", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let storage: Awaited<ReturnType<typeof startLocalStorage>>;
  let composed: Awaited<ReturnType<typeof composeApp>>;

  beforeAll(async () => {
    [postgres, storage] = await Promise.all([
      startPostgres(),
      startLocalStorage({
        users: ["alice", "bob", "carol"].map((username) => ({
          username,
          password: `${username}-password`,
        })),
        files: {
          alice: { "/Photos/cat.jpg": "meow", "/Docs/plan.txt": "the plan" },
          bob: { "/mine.txt": "bob's own" },
        },
      }),
    ]);
    await seedLocalUsers(postgres.connectionString, storage);
    composed = await composeApp(
      loadConfig({
        DATABASE_URL: postgres.connectionString,
        FDRIVE_STORAGE_ROOT: storage.root,
        FDRIVE_MASTER_KEY: Buffer.alloc(32, 23).toString("base64"),
      }),
      silentLogger(),
    );
  }, 180_000);

  afterAll(async () => {
    await composed?.close();
    await storage?.stop();
    await postgres?.stop();
  }, 180_000);

  async function call(
    path: string,
    options: { method?: string; cookie?: string; body?: unknown; raw?: string } = {},
  ) {
    return composed.app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-requested-with": "fdrive",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : options.raw !== undefined
          ? { body: options.raw }
          : {}),
    });
  }

  async function login(username: string): Promise<string> {
    const response = await call(ROUTES.auth.login, {
      method: "POST",
      body: { credential: { username, password: `${username}-password` } },
    });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  const q = (path: string) => encodeURIComponent(path);
  const list = async (cookie: string, path: string) => {
    const response = await call(`${ROUTES.fs.list}?path=${q(path)}`, { cookie });
    expect(response.status, path).toBe(200);
    return ListResponse.parse(await response.json())
      .entries.map((entry) => entry.name)
      .sort();
  };
  const upload = (cookie: string, path: string, content: string) =>
    call(`${ROUTES.fs.upload}?path=${q(path)}`, { method: "PUT", cookie, raw: content });
  const share = async (cookie: string, path: string, username: string, access: string) => {
    const response = await call(ROUTES.grants.list, {
      method: "POST",
      cookie,
      body: { path, username, access },
    });
    return response;
  };

  it("shares, reads, refuses changes to a read-only share and writes through a writable one", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    const carol = await login("carol");

    const people = GrantPeopleResponse.parse(
      await (await call(ROUTES.grants.people, { cookie: alice })).json(),
    );
    expect([...people.usernames].sort()).toEqual(["bob", "carol"]);

    const photosResponse = await share(alice, "/Photos", "bob", "read");
    expect(photosResponse.status).toBe(201);
    const photos = OwnedGrant.parse(await photosResponse.json());
    expect(photos).toMatchObject({ path: "/Photos", username: "bob", access: "read" });
    const docsResponse = await share(alice, "/Docs", "bob", "write");
    expect(docsResponse.status).toBe(201);
    const docs = OwnedGrant.parse(await docsResponse.json());
    // Only folders, never everything, never a file, never to yourself.
    expect((await share(alice, "/", "bob", "read")).status).toBe(400);
    expect((await share(alice, "/Docs/plan.txt", "bob", "read")).status).toBe(400);
    expect((await share(alice, "/Docs", "alice", "read")).status).toBe(400);
    expect((await share(alice, "/Missing", "bob", "read")).status).toBe(404);

    const owned = GrantsResponse.parse(
      await (await call(ROUTES.grants.list, { cookie: alice })).json(),
    );
    expect(owned.available).toBe(true);
    expect(owned.owned.map((grant) => grant.path).sort()).toEqual(["/Docs", "/Photos"]);
    const received = GrantsResponse.parse(
      await (await call(ROUTES.grants.list, { cookie: bob })).json(),
    );
    expect(
      received.received.map(({ owner, name, path, access }) => ({ owner, name, path, access })),
    ).toEqual([
      { owner: "alice", name: "Photos", path: `${SHELF}/Photos`, access: "read" },
      { owner: "alice", name: "Docs", path: `${SHELF}/Docs`, access: "write" },
    ]);

    // bob finds both folders under Shared with me and reads them.
    expect(await list(bob, "/")).toEqual(["Shared with me", "mine.txt"]);
    expect(await list(bob, SHELF)).toEqual(["Docs", "Photos"]);
    expect(await list(bob, `${SHELF}/Photos`)).toEqual(["cat.jpg"]);
    const cat = await call(`${ROUTES.fs.download}?path=${q(`${SHELF}/Photos/cat.jpg`)}`, {
      cookie: bob,
    });
    expect(cat.status).toBe(200);
    expect(await cat.text()).toBe("meow");

    // A read-only share refuses every change, and the owner's file stays.
    expect((await upload(bob, `${SHELF}/Photos/dog.jpg`, "woof")).status).toBe(403);
    const deleted = await call(ROUTES.fs.delete, {
      method: "POST",
      cookie: bob,
      body: { items: [{ path: `${SHELF}/Photos/cat.jpg`, kind: "file" }] },
    });
    expect(deleted.status).toBe(403);
    expect(existsSync(storage.path("alice", "/Photos/dog.jpg"))).toBe(false);
    expect(await readFile(storage.path("alice", "/Photos/cat.jpg"), "utf8")).toBe("meow");

    // A writable share takes uploads and moves from bob's own files, into alice's folder.
    expect((await upload(bob, `${SHELF}/Docs/notes.txt`, "bob's notes")).status).toBe(201);
    const moved = await call(ROUTES.fs.move, {
      method: "POST",
      cookie: bob,
      body: { path: "/mine.txt", target: `${SHELF}/Docs/mine.txt` },
    });
    expect(moved.status).toBe(200);
    expect(await readFile(storage.path("alice", "/Docs/notes.txt"), "utf8")).toBe("bob's notes");
    expect(await readFile(storage.path("alice", "/Docs/mine.txt"), "utf8")).toBe("bob's own");
    expect(existsSync(storage.path("bob", "/mine.txt"))).toBe(false);
    expect(await list(alice, "/Docs")).toEqual(["mine.txt", "notes.txt", "plan.txt"]);

    // Nobody passes on what was shared with them: not to a third user, not as a public link.
    expect((await share(bob, `${SHELF}/Docs`, "carol", "read")).status).toBe(400);
    const link = await call(ROUTES.shares, {
      method: "POST",
      cookie: bob,
      body: { name: "Leak", paths: [`${SHELF}/Docs/plan.txt`], scope: "read" },
    });
    expect(link.status).toBe(403);
    // The owner can still share the same file publicly.
    const ownLink = await call(ROUTES.shares, {
      method: "POST",
      cookie: alice,
      body: { name: "Plan", paths: ["/Docs/plan.txt"], scope: "read" },
    });
    expect(ownLink.status).toBe(201);

    // carol was given nothing and sees nothing.
    const carolGrants = GrantsResponse.parse(
      await (await call(ROUTES.grants.list, { cookie: carol })).json(),
    );
    expect(carolGrants.received).toEqual([]);
    expect(await list(carol, "/")).toEqual([]);
    expect(
      (await call(`${ROUTES.fs.download}?path=${q(`${SHELF}/Docs/plan.txt`)}`, { cookie: carol }))
        .status,
    ).toBe(404);

    // Turning the writable share read-only stops bob's next write.
    const narrowed = await call(`${ROUTES.grants.list}/${docs.id}`, {
      method: "PATCH",
      cookie: alice,
      body: { access: "read" },
    });
    expect(narrowed.status).toBe(200);
    expect((await upload(bob, `${SHELF}/Docs/late.txt`, "too late")).status).toBe(403);
    // Only the owner changes a share.
    expect(
      (
        await call(`${ROUTES.grants.list}/${docs.id}`, {
          method: "PATCH",
          cookie: bob,
          body: { access: "write" },
        })
      ).status,
    ).toBe(404);

    // The share follows the owner's rename, and ends when the owner ends it.
    const renamed = await call(ROUTES.fs.rename, {
      method: "POST",
      cookie: alice,
      body: { path: "/Photos", newName: "Pictures" },
    });
    expect(renamed.status).toBe(200);
    expect(await list(bob, SHELF)).toEqual(["Docs", "Pictures"]);
    expect(await list(bob, `${SHELF}/Pictures`)).toEqual(["cat.jpg"]);
    const ended = await call(`${ROUTES.grants.list}/${photos.id}`, {
      method: "DELETE",
      cookie: alice,
    });
    expect(ended.status).toBe(200);
    expect(await list(bob, SHELF)).toEqual(["Docs"]);
    expect(
      (await call(`${ROUTES.fs.list}?path=${q(`${SHELF}/Pictures`)}`, { cookie: bob })).status,
    ).toBe(404);
  });
});
