import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  createDesktopEffectsRepo,
  createDesktopRepo,
  createOfficeFileRepo,
  createRepos,
  migrate,
} from "@fdrive/db";
import { createMemoryStorage, startPostgres } from "@fdrive/testkit";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Principal } from "../../src/auth/principal.js";
import { createDesktopEffectContext } from "../../src/desktop/effects.js";
import { withDesktopMetadata } from "../../src/desktop/metadata.js";
import { createDesktopWrites } from "../../src/desktop/writes.js";
import { createMetadataService } from "../../src/metadata/service.js";
import { withOfficeMetadata } from "../../src/office/registry-events.js";
import type { ConfiguredMappingsResult } from "../../src/scoping/types.js";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let database: ReturnType<typeof createDb>;
let reader: ReturnType<typeof createDb>;
const temporary: string[] = [];
beforeAll(async () => {
  postgres = await startPostgres();
  database = createDb(postgres.connectionString);
  reader = createDb(postgres.connectionString);
  await migrate(database.db);
});
afterAll(async () => {
  await database?.close();
  await reader?.close();
  await postgres?.stop();
  await Promise.all(temporary.map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const repos = createRepos(database.db);
  const account = await repos.accounts.create({ displayName: "Recovery regression" });
  const provider = await repos.providers.ensure({
    type: "webdav",
    baseUrl: `http://${randomUUID()}.test`,
  });
  const identity = await repos.identities.create({
    accountId: account.id,
    providerId: provider.id,
    externalUsername: "alice",
  });
  const repo = createDesktopRepo(database.db);
  const queue = createDesktopEffectsRepo(database.db);
  const raw = createMemoryStorage({
    "/a.txt": "original",
    "/peer.txt": "peer",
    "/folder/file.txt": "folder bytes",
  });
  const storage = {
    ...raw,
    withWriteLease: async <T>(action: (value: typeof raw) => Promise<T>) => action(raw),
  };
  const principal: Principal = {
    accountId: account.id,
    identityId: identity.id,
    isAdmin: false,
    username: "alice",
    storage,
    tokenAccess: { mode: "full", paths: ["/"] },
  };
  const stateDir = await mkdtemp(join(tmpdir(), "desktop-recovery-"));
  temporary.push(stateDir);
  const mapping = async (): Promise<ConfiguredMappingsResult> => ({
    available: true,
    providerId: provider.id,
    homeTemplateRaw: "root:/alice",
    scopes: [{ rootName: "root", virtualPrefix: "/", fsPrefix: "/alice" }],
  });
  // Leaving the worker stopped models restart/outage after a durable receipt.
  const writes = createDesktopWrites({
    repo,
    stateDir,
    clock: () => new Date(),
    trashPathForStorage: () => null,
    effectContext: createDesktopEffectContext(repos.identities, mapping),
  });
  const office = createOfficeFileRepo(database.db);
  const webMetadata = withOfficeMetadata(
    withDesktopMetadata(createMetadataService(repos), repo),
    office,
    repos.identities,
    mapping,
    () => new Date(),
  );
  const prepareMove = async (from: string, name: string) => {
    const item = await writes.stat(principal, from);
    const operationId = randomUUID();
    await writes.prepare(principal, {
      kind: "move",
      operationId,
      itemId: item.id,
      parentId: "root",
      name,
      base: item.version,
    });
    return { item, operationId };
  };
  return {
    repos,
    account,
    provider,
    identity,
    repo,
    queue,
    raw,
    principal,
    writes,
    office,
    webMetadata,
    prepareMove,
  };
}

it("preserves metadata when a later web move supersedes a queued target and a peer reuses it", async () => {
  const f = await fixture();
  await f.repos.favorites.add(f.identity.id, "/a.txt", "file");
  const office = await f.office.ensure({
    providerId: f.provider.id,
    rootName: "root",
    path: "alice/a.txt",
  });
  const native = await f.prepareMove("/a.txt", "b.txt");
  expect((await f.writes.commit(f.principal, native.operationId)).state).toBe("completed");
  await f.raw.move("/b.txt", "/c.txt", { overwrite: false });
  await f.webMetadata.onMoved(f.identity.id, "/b.txt", "/c.txt", false);
  await f.raw.copy("/peer.txt", "/b.txt", { overwrite: false });
  await f.repo.ensure(f.identity.id, "/b.txt", "file");
  expect(await f.queue.processNext(() => {}, f.identity.id)).toMatchObject({ state: "failed" });
  expect(
    (await f.queue.status()).find((job) => job.operationId === native.operationId)?.lastError,
  ).toContain("superseded");
  const favorite = (await f.repos.favorites.list(f.identity.id))[0]?.path;
  const officePath = (await f.office.get(office.id))?.path;
  const actualPath = (await f.repo.item(f.identity.id, native.item.id))?.path;
  const wrongBytes = await new Response((await f.raw.download("/b.txt")).body).text();
  expect(actualPath).toBe("/c.txt");
  expect(favorite).toBe("/a.txt");
  expect(officePath).toBe("alice/a.txt");
  expect(wrongBytes).toBe("peer");
});

it("rejects metadata capacity before filesystem publication and leaves the operation retryable", async () => {
  const f = await fixture();
  await database.pool.query(
    "INSERT INTO app.favorites (identity_id,path,kind) SELECT $1, '/folder/' || n, 'file' FROM generate_series(1,100001) n",
    [f.identity.id],
  );
  const native = await f.prepareMove("/folder", "moved-folder");
  await expect(f.writes.commit(f.principal, native.operationId)).rejects.toMatchObject({
    kind: "rate_limited",
    details: { code: "quota_exceeded" },
  });
  const status = await f.writes.status(f.principal, native.operationId);
  const paths = (await f.raw.list("/")).map((entry) => entry.path);
  expect(paths).not.toContain("/moved-folder");
  expect(paths).toContain("/folder");
  expect(status.state).toBe("ready");
  expect(await f.queue.pending(f.identity.id)).toBe(false);
});

it("publishes only after metadata commits so notification-triggered reads see the new paths", async () => {
  const f = await fixture();
  await f.repos.favorites.add(f.identity.id, "/a.txt", "file");
  const native = await f.prepareMove("/a.txt", "b.txt");
  await f.writes.commit(f.principal, native.operationId);
  await database.pool.query(
    "CREATE FUNCTION app.recovery_delay_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state = 'completed' THEN PERFORM pg_sleep(0.3); END IF; RETURN NEW; END $$",
  );
  await database.pool.query(
    "CREATE TRIGGER recovery_delay_completion BEFORE UPDATE ON app.desktop_effects FOR EACH ROW EXECUTE FUNCTION app.recovery_delay_completion()",
  );
  try {
    const observed: Array<Promise<unknown>> = [];
    await f.queue.processNext(() => {
      observed.push(createRepos(reader.db).favorites.list(f.identity.id));
    }, f.identity.id);
    const onEvent = await Promise.all(observed);
    const afterCommit = await f.repos.favorites.list(f.identity.id);
    expect(onEvent).toMatchObject([[{ path: "/b.txt" }]]);
    expect(afterCommit).toMatchObject([{ path: "/b.txt" }]);
    expect(observed).toHaveLength(1);
    expect(await f.queue.pending(f.identity.id)).toBe(false);
  } finally {
    await database.pool.query("DROP TRIGGER recovery_delay_completion ON app.desktop_effects");
    await database.pool.query("DROP FUNCTION app.recovery_delay_completion()");
  }
});
