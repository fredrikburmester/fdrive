import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createDb,
  createDesktopEffectsRepo,
  createDesktopRepo,
  createOfficeFileRepo,
  createOfficeWriteScope,
  createRepos,
  type DesktopEffectContext,
  migrate,
} from "../../src/index.js";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let first: ReturnType<typeof createDb>;
let second: ReturnType<typeof createDb>;
beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  first = createDb(container.getConnectionUri());
  second = createDb(container.getConnectionUri());
  await migrate(first.db);
}, 180_000);
afterAll(async () => {
  await first?.close();
  await second?.close();
  await container?.stop();
});
async function fixture() {
  const repos = createRepos(first.db);
  const account = await repos.accounts.create({ displayName: "Recovery" });
  const provider = await repos.providers.ensure({
    type: "webdav",
    baseUrl: `http://${randomUUID()}.test`,
  });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const desktop = createDesktopRepo(first.db);
  const worker = createDesktopEffectsRepo(first.db);
  const restarted = createDesktopEffectsRepo(second.db);
  const office = createOfficeFileRepo(first.db);
  const tag = await repos.tags.create(account.id, { name: "A", color: null });
  const tag2 = await repos.tags.create(account.id, { name: "B", color: null });
  const seed = async (path: string) => {
    await repos.fileTags.setTags(identity.id, path, [tag.id, tag2.id]);
    await repos.favorites.add(identity.id, path, "file");
    await repos.recents.touch(identity.id, path);
    await repos.folderViews.set(identity.id, path, "grid");
  };
  const commit = async (context: Partial<DesktopEffectContext> = {}) => {
    const id = randomUUID();
    const result = { operationId: id, state: "completed", item: { path: context.to ?? "/new" } };
    await desktop.reserve({
      id,
      identityId: identity.id,
      accountId: account.id,
      requestHash: id,
      request: {},
      state: "committing",
    });
    const contextToCapture: DesktopEffectContext = {
      from: "/old",
      to: "/new",
      directory: true,
      trash: false,
      office: null,
      ...context,
    };
    const effects = await desktop.captureEffects(identity.id, account.id, contextToCapture);
    expect(await desktop.complete(identity.id, account.id, id, result, effects)).toBe(true);
    return { id, result, effects };
  };
  const due = () =>
    first.db.execute(
      sql`update app.desktop_effects set next_attempt_at = now() where identity_id = ${identity.id}`,
    );
  return {
    repos,
    account,
    provider,
    identity,
    desktop,
    worker,
    restarted,
    office,
    tag,
    seed,
    commit,
    due,
  };
}

it("atomically records a receipt and replays metadata once across pools, including Unicode prefixes and Office ids", async () => {
  const f = await fixture();
  const from = "/å🚀_%";
  await f.seed(from + "/a");
  await f.seed("/new/a");
  await f.seed("/å🚀XX/a");
  const source = await f.office.ensure({
    providerId: f.provider.id,
    rootName: "root",
    path: "alice/å🚀_%/a",
  });
  const replaced = await f.office.ensure({
    providerId: f.provider.id,
    rootName: "root",
    path: "alice/new/a",
  });
  const job = await f.commit({
    from,
    office: { providerId: f.provider.id, rootName: "root", from: "alice/å🚀_%", to: "alice/new" },
  });
  expect(await f.restarted.pending(f.identity.id)).toBe(true);
  expect(await f.restarted.pending()).toBe(true);
  expect((await f.restarted.status()).find((j) => j.operationId === job.id)?.attempts).toBe(0);
  const publish = vi.fn();
  expect(await f.restarted.processNext(publish, f.identity.id)).toMatchObject({
    state: "completed",
    operationId: job.id,
  });
  expect(await f.restarted.processNext(publish, f.identity.id)).toEqual({ state: "idle" });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({
      identityId: f.identity.id,
      op: "move",
      paths: [from],
      targetPaths: ["/new"],
    }),
  );
  expect(await f.repos.fileTags.pathsForTag(f.identity.id, f.tag.id)).toEqual(
    expect.arrayContaining(["/new/a", "/å🚀XX/a"]),
  );
  expect((await f.repos.favorites.list(f.identity.id)).map((r) => r.path).sort()).toEqual(
    ["/new/a", "/å🚀XX/a"].sort(),
  );
  expect(await f.repos.folderViews.get(f.identity.id, from + "/a")).toBeNull();
  expect(await f.repos.folderViews.get(f.identity.id, "/new/a")).toMatchObject({ mode: "grid" });
  expect((await f.repos.recents.list(f.identity.id, 100)).map((r) => r.path)).not.toContain(
    from + "/a",
  );
  expect((await f.office.get(source.id))?.path).toBe("alice/new/a");
  expect(await f.office.get(replaced.id)).toBeNull();
  expect(
    await f.desktop.complete(f.identity.id, f.account.id, job.id, { changed: true }, job.effects),
  ).toBe(false);
  expect((await f.desktop.operation(f.identity.id, f.account.id, job.id))?.result).toEqual(
    job.result,
  );
  expect(await f.desktop.complete(f.identity.id, randomUUID(), job.id, {}, job.effects)).toBe(
    false,
  );
});

