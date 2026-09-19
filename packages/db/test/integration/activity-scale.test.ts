import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createActivityRepo, createDb, createRepos, migrate } from "../../src/index.js";

// Budget fixed before qualification: warm p95 < 1s/query on local PG17, one million
// events across two owners; 50-row feed, journey and rare old-name lookup.
// Regression ceiling only: this is not a production latency/hardware guarantee.
it("keeps million-event personal feeds, journeys and historical-name searches indexed", {
  timeout: 240_000,
}, async () => {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  const connection = createDb(container.getConnectionUri());
  try {
    await migrate(connection.db);
    const repos = createRepos(connection.db);
    const alice = await repos.accounts.create({ displayName: "Scale A" });
    const bob = await repos.accounts.create({ displayName: "Scale B" });
    const provider = await repos.providers.ensure({ type: "sftpgo", baseUrl: "http://scale.test" });
    const identities = [
      await repos.identities.create({
        accountId: alice.id,
        providerId: provider.id,
        externalUsername: "a",
      }),
      await repos.identities.create({
        accountId: bob.id,
        providerId: provider.id,
        externalUsername: "b",
      }),
    ];
    const db = connection.db;
    for (const identity of identities)
      await db.execute(
        sql`insert into app.activity_storage_identities (identity_id, provider_id, provider_type, label) values (${identity.id}, ${provider.id}, 'sftpgo', 'Scale')`,
      );
    await db.execute(sql`insert into app.activity_files (id,identity_id,kind,virtual_path)
      select md5('scale-file-' || n)::uuid, case when n % 2 = 0 then ${identities[0]?.id}::uuid else ${identities[1]?.id}::uuid end, 'file', '/current/' || n || '.txt' from generate_series(0,9999) n`);
    await db.execute(sql`insert into app.activity_events (id,owner_account_id,owner_sequence,actor_account_id,identity_id,file_id,class,action,stage,outcome,source,evidence,occurred_at,recorded_at,sort_at,idempotency_key)
      select md5('scale-event-' || n)::uuid,
        case when n % 2 = 0 then ${alice.id}::uuid else ${bob.id}::uuid end, floor(n / 2)+1,
        case when n % 2 = 0 then ${alice.id}::uuid else ${bob.id}::uuid end,
        case when n % 2 = 0 then ${identities[0]?.id}::uuid else ${identities[1]?.id}::uuid end,
        md5('scale-file-' || (n % 10000))::uuid,'action','file.save','outcome','success','web','server_confirmed',
        timestamp '2026-09-14' - n * interval '1 millisecond', timestamp '2026-09-14', timestamp '2026-09-14' - n * interval '1 millisecond','scale-' || n
      from generate_series(0,999999) n`);
    await db.execute(sql`insert into app.activity_event_subjects (owner_account_id,event_id,identity_id,file_id,role,subject_ordinal,virtual_path_snapshot)
      select owner_account_id,id,identity_id,file_id,'primary',0,case when id = md5('scale-event-990000')::uuid then '/past/rare-target-report.txt' else '/past/' || id || '.txt' end from app.activity_events`);
    await db.execute(sql`analyze app.activity_events`);
    await db.execute(sql`analyze app.activity_event_subjects`);
    const repo = createActivityRepo(db);
    const target = (await db.execute(sql`select md5('scale-file-0')::uuid as id`)).rows[0]
      ?.id as string;
    const queries = { feed: {}, journey: { fileId: target }, oldName: { q: "rare-target-report" } };
    const timings: Record<string, number> = {};
    for (const [label, filters] of Object.entries(queries)) {
      await repo.list(alice.id, { ...filters, limit: 50 });
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        const rows = await repo.list(alice.id, { ...filters, limit: 50 });
        samples.push(performance.now() - start);
        expect(rows.length).toBe(label === "oldName" ? 1 : 50);
        expect(rows.every((row) => row.ownerAccountId === alice.id)).toBe(true);
      }
      timings[label] = Math.max(...samples);
      expect(timings[label]).toBeLessThan(1000);
    }
    expect(await repo.list(bob.id, { fileId: target })).toEqual([]);
    expect(await repo.list(randomUUID(), {})).toEqual([]);
    const feedPlan = await db.execute(
      sql`explain (format json) select id from app.activity_events where owner_account_id = ${alice.id} order by sort_at desc nulls last,id desc nulls last limit 50`,
    );
    const searchPlan = await db.execute(
      sql`explain (format json) select event_id from app.activity_event_subjects where virtual_path_snapshot ilike '%rare-target-report%'`,
    );
    expect(JSON.stringify(feedPlan.rows)).toContain("activity_events_feed");
    expect(JSON.stringify(searchPlan.rows)).toContain("activity_subjects_path_search");
    console.info(
      "Activity scale qualification",
      JSON.stringify({ events: 1000000, owners: 2, warmMaxMs: timings, budgetMs: 1000 }),
    );
  } finally {
    await connection.close();
    await container.stop();
  }
});
