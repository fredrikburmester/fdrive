import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, it } from "vitest";
import {
  type AccessChange,
  createAccessRepo,
  createDb,
  createOfficeFileRepo,
  createRepos,
  createShareRepo,
  migrate,
} from "../../src/index.js";
import { localUsers } from "../../src/schema/app.js";

/** Resolves once `count` callbacks have run, so a test can wait for all of them. */
function barrier() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

it("applies what grants access in the file operation's transaction, and holds its paths", {
  timeout: 180_000,
}, async () => {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  const main = createDb(container.getConnectionUri());
  const first = createDb(container.getConnectionUri(), { max: 2 });
  const second = createDb(container.getConnectionUri(), { max: 2 });
  try {
    await migrate(main.db);
    const repos = createRepos(main.db);
    const account = await repos.accounts.create({ displayName: "Alice" });
    const provider = await repos.providers.ensure({ type: "local", baseUrl: "local" });
    const alice = await repos.identities.create({
      accountId: account.id,
      providerId: provider.id,
      externalUsername: "alice",
    });
    await main.db.insert(localUsers).values([
      { username: "alice", passwordHash: "unused" },
      { username: "bob", passwordHash: "unused" },
    ]);
    const grant = await repos.localGrants.put({
      ownerUsername: "alice",
      path: "/Projects",
      granteeUsername: "bob",
      access: "write",
    });
    const shares = createShareRepo(main.db);
    const link = await shares.insert({
      identityId: alice.id,
      name: "Link",
      description: "",
      scope: "read",
      paths: ["/Projects", "/notes.txt"],
      expiresAt: null,
      maxDownloads: 0,
      presentation: "auto",
      passwordHash: null,
      at: new Date(),
    });
    const office = createOfficeFileRepo(main.db);
    const doc = await office.ensure({ identityId: alice.id, path: "/Projects/plan.docx" });
    const state = async () => ({
      grant: (await repos.localGrants.get(grant.id))?.path ?? null,
      link: (await shares.get(link.id))?.paths ?? null,
      doc: (await office.get(doc.id))?.path ?? null,
    });
    const moved = (from: string, to: string | null): AccessChange => ({
      directory: true,
      shares: { identityId: alice.id, from, to },
      grants: { owner: "alice", from, to },
      office: {
        from: { identityId: alice.id, path: from },
        to: to === null ? null : { identityId: alice.id, path: to },
      },
    });

    const a = createAccessRepo(first.db),
      b = createAccessRepo(second.db);

    // Nothing is kept unless the work it goes with succeeds.
    await expect(
      a.run([], async (follow) => {
        await follow(moved("/Projects", "/Work"));
        throw new Error("the storage call failed");
      }),
    ).rejects.toThrow("the storage call failed");
    expect(await state()).toEqual({
      grant: "/Projects",
      link: ["/Projects", "/notes.txt"],
      doc: "/Projects/plan.docx",
    });
    // A statement that fails takes back the ones before it.
    await expect(
      a.run([], async (follow) => {
        await follow({ ...moved("/Projects", "/Work"), office: null });
        await follow({
          directory: false,
          shares: null,
          grants: null,
          office: {
            from: { identityId: alice.id, path: "/x" },
            to: { identityId: alice.id, path: "bad" },
          },
        });
      }),
    ).rejects.toThrow();
    expect((await state()).grant).toBe("/Projects");

    // Everything follows together.
    expect(
      await a.run([], async (follow) => {
        await follow(moved("/Projects", "/Work"));
        return "moved";
      }),
    ).toBe("moved");
    expect(await state()).toEqual({
      grant: "/Work",
      link: ["/Work", "/notes.txt"],
      doc: "/Work/plan.docx",
    });

    // A path held exclusively waits for nobody else and makes everyone else wait.
    const order: string[] = [];
    const held = barrier();
    const entered = barrier();
    const vacating = a.run([{ identityId: alice.id, path: "/Work", exclusive: true }], async () => {
      order.push("vacate");
      entered.open();
      await held.opened;
      order.push("vacated");
    });
    await entered.opened;
    const creating = b.run(
      [
        { identityId: alice.id, path: "/", exclusive: false },
        { identityId: alice.id, path: "/Work", exclusive: false },
        { identityId: alice.id, path: "/Work/new", exclusive: false },
      ],
      async () => {
        order.push("create under it");
      },
    );
    // Elsewhere, and a shared hold of the same folder above, nothing waits.
    const other = createAccessRepo(main.db);
    await other.run(
      [
        { identityId: alice.id, path: "/", exclusive: false },
        { identityId: alice.id, path: "/Elsewhere", exclusive: false },
      ],
      async () => {
        order.push("create elsewhere");
      },
    );
    held.open();
    await Promise.all([vacating, creating]);
    expect(order).toEqual(["vacate", "create elsewhere", "vacated", "create under it"]);

    // A path that is gone takes everything with it; the link keeps its other path.
    await a.run([], (follow) => follow(moved("/Work", null)));
    expect(await state()).toEqual({ grant: null, link: ["/notes.txt"], doc: null });
  } finally {
    await first.close();
    await second.close();
    await main.close();
    await container.stop();
  }
});