it("commits metadata before delivery and retries only notification after a failure or restart", async () => {
  const f = await fixture();
  await f.seed("/old/a");
  const job = await f.commit();
  const failing = vi.fn(() => {
    throw Error("secret credentials should not enter status");
  });
  expect(await f.worker.processNext(failing, f.identity.id)).toMatchObject({ state: "failed" });
  expect((await f.repos.favorites.list(f.identity.id))[0]?.path).toBe("/new/a");
  expect((await f.repos.fileTags.pathsForTag(f.identity.id, f.tag.id))[0]).toBe("/new/a");
  // Recreated source rows must survive a notification-only retry.
  await f.seed("/old/a");
  expect((await f.worker.status()).find((j) => j.operationId === job.id)).toMatchObject({
    attempts: 1,
    lastError: "Metadata recovery failed; retry scheduled.",
  });
  expect(await f.restarted.processNext(vi.fn(), f.identity.id)).toEqual({ state: "idle" });
  expect((await f.desktop.operation(f.identity.id, f.account.id, job.id))?.result).toEqual(
    job.result,
  );
  await f.due();
  expect(await f.restarted.processNext(vi.fn(), f.identity.id)).toMatchObject({
    state: "completed",
  });
  expect(await f.worker.pending(f.identity.id)).toBe(false);
  expect((await f.repos.favorites.list(f.identity.id)).map((r) => r.path).sort()).toEqual([
    "/new/a",
    "/old/a",
  ]);
});

it("preserves reused source paths and refuses newer destination metadata atomically", async () => {
  const f = await fixture();
  await f.seed("/old/a");
  await f.seed("/new/a");
  await f.seed("/old/b");
  await f.commit();
  await f.repos.favorites.add(f.identity.id, "/new/a", "dir");
  const publish = vi.fn();
  expect(await f.worker.processNext(publish, f.identity.id)).toMatchObject({ state: "failed" });
  expect(publish).not.toHaveBeenCalled();
  expect(await f.repos.fileTags.pathsForTag(f.identity.id, f.tag.id)).toContain("/old/a");
  expect(
    (await f.worker.status()).find((j) => j.identityId === f.identity.id)?.lastError,
  ).toContain("Newer destination");
  await f.repos.favorites.remove(f.identity.id, "/new/a");
  // Every metadata class gets a new revision when edited in place.
  await f.seed("/old/b");
  await f.due();
  expect(await f.restarted.processNext(publish, f.identity.id)).toMatchObject({
    state: "completed",
  });
  expect((await f.repos.favorites.list(f.identity.id)).map((r) => r.path)).toEqual(
    expect.arrayContaining(["/old/b", "/new/a"]),
  );
  expect(await f.repos.fileTags.pathsForTag(f.identity.id, f.tag.id)).toContain("/old/b");
  expect(await f.repos.folderViews.get(f.identity.id, "/old/b")).not.toBeNull();
  expect((await f.repos.recents.list(f.identity.id, 100)).map((r) => r.path)).toContain("/old/b");
});

it("trashes only captured recents and retires Office registrations for cross-root moves", async () => {
  const f = await fixture();
  await f.seed("/old/a");
  await f.seed("/old-extra/a");
  await f.commit({ trash: true, to: "/.fdrive-desktop/trash/item" });
  const publish = vi.fn();
  await f.worker.processNext(publish, f.identity.id);
  expect(publish).toHaveBeenLastCalledWith(
    expect.objectContaining({ op: "delete", paths: ["/old"] }),
  );
  expect((await f.repos.recents.list(f.identity.id, 100)).map((r) => r.path)).toEqual([
    "/old-extra/a",
  ]);
  expect(await f.repos.fileTags.pathsForTag(f.identity.id, f.tag.id)).toContain("/old/a");
  const source = await f.office.ensure({
    providerId: f.provider.id,
    rootName: "root",
    path: "alice/old",
  });
  await f.commit({
    directory: false,
    office: { providerId: f.provider.id, rootName: "root", from: "alice/old", to: null },
  });
  await f.worker.processNext(publish, f.identity.id);
  expect(await f.office.get(source.id)).toBeNull();
  // File moves do not touch descendants.
  expect(await f.repos.fileTags.pathsForTag(f.identity.id, f.tag.id)).toContain("/old/a");
});

it("serializes concurrent workers and preserves per-identity order while another identity proceeds", async () => {
  const f = await fixture();
  const firstJob = await f.commit({ from: null, directory: false });
  const nextJob = await f.commit({ from: null });
  await first.db.execute(
    sql`update app.desktop_effects set next_attempt_at = now() + interval '1 hour' where operation_id = ${firstJob.id}`,
  );
  expect(await f.worker.processNext(vi.fn(), f.identity.id)).toEqual({ state: "idle" });
  const other = await fixture();
  await other.commit({ from: "/same", to: "/same", directory: false });
  expect(await other.worker.processNext(vi.fn())).toMatchObject({
    state: "completed",
    identityId: other.identity.id,
  });
  await f.due();
  const publish = vi.fn();
  const outcomes = await Promise.all([
    f.worker.processNext(publish, f.identity.id),
    f.restarted.processNext(publish, f.identity.id),
  ]);
  expect(outcomes.some((r) => r.state === "completed" && r.operationId === firstJob.id)).toBe(true);
  await f.worker.processNext(publish, f.identity.id);
  expect(publish.mock.calls.map(([event]) => event.op)).toEqual(["create", "mkdir"]);
  expect(await f.worker.pending(f.identity.id)).toBe(false);
  expect((await f.desktop.operation(f.identity.id, f.account.id, nextJob.id))?.state).toBe(
    "completed",
  );
});

it("retires work after identity ownership changes", async () => {
  const f = await fixture();
  await f.seed("/old");
  await f.commit();
  const account = await f.repos.accounts.create({ displayName: "New owner" });
  await first.db.execute(
    sql`update app.identities set account_id = ${account.id} where id = ${f.identity.id}`,
  );
  const publish = vi.fn();
  expect(await f.worker.processNext(publish, f.identity.id)).toMatchObject({ state: "retired" });
  expect(publish).not.toHaveBeenCalled();
  expect((await f.repos.favorites.list(f.identity.id))[0]?.path).toBe("/old");
});

it("rejects oversized snapshots and ownership changes before receipt publication", async () => {
  const f = await fixture();
  const id = randomUUID();
  await f.desktop.reserve({
    id,
    identityId: f.identity.id,
    accountId: f.account.id,
    requestHash: id,
    request: {},
    state: "committing",
  });
  // Exercise the actual bounded snapshot path without retaining a huge job.
  await first.db.execute(
    sql`insert into app.favorites (identity_id,path,kind) select ${f.identity.id}, '/old/' || n, 'file' from generate_series(1,100001) n`,
  );
  await expect(
    f.desktop.captureEffects(f.identity.id, f.account.id, {
      from: "/old",
      to: "/new",
      directory: true,
      trash: false,
      office: null,
    }),
  ).rejects.toThrow("capacity");
  expect((await f.desktop.operation(f.identity.id, f.account.id, id))?.state).toBe("committing");
  expect(await f.worker.pending(f.identity.id)).toBe(false);
  await first.db.execute(sql`delete from app.favorites where identity_id = ${f.identity.id}`);
  await expect(
    f.desktop.captureEffects(f.identity.id, randomUUID(), {
      from: null,
      to: "/new",
      directory: false,
      trash: false,
      office: null,
    }),
  ).rejects.toThrow("ownership");
});

it("does not follow metadata moved away and back before recovery, including Office registrations", async () => {
  const f = await fixture();
  await f.seed("/old");
  const office = await f.office.ensure({
    providerId: f.provider.id,
    rootName: "root",
    path: "old",
  });
  await f.commit({
    office: { providerId: f.provider.id, rootName: "root", from: "old", to: "new" },
  });
  await f.repos.metadataPaths.movePrefix(f.identity.id, "/old", "/temporary", true);
  await f.repos.metadataPaths.movePrefix(f.identity.id, "/temporary", "/old", true);
  await f.office.movePrefix({
    providerId: f.provider.id,
    rootName: "root",
    from: "old",
    to: "temporary",
    at: new Date(),
  });
  await f.office.movePrefix({
    providerId: f.provider.id,
    rootName: "root",
    from: "temporary",
    to: "old",
    at: new Date(),
  });
  expect(await f.worker.processNext(vi.fn(), f.identity.id)).toMatchObject({ state: "completed" });
  expect((await f.repos.favorites.list(f.identity.id))[0]?.path).toBe("/old");
  expect(await f.repos.fileTags.pathsForTag(f.identity.id, f.tag.id)).toEqual(["/old"]);
  expect(await f.repos.folderViews.get(f.identity.id, "/old")).not.toBeNull();
  expect((await f.repos.recents.list(f.identity.id, 100))[0]?.path).toBe("/old");
  expect((await f.office.get(office.id))?.path).toBe("old");
});

it("rechecks destination revisions after waiting for an in-flight metadata edit", async () => {
  const f = await fixture();
  await f.seed("/old");
  await f.seed("/new");
  await f.commit();
  const editing = await second.pool.connect();
  let processing: ReturnType<typeof f.worker.processNext> | undefined;
  try {
    await editing.query("BEGIN");
    await editing.query(
      "SELECT path FROM app.favorites WHERE identity_id = $1 AND path = '/new' FOR UPDATE",
      [f.identity.id],
    );
    processing = f.worker.processNext(vi.fn(), f.identity.id);
    await vi.waitFor(async () => {
      const waiting = await first.pool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%order by item.path, item.revision for update%'",
      );
      expect(waiting.rows[0].count).toBeGreaterThan(0);
    });
    await editing.query(
      "UPDATE app.favorites SET kind = 'dir', revision = gen_random_uuid() WHERE identity_id = $1 AND path = '/new'",
      [f.identity.id],
    );
    await editing.query("COMMIT");
    expect(await processing).toMatchObject({ state: "failed" });
    expect((await f.repos.favorites.list(f.identity.id)).find((r) => r.path === "/new")?.kind).toBe(
      "dir",
    );
    expect(await f.repos.fileTags.pathsForTag(f.identity.id, f.tag.id)).toContain("/old");
    await f.repos.favorites.remove(f.identity.id, "/new");
    await f.due();
    await f.worker.processNext(vi.fn(), f.identity.id);
  } finally {
    await editing.query("ROLLBACK");
    editing.release();
    await processing;
  }
});

it("backs off a locked identity while another worker can finish another identity", async () => {
  const f = await fixture();
  const other = await fixture();
  await f.commit({ from: null });
  await other.commit({ from: null });
  const editing = await second.pool.connect();
  let processing: ReturnType<typeof f.worker.processNext> | undefined;
  try {
    await editing.query("BEGIN");
    await editing.query("SELECT id FROM app.identities WHERE id = $1 FOR UPDATE", [f.identity.id]);
    processing = f.worker.processNext(vi.fn(), f.identity.id);
    expect(await other.restarted.processNext(vi.fn(), other.identity.id)).toMatchObject({
      state: "completed",
    });
    expect(await processing).toMatchObject({ state: "failed" });
    expect(await f.worker.pending(f.identity.id)).toBe(true);
  } finally {
    await editing.query("ROLLBACK");
    editing.release();
    await processing;
  }
  await f.due();
  expect(await f.worker.processNext(vi.fn(), f.identity.id)).toMatchObject({ state: "completed" });
});

it.each(["move", "delete", "trash", "child", "ancestor", "replace"] as const)(
  "refuses recovery after a later virtual %s even when no target metadata existed",
  async (kind) => {
    const f = await fixture();
    await f.seed("/old/a");
    await f.commit({ to: "/target/new" });
    if (kind === "delete")
      await f.repos.metadataPaths.deletePrefix(f.identity.id, "/target/new", true);
    else if (kind === "trash")
      await f.repos.recents.deletePrefix(f.identity.id, "/target/new", true);
    else
      await f.repos.metadataPaths.movePrefix(
        f.identity.id,
        kind === "child"
          ? "/target/new/a"
          : kind === "ancestor"
            ? "/target"
            : kind === "replace"
              ? "/peer"
              : "/target/new",
        kind === "replace" ? "/target/new" : "/elsewhere",
        true,
      );
    expect(await f.worker.processNext(vi.fn(), f.identity.id)).toMatchObject({ state: "failed" });
    expect(
      (await f.worker.status()).find((job) => job.identityId === f.identity.id)?.lastError,
    ).toContain("superseded");
    expect((await f.repos.favorites.list(f.identity.id))[0]?.path).toBe("/old/a");
  },
);

it.each(["move", "delete", "root"] as const)(
  "refuses recovery after a physical Office %s before virtual hooks",
  async (kind) => {
    const f = await fixture();
    await f.seed("/old/a");
    const source = await f.office.ensure({
      providerId: f.provider.id,
      rootName: "root",
      path: "alice/old/a",
    });
    await f.commit({
      office: { providerId: f.provider.id, rootName: "root", from: "alice/old", to: "alice/new" },
    });
    if (kind === "move")
      await f.office.movePrefix({
        providerId: f.provider.id,
        rootName: "root",
        from: "alice/new/a",
        to: "alice/elsewhere",
        at: new Date(),
      });
    else
      await f.office.deletePrefix({
        providerId: f.provider.id,
        rootName: "root",
        path: kind === "root" ? "" : "alice/new",
        at: new Date(),
      });
    expect(await f.worker.processNext(vi.fn(), f.identity.id)).toMatchObject({ state: "failed" });
    expect((await f.repos.favorites.list(f.identity.id))[0]?.path).toBe("/old/a");
    if (kind !== "root") expect((await f.office.get(source.id))?.path).toBe("alice/old/a");
  },
);

it("allows exact indexer move replays and unrelated path changes before recovery", async () => {
  const f = await fixture();
  await f.seed("/old/a");
  const source = await f.office.ensure({
    providerId: f.provider.id,
    rootName: "root",
    path: "alice/old/a",
  });
  await f.commit({
    office: { providerId: f.provider.id, rootName: "root", from: "alice/old", to: "alice/new" },
  });
  await f.repos.metadataPaths.movePrefix(f.identity.id, "/new-extra", "/elsewhere", true);
  await f.repos.metadataPaths.movePrefix(f.identity.id, "/old", "/new", true);
  await f.office.movePrefix({
    providerId: f.provider.id,
    rootName: "root",
    from: "alice/old",
    to: "alice/new",
    at: new Date(),
  });
  expect(await f.worker.processNext(vi.fn(), f.identity.id)).toMatchObject({ state: "completed" });
  expect((await f.repos.favorites.list(f.identity.id))[0]?.path).toBe("/new/a");
  expect((await f.office.get(source.id))?.path).toBe("alice/new/a");
});

it("commits the prepublication snapshot without recapturing concurrent metadata growth", async () => {
  const f = await fixture();
  await f.seed("/old/a");
  const context = { from: "/old", to: "/new", directory: true, trash: false, office: null };
  const payload = await f.desktop.captureEffects(f.identity.id, f.account.id, context);
  await first.db.execute(
    sql`insert into app.favorites (identity_id,path,kind) select ${f.identity.id}, '/old/' || n, 'file' from generate_series(1,100001) n`,
  );
  const id = randomUUID();
  await f.desktop.reserve({
    id,
    identityId: f.identity.id,
    accountId: f.account.id,
    requestHash: id,
    request: {},
    state: "committing",
  });
  expect(
    await f.desktop.complete(f.identity.id, f.account.id, id, { state: "completed" }, payload),
  ).toBe(true);
  expect(await f.worker.processNext(vi.fn(), f.identity.id)).toMatchObject({ state: "completed" });
  const rows = await first.db.execute(
    sql`select count(*)::int as count from app.favorites where identity_id = ${f.identity.id} and starts_with(path, '/old/')`,
  );
  expect(rows.rows[0]?.count).toBe(100001);
  await first.db.execute(sql`delete from app.favorites where identity_id = ${f.identity.id}`);
});

it("rechecks invalidation after an in-flight physical hook without inverting Office/job locks", async () => {
  const f = await fixture();
  await f.seed("/old/a");
  await f.commit({
    office: { providerId: f.provider.id, rootName: "root", from: "alice/old", to: "alice/new" },
  });
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const hook = createOfficeWriteScope(second.db)(f.provider.id, async ({ files }) => {
    await files.movePrefix({
      providerId: f.provider.id,
      rootName: "root",
      from: "alice/new",
      to: "alice/later",
      at: new Date(),
    });
    ready();
    await held;
  });
  let processing: ReturnType<typeof f.worker.processNext> | undefined;
  try {
    await started;
    processing = f.worker.processNext(vi.fn(), f.identity.id);
    await vi.waitFor(async () => {
      const waiting = await first.pool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'",
      );
      expect(waiting.rows[0].count).toBeGreaterThan(0);
    });
    release();
    await hook;
    expect(await processing).toMatchObject({ state: "failed" });
    expect(
      (await f.worker.status()).find((job) => job.identityId === f.identity.id)?.lastError,
    ).toContain("superseded");
    expect((await f.repos.favorites.list(f.identity.id))[0]?.path).toBe("/old/a");
  } finally {
    release();
    await hook;
    await processing;
  }
});
