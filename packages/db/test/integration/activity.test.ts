import { randomUUID } from "node:crypto";
import type { ActivityFacts, PersonalActivityAction } from "@fdrive/contracts";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  createActivityExportsRepo,
  createActivityObservationsRepo,
  createActivityReadsRepo,
  createActivityRepo,
  createDb,
  createDesktopRepo,
  createRepos,
  migrate,
} from "../../src/index.js";
import { appendActivityOutcome } from "../../src/repos/activity.js";
import {
  activityMetadataUnchanged,
  captureActivityMetadata,
} from "../../src/repos/activity-metadata.js";
import { finishNativeFailure } from "../../src/repos/activity-native.js";
import { requireActivityRow } from "../../src/repos/activity-types.js";
import { appendActivityEvent } from "../../src/repos/activity-writer.js";

it("keeps personal journeys stable, immutable and private across pools and identity transfer", {
  timeout: 180_000,
}, async () => {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  const first = createDb(container.getConnectionUri()),
    second = createDb(container.getConnectionUri());
  try {
    await migrate(first.db);
    const repos = createRepos(first.db);
    const alice = await repos.accounts.create({ displayName: "Alice" });
    const bob = await repos.accounts.create({ displayName: "Bob" });
    const provider = await repos.providers.ensure({
      type: "sftpgo",
      baseUrl: "http://activity.test",
    });
    const identity = await repos.identities.create({
      accountId: alice.id,
      providerId: provider.id,
      externalUsername: "alice",
    });
    const otherIdentity = await repos.identities.create({
      accountId: bob.id,
      providerId: provider.id,
      externalUsername: "bob",
    });
    let at = new Date("2026-09-14T10:00:00.000Z");
    const a = createActivityRepo(first.db, () => at),
      b = createActivityRepo(second.db, () => at);
    const actor = { accountId: alice.id, identityId: identity.id };
    const batchId = randomUUID();
    async function run(
      action: PersonalActivityAction,
      requested: ActivityFacts,
      after = requested,
      before?: ActivityFacts,
    ) {
      at = new Date(at.getTime() + 1000);
      const input = {
        ...actor,
        action,
        source: "web" as const,
        producerOperationId: randomUUID(),
        requested,
        requestDigest: JSON.stringify(requested),
        batchId,
        ...(before ? { before } : {}),
      };
      const operation = await a.begin(input);
      expect(await b.begin(input)).toEqual(operation);
      await expect(b.begin({ ...input, requestDigest: "different" })).rejects.toThrow(
        "different input",
      );
      expect(await a.claim(alice.id, operation.id)).toBe(true);
      expect(await b.claim(alice.id, operation.id)).toBe(false);
      const event = await a.finish(alice.id, operation.id, { outcome: "success", after });
      expect(await b.finish(alice.id, operation.id, { outcome: "success", after })).toEqual(event);
      expect(
        await first.db.transaction((db) =>
          appendActivityOutcome(db, operation, { outcome: "success", after }, at),
        ),
      ).toEqual(event);
      return event;
    }
    // The shared row guard states the failure instead of surfacing a later undefined access.
    expect(requireActivityRow({ id: "row" }, "unused")).toEqual({ id: "row" });
    expect(() => requireActivityRow(undefined, "Activity row missing")).toThrow(
      "Activity row missing",
    );
    expect(() => requireActivityRow(null, "Activity row missing")).toThrow("Activity row missing");
    const uploaded = await run(
      "file.upload",
      { path: "/a_%.txt", kind: "file" },
      { path: "/a_%.txt", kind: "file", size: 4, sha256: "a".repeat(64) },
    );
    expect(uploaded.actorAccountId).toBe(alice.id);
    expect(uploaded.fileId).toBeTruthy();
    const renamed = await run(
      "file.rename",
      { path: "/a_%.txt", targetPath: "/b.txt" },
      { path: "/b.txt", kind: "file" },
      { path: "/a_%.txt", kind: "file" },
    );
    expect(renamed.fileId).toBe(uploaded.fileId);
    const saved = await run(
      "file.save",
      { path: "/b.txt" },
      { path: "/b.txt", kind: "file", size: 5, version: "v2" },
      { path: "/b.txt", kind: "file", size: 4 },
    );
    expect(saved.fileId).toBe(uploaded.fileId);
    expect(await b.revisions(alice.id, saved.fileId as string)).toHaveLength(2);
    const copied = await run(
      "file.copy",
      { path: "/b.txt", targetPath: "/c.txt" },
      { path: "/c.txt", size: 5 },
      { path: "/b.txt", kind: "file" },
    );
    expect(copied.fileId).not.toBe(saved.fileId);
    expect((await b.lineage(alice.id, saved.fileId as string))[0]?.targetFileId).toBe(
      copied.fileId,
    );
    expect(await b.lineage(bob.id, saved.fileId as string)).toEqual([]);
    expect(await b.event(bob.id, uploaded.id)).toBeNull();
    expect(await b.file(bob.id, uploaded.fileId as string)).toBeNull();
    expect(await b.subjects(bob.id, [uploaded.id])).toEqual([]);
    expect(await b.subjects(alice.id, [])).toEqual([]);
    expect((await b.file(alice.id, uploaded.fileId as string))?.file.path).toBe("/b.txt");
    expect((await b.list(alice.id, { q: "a_%" })).some((row) => row.id === uploaded.id)).toBe(true);
    expect(await b.list(alice.id, { q: "a_X" })).toEqual([]);
    expect(await b.list(alice.id, { identityId: otherIdentity.id })).toEqual([]);
    const page = await b.list(alice.id, {
      limit: 2,
      outcome: "success",
      action: "file.save",
      source: "web",
      from: new Date("2026-09-14"),
      to: at,
      batchId,
    });
    expect(page.map((row) => row.id)).toEqual([saved.id]);
    const last = (await b.list(alice.id, { limit: 2 }))[1];
    expect(last).toBeTruthy();
    expect(
      (
        await b.list(alice.id, { after: { at: last?.sortAt as Date, id: last?.id as string } })
      ).every((row) => row.sortAt <= (last?.sortAt as Date)),
    ).toBe(true);
    expect(
      (await b.list(alice.id, { fileId: copied.fileId as string })).some(
        (row) => row.id === copied.id,
      ),
    ).toBe(true);
    const trash = await run(
      "file.trash",
      { path: "/b.txt", kind: "file" },
      {
        path: "/b.txt",
        trashLeaf: "/.trash/b.txt/1234567890000000000",
        trashStrategy: "sftpgo_rule",
      },
    );
    expect(trash.fileId).toBe(saved.fileId);
    const restored = await run(
      "file.restore",
      {
        path: "/b.txt",
        trashLeaf: "/.trash/b.txt/1234567890000000000",
        targetPath: "/restored.txt",
      },
      { path: "/restored.txt", kind: "file" },
    );
    expect(restored.fileId).toBe(saved.fileId);
    await run("file.delete", { path: "/restored.txt", kind: "file" });
    const replaced = await run("file.upload", { path: "/restored.txt", kind: "file" });
    expect(replaced.fileId).not.toBe(saved.fileId);
    await run("folder.create", { path: "/folder_%", kind: "dir" });
    const child = await run("file.create", { path: "/folder_%/child.txt", kind: "file" });
    await run(
      "file.move",
      { path: "/folder_%", targetPath: "/moved" },
      { path: "/moved", kind: "dir" },
      { path: "/folder_%", kind: "dir" },
    );
    expect((await b.file(alice.id, child.fileId as string))?.file.path).toBe("/moved/child.txt");
    const denied = await a.begin({
      ...actor,
      action: "file.delete",
      source: "api",
      producerOperationId: randomUUID(),
      requestDigest: "denied",
      requested: { path: "/private/submitted.txt" },
    });
    const failure = await a.finish(alice.id, denied.id, {
      outcome: "denied",
      errorCode: "permission_denied",
    });
    expect(failure.fileId).toBeNull();
    expect((await a.subjects(alice.id, [failure.id]))[0]?.path).toBe("/private/submitted.txt");
    await expect(a.finish(bob.id, denied.id, { outcome: "success" })).rejects.toThrow("not found");
    const unfinished = await a.begin({
      ...actor,
      action: "file.save",
      source: "api",
      producerOperationId: randomUUID(),
      requestDigest: "pending",
      requested: { path: "/pending" },
    });
    expect((await a.pending(new Date(at.getTime() + 1000))).map((row) => row.id)).toContain(
      unfinished.id,
    );
    await a.finish(alice.id, unfinished.id, { outcome: "unknown" });
    const sequence = await b.stream(alice.id, 0);
    expect(sequence.map((row) => row.sequence)).toEqual(
      Array.from({ length: sequence.length }, (_, index) => index + 1),
    );
    expect(await b.stream(bob.id, 0)).toEqual([]);
    expect(await b.boundary(bob.id)).toBeNull();
    expect(await b.list(alice.id, { snapshotSequence: 1 })).toHaveLength(1);
    const reads = createActivityReadsRepo(first.db, () => at);
    const requests = Array.from({ length: 1000 }, () => randomUUID());
    for (const requestId of requests) {
      await reads.record({
        ...actor,
        path: "/c.txt",
        kind: "file",
        action: "file.open",
        source: "web",
        evidence: "client_reported",
        contextHash: "session-one",
        requestId,
        at,
        outcome: "unknown",
      });
    }
    for (const requestId of requests) {
      await reads.record({
        ...actor,
        path: "/c.txt",
        kind: "file",
        action: "file.open",
        source: "web",
        evidence: "client_reported",
        contextHash: "session-one",
        requestId,
        at,
        outcome: "unknown",
      });
    }
    expect((await reads.provisional(alice.id))[0]?.count).toBe(1000);
    expect(await reads.provisional(bob.id)).toEqual([]);
    await run("file.save", { path: "/c.txt" }, { path: "/c.txt", size: 6 });
    await reads.record({
      ...actor,
      path: "/c.txt",
      kind: "file",
      action: "file.open",
      source: "web",
      evidence: "client_reported",
      contextHash: "session-one",
      requestId: randomUUID(),
      at,
      outcome: "unknown",
    });
    expect(await reads.provisional(alice.id, identity.id)).toHaveLength(2);
    expect((await reads.recents(alice.id, identity.id))[0]?.path).toBe("/c.txt");
    at = new Date(at.getTime() + 420_000);
    expect(await reads.seal()).toBe(2);
    expect(await reads.seal()).toBe(0);
    expect(await reads.provisional(alice.id)).toEqual([]);
    expect(
      (await b.list(alice.id, { action: "file.open" }))
        .map((event) => event.count)
        .sort((a, b) => a - b),
    ).toEqual([1, 1000]);
    await expect(
      reads.record({
        ...actor,
        path: "/c.txt",
        kind: "file",
        action: "file.open",
        source: "web",
        evidence: "client_reported",
        contextHash: "expired",
        requestId: randomUUID(),
        at: new Date(0),
        outcome: "unknown",
      }),
    ).rejects.toThrow("expired");
    await expect(
      reads.record({
        ...actor,
        path: "/",
        kind: "dir",
        action: "folder.create",
        source: "web",
        evidence: "client_reported",
        contextHash: "folder",
        requestId: randomUUID(),
        at,
        outcome: "unknown",
      }),
    ).rejects.toThrow("Not an aggregate");
    const observations = createActivityObservationsRepo(first.db, () => at);
    const unseen = {
      ...actor,
      path: "/never-seen",
      kind: "missing" as const,
      source: "refresh" as const,
      evidence: "refresh_comparison" as const,
    };
    expect(await observations.observe(unseen)).toBeNull();
    const observedFile = await run(
      "file.create",
      { path: "/observe.txt", kind: "file" },
      { path: "/observe.txt", size: 1, modifiedAt: at.toISOString() },
    );
    const missing = await observations.observe({ ...unseen, path: "/observe.txt" });
    expect(missing).toMatchObject({
      actorAccountId: null,
      class: "observation",
      action: "observation.location_missing",
      occurredAt: null,
    });
    expect(
      await createActivityObservationsRepo(second.db, () => at).observe({
        ...unseen,
        path: "/observe.txt",
      }),
    ).toBeNull();
    expect(await b.event(bob.id, missing?.id as string)).toBeNull();
    const recovered = await observations.observe({
      ...actor,
      path: "/observe.txt",
      kind: "present",
      source: "refresh",
      evidence: "refresh_comparison",
      after: { path: "/observe.txt", size: 1, modifiedAt: at.toISOString() },
    });
    expect(recovered?.parentEventId).toBe(missing?.id);
    expect(recovered?.action).toBe("observation.resolved");
    const rediscovered = (await a.subjectPage(alice.id, recovered?.id as string)).find(
      (subject) => subject.role === "target",
    );
    expect(rediscovered?.fileId).toBeTruthy();
    expect(rediscovered?.fileId).not.toBe(observedFile.fileId);
    expect((await a.file(alice.id, observedFile.fileId as string))?.file.state).toBe("unknown");
    expect(
      await observations.observe({
        ...actor,
        path: "/observe.txt",
        kind: "present",
        source: "refresh",
        evidence: "refresh_comparison",
        after: { path: "/observe.txt", size: 1, modifiedAt: at.toISOString() },
      }),
    ).toBeNull();
    const changed = await observations.observe({
      ...actor,
      path: "/observe.txt",
      kind: "present",
      source: "indexer",
      evidence: "watcher_change",
      after: { path: "/observe.txt", size: 2, modifiedAt: at.toISOString() },
    });
    expect(changed?.action).toBe("observation.content_changed");
    const externalMove = await observations.observe({
      ...actor,
      path: "/observe.txt",
      kind: "moved",
      source: "indexer",
      evidence: "watcher_move",
      after: { path: "/external.txt", size: 2, modifiedAt: at.toISOString() },
    });
    expect(externalMove?.fileId).toBe(rediscovered?.fileId);
    expect((await a.file(alice.id, rediscovered?.fileId as string))?.file.path).toBe(
      "/external.txt",
    );
    expect(
      (await observations.children(alice.id, identity.id, "/")).some(
        (file) => file.id === rediscovered?.fileId,
      ),
    ).toBe(true);
    expect(await observations.children(bob.id, identity.id, "/")).toEqual([]);
    await observations.observe({
      ...actor,
      path: "/external.txt",
      kind: "left_scope",
      source: "indexer",
      evidence: "watcher_move",
    });
    const uncertainty = await observations.observe({
      ...actor,
      path: "/external.txt",
      kind: "continuity_unknown",
      source: "indexer",
      evidence: "sha256_relink",
    });
    expect(uncertainty?.actorAccountId).toBeNull();
    const deferred = await a.begin({
      ...actor,
      action: "file.save",
      source: "api",
      producerOperationId: randomUUID(),
      requestDigest: "deferred",
      requested: { path: "/c.txt" },
      before: { path: "/c.txt", kind: "file" },
    });
    await a.claim(alice.id, deferred.id);
    expect(await observations.observe({ ...unseen, path: "/c.txt" })).toBeNull();
    expect(
      await a.recoverAbandoned(
        alice.id,
        deferred.id,
        { outcome: "unknown" },
        new Date(at.getTime() - 1),
      ),
    ).toBeNull();
    await a.heartbeat(alice.id, deferred.id);
    const unknown = await a.finish(alice.id, deferred.id, { outcome: "unknown" });
    await run("file.save", { path: "/c.txt" }, { path: "/c.txt", version: "newer" });
    const latestRevision = (await a.file(alice.id, copied.fileId as string))?.file.revisionId;
    const repaired = await a.finish(alice.id, deferred.id, {
      outcome: "success",
      after: { path: "/c.txt", version: "old-result" },
    });
    expect(repaired.parentEventId).toBe(unknown.id);
    expect((await a.file(alice.id, copied.fileId as string))?.file.revisionId).toBe(latestRevision);
    const outstandingRead = {
      ...actor,
      path: "/read-only",
      kind: "file" as const,
      action: "file.preview" as const,
      source: "web" as const,
      evidence: "client_reported" as const,
      contextHash: "read-context",
      requestId: randomUUID(),
      at,
      outcome: "unknown" as const,
    };
    const readId = await reads.record(outstandingRead);
    const provisional = (await reads.provisional(alice.id)).find((window) => window.id === readId);
    expect((await b.file(alice.id, provisional?.fileId as string))?.lastSubject.path).toBe(
      "/read-only",
    );
    await expect(reads.record({ ...outstandingRead, path: "/different" })).rejects.toThrow(
      "reused",
    );
    await reads.record({ ...outstandingRead, evidence: "server_confirmed", outcome: "success" });
    expect((await reads.provisional(alice.id))[0]?.outcomeCounts).toMatchObject({
      success: 1,
      unknown: 0,
    });
    const lateRead = { ...outstandingRead, requestId: randomUUID() };
    const lateWindow = await reads.record(lateRead);
    at = new Date(at.getTime() + 420_000);
    await reads.seal();
    await reads.record({ ...lateRead, at, evidence: "server_confirmed", outcome: "failed" });
    expect(
      (await b.list(alice.id, { action: "file.preview" })).some(
        (event) => event.stage === "reconciliation" && event.parentEventId === lateWindow,
      ),
    ).toBe(true);
    const childBeforeCopy = (await a.file(alice.id, child.fileId as string))?.file;
    await run(
      "file.copy",
      { path: "/moved", targetPath: "/copied-folder" },
      { path: "/copied-folder", kind: "dir" },
      { path: "/moved", kind: "dir" },
    );
    const childEdges = await a.lineage(alice.id, child.fileId as string);
    expect(childEdges).toHaveLength(1);
    expect((await a.file(alice.id, childEdges[0]?.targetFileId as string))?.file.path).toBe(
      "/copied-folder/child.txt",
    );
    expect(childEdges[0]?.targetFileId).not.toBe(childBeforeCopy?.id);
    const copySubjects = await a.subjectPage(alice.id, childEdges[0]?.eventId as string);
    expect(copySubjects.map((subject) => subject.ordinal)).toEqual(
      copySubjects.map((_, index) => index),
    );
    // Restoring a trashed folder by its leaf carries the tracked descendants to the new path,
    // so a child keeps one journey across the folder's trip through the trash.
    const folderLeaf = "/.trash/moved/1234567890000000002";
    const folderTrash = await run(
      "file.trash",
      { path: "/moved", kind: "dir" },
      { path: "/moved", trashLeaf: folderLeaf, trashStrategy: "sftpgo_rule" },
    );
    const folderRestored = await run(
      "file.restore",
      { path: "/moved", trashLeaf: folderLeaf, targetPath: "/restored-folder" },
      { path: "/restored-folder", kind: "dir" },
    );
    expect(folderRestored.fileId).toBe(folderTrash.fileId);
    expect((await b.file(alice.id, child.fileId as string))?.file.path).toBe(
      "/restored-folder/child.txt",
    );
    const native = createDesktopRepo(first.db);
    const nativeId = randomUUID();
    await native.reserve({
      id: nativeId,
      identityId: identity.id,
      accountId: alice.id,
      requestHash: "native-write",
      state: "ready",
      request: {
        kind: "upload",
        name: "native.txt",
        activityAction: "file.create",
        activityPath: "/native.txt",
        activityTarget: "/native.txt",
        activityKind: "file",
        sha256: "c".repeat(64),
      },
    });
    await native.transition(identity.id, alice.id, nativeId, "ready", "committing");
    const nativeItem = randomUUID();
    expect(
      await native.complete(
        identity.id,
        alice.id,
        nativeId,
        { item: { id: nativeItem, size: 3 } },
        {
          from: null,
          to: "/native.txt",
          directory: false,
          trash: false,
          office: null,
          snapshots: [],
        },
      ),
    ).toBe(true);
    expect(
      await native.complete(
        identity.id,
        alice.id,
        nativeId,
        { item: { id: nativeItem, size: 3 } },
        {
          from: null,
          to: "/native.txt",
          directory: false,
          trash: false,
          office: null,
          snapshots: [],
        },
      ),
    ).toBe(false);
    const nativeEvents = await a.list(alice.id, { source: "native" });
    expect(nativeEvents.filter((event) => event.stage === "outcome")).toHaveLength(1);
    await first.db.execute(sql`delete from app.desktop_operations where id = ${nativeId}`);
    expect((await a.list(alice.id, { source: "native" })).map((event) => event.id)).toEqual(
      nativeEvents.map((event) => event.id),
    );
    for (const state of ["failed", "conflict", "cancelled", "uncertain"]) {
      const id = randomUUID();
      await native.reserve({
        id,
        identityId: identity.id,
        accountId: alice.id,
        requestHash: state,
        state: "ready",
        request: {
          kind: "folder",
          activityAction: "folder.create",
          activityPath: `/${state}`,
          activityTarget: `/${state}`,
          activityKind: "dir",
        },
      });
      expect(await native.transition(identity.id, alice.id, id, "ready", state)).toBe(true);
      const receipt = await native.operation(identity.id, alice.id, id);
      if (!receipt) throw Error("missing native receipt");
      await first.db.transaction((db) => finishNativeFailure(db, receipt));
      expect(
        (await a.list(alice.id, { source: "native" })).some(
          (event) => event.operationId === id && event.stage === "outcome",
        ),
      ).toBe(true);
    }
    async function nativeCommit(
      kind: string,
      action: PersonalActivityAction | undefined,
      from: string | null,
      to: string,
      itemId?: string,
      trash = false,
      restored = false,
      directory = false,
    ) {
      const id = randomUUID();
      await native.reserve({
        id,
        ...actor,
        requestHash: id,
        state: "ready",
        request: {
          kind,
          ...(itemId ? { itemId } : {}),
          ...(action
            ? {
                activityAction: action,
                activityPath: from ?? to,
                activityTarget: to,
                activityKind: directory ? "dir" : "file",
              }
            : {}),
        },
      });
      await native.transition(identity.id, alice.id, id, "ready", "committing");
      expect(
        await native.complete(
          identity.id,
          alice.id,
          id,
          { item: itemId ? { id: itemId } : null },
          { from, to, directory, trash, restored, office: null, snapshots: [] },
        ),
      ).toBe(true);
      return (await a.list(alice.id, { source: "native" })).find(
        (event) => event.operationId === id && event.stage === "outcome",
      );
    }
    const nativeOriginal = nativeEvents.find((event) => event.stage === "outcome");
    expect(
      (await nativeCommit("upload", "file.save", "/native.txt", "/native.txt", nativeItem))?.fileId,
    ).toBe(nativeOriginal?.fileId);
    expect(
      (await nativeCommit("move", "file.rename", "/native.txt", "/native-renamed.txt", nativeItem))
        ?.fileId,
    ).toBe(nativeOriginal?.fileId);
    const trashLeaf = "/.trash/native-renamed.txt/1234567890000000000";
    expect(
      (await nativeCommit("move", "file.trash", "/native-renamed.txt", trashLeaf, nativeItem, true))
        ?.fileId,
    ).toBe(nativeOriginal?.fileId);
    const restoredNative = await nativeCommit(
      "move",
      "file.restore",
      trashLeaf,
      "/native-restored.txt",
      nativeItem,
      false,
      true,
    );
    expect(restoredNative?.fileId).toBe(nativeOriginal?.fileId);
    expect((await a.file(alice.id, restoredNative?.fileId as string))?.file.path).toBe(
      "/native-restored.txt",
    );
    // A native client can move a file out of the trash without setting `restored` and without
    // naming an action. The prior trashed state is then what proves this is a restore.
    const secondLeaf = "/.trash/native-restored.txt/1234567890000000001";
    await nativeCommit("move", "file.trash", "/native-restored.txt", secondLeaf, nativeItem, true);
    const implicitRestore = await nativeCommit(
      "move",
      undefined,
      secondLeaf,
      "/native-implicit-restore.txt",
      nativeItem,
    );
    expect(implicitRestore?.action).toBe("file.restore");
    expect(implicitRestore?.fileId).toBe(nativeOriginal?.fileId);
    expect(
      (
        await nativeCommit(
          "folder",
          "folder.create",
          null,
          "/native-folder",
          undefined,
          false,
          false,
          true,
        )
      )?.action,
    ).toBe("folder.create");
    // Old recovery receipts, prepared before the history schema existed, still copy their own outcome.
    expect((await nativeCommit("upload", undefined, null, "/native-legacy"))?.action).toBe(
      "file.create",
    );
    expect(
      (await nativeCommit("move", undefined, "/native-legacy", "/native-legacy-moved"))?.action,
    ).toBe("file.move");
    expect(
      (
        await nativeCommit(
          "folder",
          undefined,
          null,
          "/native-legacy-folder",
          undefined,
          false,
          false,
          true,
        )
      )?.action,
    ).toBe("folder.create");
    expect(
      (
        await nativeCommit(
          "move",
          undefined,
          "/restore-unknown",
          "/restored-unknown",
          undefined,
          false,
          true,
        )
      )?.action,
    ).toBe("file.restore");
    const exports = createActivityExportsRepo(first.db, () => at);
    const snapshot = await exports.create(alice.id, "json", { q: ".txt" });
    expect(await exports.get(bob.id, snapshot.id)).toBeNull();
    expect((await exports.get(alice.id, snapshot.id))?.snapshotSequence).toBeGreaterThan(0);
    expect(await exports.lineage(bob.id, snapshot.snapshotSequence)).toEqual([]);
    expect(await exports.revisions(bob.id, snapshot.snapshotSequence)).toEqual([]);
    expect((await exports.lineage(alice.id, snapshot.snapshotSequence)).length).toBeGreaterThan(0);
    expect((await exports.revisions(alice.id, snapshot.snapshotSequence)).length).toBeGreaterThan(
      0,
    );
    expect(await a.locations(alice.id)).toHaveLength(1);
    expect(await a.locations(bob.id)).toEqual([]);
    const secondLogin = await repos.identities.create({
      accountId: alice.id,
      providerId: provider.id,
      externalUsername: "alice-other",
    });
    const tag = await repos.tags.create(alice.id, { name: "Journey", color: null });
    const tagFact = { id: tag.id, name: tag.name, color: tag.color };
    await repos.fileTags.setTags(identity.id, "/tagged.txt", [tag.id]);
    await repos.fileTags.setTags(secondLogin.id, "/other-tagged.txt", [tag.id]);
    await repos.folderViews.set(identity.id, "/pinned", { mode: "grid" });
    await repos.folderViews.set(secondLogin.id, "/other-pinned", { mode: "tree" });
    async function metadataChange(
      action: PersonalActivityAction,
      requested: ActivityFacts,
      mutate: (tx: ReturnType<typeof createRepos>) => Promise<unknown>,
      after: ActivityFacts = requested,
    ) {
      const op = await a.begin({
        ...actor,
        source: "web",
        action,
        requested,
        producerOperationId: randomUUID(),
        requestDigest: randomUUID(),
      });
      await a.claim(alice.id, op.id);
      return a.transaction(async (db) => {
        await createActivityRepo(db).lockForCommit(alice.id, op.id);
        const snapshot = await captureActivityMetadata(
          db,
          alice.id,
          identity.id,
          action,
          requested,
          at,
        );
        await mutate(createRepos(db));
        return createActivityRepo(db, () => at).finish(alice.id, op.id, {
          before: snapshot.before,
          subjects: snapshot.subjects,
          after,
          outcome: activityMetadataUnchanged(action, snapshot.before, after, snapshot.absent)
            ? "skipped"
            : "success",
        });
      });
    }
    const changedTag = await metadataChange(
      "tag.update",
      { tags: [{ ...tagFact, name: "Renamed" }] },
      (tx) => tx.tags.update(tag.id, alice.id, { name: "Renamed" }),
    );
    expect(changedTag.before?.tags?.[0]?.name).toBe("Journey");
    expect(
      (await a.subjects(alice.id, [changedTag.id])).filter((subject) => subject.fileId),
    ).toHaveLength(2);
    expect(
      (await a.list(alice.id, { identityId: secondLogin.id })).some(
        (event) => event.id === changedTag.id,
      ),
    ).toBe(true);
    const unchangedTag = await metadataChange(
      "tag.update",
      { tags: [{ ...tagFact, name: "Renamed" }] },
      (tx) => tx.tags.update(tag.id, alice.id, { name: "Renamed" }),
    );
    expect(unchangedTag.outcome).toBe("skipped");
    const tagsSet = await metadataChange("file.tags.set", { path: "/tagged.txt", tags: [] }, (tx) =>
      tx.fileTags.setTags(identity.id, "/tagged.txt", []),
    );
    expect(tagsSet.before?.tags?.[0]?.id).toBe(tag.id);
    expect(
      (await metadataChange("file.tags.set", { path: "/tagged.txt", tags: [] }, async () => {}))
        .outcome,
    ).toBe("skipped");
    const favorite = await metadataChange(
      "file.favorite.set",
      { path: "/tagged.txt", favorite: true },
      (tx) => tx.favorites.add(identity.id, "/tagged.txt", "file"),
    );
    expect(favorite.before?.favorite).toBe(false);
    expect(
      (
        await metadataChange("file.favorite.set", { path: "/tagged.txt", favorite: true }, (tx) =>
          tx.favorites.add(identity.id, "/tagged.txt", "file"),
        )
      ).outcome,
    ).toBe("skipped");
    expect(
      (
        await metadataChange(
          "folder.view.set",
          { path: "/pinned", kind: "dir", view: "grid" },
          (tx) => tx.folderViews.set(identity.id, "/pinned", { mode: "grid" }),
        )
      ).outcome,
    ).toBe("skipped");
    const reset = await metadataChange("folder.view.reset", { variant: "all" }, async (tx) => {
      await tx.folderViews.clear(identity.id);
      await tx.folderViews.clear(secondLogin.id);
    });
    expect(
      (await a.subjects(alice.id, [reset.id])).filter((subject) => subject.fileId),
    ).toHaveLength(2);
    expect(
      (
        await metadataChange(
          "folder.view.reset",
          { path: "/pinned", variant: "single" },
          async () => {},
        )
      ).outcome,
    ).toBe("skipped");
    const removedTag = await metadataChange(
      "tag.delete",
      { tags: [tagFact] },
      (tx) => tx.tags.delete(tag.id, alice.id),
      { tags: [] },
    );
    expect(removedTag.before?.tags?.[0]?.name).toBe("Renamed");
    expect((await metadataChange("tag.delete", {}, async () => {}, { tags: [] })).outcome).toBe(
      "skipped",
    );
    expect(activityMetadataUnchanged("file.save", {}, {}, false)).toBe(false);
    await expect(
      a.transaction((db) =>
        captureActivityMetadata(db, bob.id, identity.id, "file.favorite.set", {}),
      ),
    ).rejects.toThrow("ownership changed");
    const beforeRollback = await repos.favorites.list(identity.id);
    await expect(
      metadataChange("file.favorite.set", { path: "/rollback", favorite: true }, async (tx) => {
        await tx.favorites.add(identity.id, "/rollback", "file");
        throw Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await repos.favorites.list(identity.id)).toEqual(beforeRollback);
    expect(await a.resolveFile(alice.id, identity.id, "/tagged.txt")).toBe(tagsSet.fileId);
    expect(await a.resolveFile(bob.id, identity.id, "/tagged.txt")).toBeNull();
    const unsealed = await reads.record({ ...outstandingRead, at, requestId: randomUUID() });
    const withReads = await exports.create(alice.id, "csv", {});
    const frozenReads = await exports.reads(alice.id, withReads.id);
    expect(frozenReads.some((row) => row.windowId === unsealed)).toBe(true);
    await reads.record({ ...outstandingRead, at, requestId: randomUUID() });
    expect(await exports.reads(alice.id, withReads.id)).toEqual(frozenReads);
    expect(await exports.reads(bob.id, withReads.id)).toEqual([]);
    expect(await exports.reads(alice.id, withReads.id, frozenReads.at(-1)?.windowId)).toEqual([]);
    expect(
      await exports.lineage(
        alice.id,
        snapshot.snapshotSequence,
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
        { action: "file.open" },
      ),
    ).toEqual([]);
    expect(
      await exports.revisions(
        alice.id,
        snapshot.snapshotSequence,
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
        { q: "never" },
      ),
    ).toEqual([]);
    expect(
      (await observations.tracked(alice.id, identity.id, "/copied-folder")).length,
    ).toBeGreaterThan(0);
    expect(await observations.tracked(bob.id, identity.id, "/copied-folder")).toEqual([]);
    expect(
      await observations.tracked(
        alice.id,
        identity.id,
        "/copied-folder",
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
      ),
    ).toEqual([]);
    await run("file.create", { path: "/occupied.txt", kind: "file" });
    const collision = await observations.observe({
      ...actor,
      path: "/external.txt",
      kind: "moved",
      source: "indexer",
      evidence: "watcher_move",
      after: { path: "/occupied.txt" },
    });
    expect(collision?.action).toBe("observation.continuity_unknown");
    expect((await a.file(alice.id, rediscovered?.fileId as string))?.file.path).toBe(
      "/external.txt",
    );
    const clientId = randomUUID();
    const clientInput = {
      identityId: identity.id,
      requestId: clientId,
      at: at.toISOString(),
      path: "/tagged.txt",
      action: "share.copy_link" as const,
    };
    const copiedLink = await a.clientEvent(alice.id, "context", clientInput, "file");
    expect(await a.clientEvent(alice.id, "context", clientInput, "file")).toEqual(copiedLink);
    expect(copiedLink.evidence).toBe("client_reported");
    const permanentTrash = await run(
      "file.trash",
      { path: "/tagged.txt", kind: "file" },
      { path: "/tagged.txt", trashLeaf: "/.trash/tagged.txt/1234567890000000000" },
    );
    const purged = await run("file.delete", {
      path: "/tagged.txt",
      trashLeaf: "/.trash/tagged.txt/1234567890000000000",
    });
    expect(purged.fileId).toBe(permanentTrash.fileId);
    expect((await a.file(alice.id, purged.fileId as string))?.file.state).toBe("deleted");
    expect(
      (
        await run("file.delete", {
          path: "/unbound",
          trashLeaf: "/.trash/unbound/1234567890000000000",
        })
      ).fileId,
    ).toBeNull();
    const delayedCopy = await a.begin({
      ...actor,
      source: "api",
      action: "file.copy",
      producerOperationId: randomUUID(),
      requestDigest: "delay-copy",
      requested: { path: "/occupied.txt", targetPath: "/old-copy.txt" },
      before: { path: "/occupied.txt", kind: "file" },
    });
    await run("file.save", { path: "/occupied.txt" }, { path: "/occupied.txt", size: 2 });
    expect(
      (
        await a.finish(alice.id, delayedCopy.id, {
          outcome: "success",
          after: { path: "/old-copy.txt" },
        })
      ).fileId,
    ).toBeNull();
    const uncaptured = await a.begin({
      ...actor,
      source: "api",
      action: "file.create",
      producerOperationId: randomUUID(),
      requestDigest: "uncaptured",
      requested: { path: "/newer.txt" },
    });
    await run("file.create", { path: "/newer.txt", kind: "file" });
    expect((await a.finish(alice.id, uncaptured.id, { outcome: "success" })).fileId).toBeNull();
    const archiveJob = await a.begin({
      ...actor,
      source: "web",
      action: "archive.extract",
      producerOperationId: randomUUID(),
      requestDigest: "archive",
      requested: { path: "/occupied.txt", targetPath: "/derived" },
      subjects: [{ identityId: identity.id, path: "/occupied.txt" }],
    });
    const archiveOutput = await a.begin({
      ...actor,
      source: "web",
      action: "file.create",
      producerOperationId: randomUUID(),
      requestDigest: "output",
      parentOperationId: archiveJob.id,
      requested: { path: "/derived.txt" },
    });
    const extracted = await a.finish(alice.id, archiveOutput.id, { outcome: "success" });
    expect((await a.lineage(alice.id, extracted.fileId as string))[0]?.kind).toBe("archive_member");
    await expect(
      first.db.transaction((tx) =>
        appendActivityEvent(tx, {
          ...actor,
          action: "file.open",
          source: "web",
          evidence: "client_reported",
          stage: "outcome",
          outcome: "unknown",
          idempotencyKey: randomUUID(),
          before: { path: `/${"a".repeat(4000)}`, targetPath: `/${"b".repeat(4000)}` },
          after: { path: `/${"c".repeat(4000)}`, targetPath: `/${"d".repeat(4000)}` },
          detail: { path: `/${"e".repeat(4000)}` },
        }),
      ),
    ).rejects.toThrow("16 KiB");
    // Default-clock adapters, recovery locking and independent per-path serialization.
    const live = createActivityRepo(first.db);
    const defaultRead = createActivityReadsRepo(first.db);
    const defaultObservation = createActivityObservationsRepo(first.db);
    const defaultExport = createActivityExportsRepo(first.db);
    const liveOp = await live.begin({
      ...actor,
      source: "api",
      action: "file.create",
      producerOperationId: randomUUID(),
      requestDigest: "clock",
      requested: { path: "/live-clock.txt" },
    });
    await expect(live.lockForCommit(alice.id, liveOp.id)).rejects.toThrow("no longer running");
    await live.claim(alice.id, liveOp.id);
    await live.transaction(async (db) => {
      await createActivityRepo(db).lockForCommit(alice.id, liveOp.id);
    });
    await expect(live.lockForCommit(bob.id, liveOp.id)).rejects.toThrow("no longer running");
    await live.finish(alice.id, liveOp.id, { outcome: "success" });
    const liveReadInput = {
      ...actor,
      action: "file.open" as const,
      path: "/live-clock.txt",
      kind: "file" as const,
      source: "web" as const,
      evidence: "client_reported" as const,
      contextHash: "clock",
      requestId: randomUUID(),
      at: new Date(),
      outcome: "unknown" as const,
    };
    await defaultRead.record(liveReadInput);
    expect(
      (await defaultRead.recents(alice.id, identity.id)).some(
        (row) => row.path === "/live-clock.txt",
      ),
    ).toBe(true);
    expect((await reads.recents(alice.id, identity.id)).some((row) => row.path === "/c.txt")).toBe(
      true,
    );
    await defaultObservation.observe({
      ...actor,
      path: "/live-clock.txt",
      kind: "present",
      source: "refresh",
      evidence: "refresh_comparison",
      after: { path: "/live-clock.txt", size: 1 },
    });
    expect((await defaultExport.create(alice.id, "json", {})).state).toBe("completed");
    expect(await a.completedChildren(alice.id, archiveJob.id)).toBe(1);
    expect(await a.completedChildren(bob.id, archiveJob.id)).toBe(0);
    const lockOrder: number[] = [];
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstLock = a.withPathLock(identity.id, "/same", async () => {
      lockOrder.push(1);
      entered();
      await blocked;
      lockOrder.push(2);
    });
    await started;
    const secondLock = b.withPathLock(identity.id, "/same", async () => {
      lockOrder.push(3);
    });
    await b.withPathLock(identity.id, "/different", async () => {
      lockOrder.push(0);
    });
    release();
    await Promise.all([firstLock, secondLock]);
    expect(lockOrder).toEqual([1, 0, 2, 3]);
    const tagA = { id: randomUUID(), name: "a", color: null },
      tagB = { id: randomUUID(), name: "b", color: null };
    expect(
      activityMetadataUnchanged(
        "file.tags.set",
        { tags: [tagA, tagB] },
        { tags: [tagB, tagA] },
        false,
      ),
    ).toBe(true);
    expect(activityMetadataUnchanged("tag.update", {}, {}, false)).toBe(true);
    await repos.folderViews.set(identity.id, "/invalid-view", { mode: "list" });
    await first.db.execute(
      sql`update app.folder_views set mode = 'unexpected' where identity_id = ${identity.id} and path = '/invalid-view'`,
    );
    await expect(
      a.transaction((db) =>
        captureActivityMetadata(db, alice.id, identity.id, "folder.view.set", {
          path: "/invalid-view",
        }),
      ),
    ).rejects.toThrow("Invalid stored folder view");
    await repos.folderViews.remove(identity.id, "/invalid-view");
    // A pin can carry only a sort, leaving the mode null. That is a real row with no view to
    // record, not a corrupt one, so capture must succeed and report no before view.
    await repos.folderViews.set(identity.id, "/sort-only", {
      sort: { key: "name", direction: "asc" },
    });
    const sortOnly = await a.transaction((db) =>
      captureActivityMetadata(db, alice.id, identity.id, "folder.view.set", {
        path: "/sort-only",
      }),
    );
    expect(sortOnly.before.view).toBeUndefined();
    expect(sortOnly.absent).toBe(false);
    await repos.folderViews.remove(identity.id, "/sort-only");
    // Reset names one pin; reset-all names none and snapshots every pin on the account.
    await repos.folderViews.set(identity.id, "/reset-one", { mode: "grid" });
    const resetOne = await a.transaction((db) =>
      captureActivityMetadata(db, alice.id, identity.id, "folder.view.reset", {
        path: "/reset-one",
      }),
    );
    expect(resetOne.before.view).toBe("grid");
    expect(resetOne.absent).toBe(false);
    const resetAll = await a.transaction((db) =>
      captureActivityMetadata(db, alice.id, identity.id, "folder.view.reset", { variant: "all" }),
    );
    expect(resetAll.before.view).toBeUndefined();
    expect(resetAll.subjects.length).toBeGreaterThan(0);
    await repos.folderViews.remove(identity.id, "/reset-one");
    expect((await a.batchSummary(alice.id, batchId)).total).toBeGreaterThan(0);
    expect(await a.batchSummary(bob.id, batchId)).toEqual({ total: 0, outcomes: {} });
    const unseenMove = await run("file.move", {
      path: "/unseen-source",
      targetPath: "/unseen-target",
    });
    const replacedKind = await run("file.create", { path: "/replaced-kind", kind: "file" });
    const replacement = await run("folder.create", { path: "/replaced-kind", kind: "dir" });
    expect(replacement.fileId).not.toBe(replacedKind.fileId);
    expect((await a.file(alice.id, replacedKind.fileId as string))?.file.state).toBe("deleted");
    expect((await a.file(alice.id, unseenMove.fileId as string))?.file.path).toBe("/unseen-target");
    const unseenDelete = await run("file.delete", { path: "/unseen-delete" });
    expect((await a.file(alice.id, unseenDelete.fileId as string))?.file.state).toBe("deleted");
    const unseenCopy = await run("file.copy", {
      path: "/unseen-copy-source",
      targetPath: "/unseen-copy-target",
    });
    expect((await a.lineage(alice.id, unseenCopy.fileId as string)).length).toBe(1);
    expect(
      await a.lineage(
        alice.id,
        unseenCopy.fileId as string,
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
      ),
    ).toEqual([]);
    expect(
      await a.revisions(
        alice.id,
        unseenCopy.fileId as string,
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
      ),
    ).toEqual([]);
    const cancelled = await a.begin({
      ...actor,
      source: "api",
      action: "file.save",
      requested: { path: "/cancel" },
      producerOperationId: randomUUID(),
      requestDigest: "cancel",
    });
    await a.finish(alice.id, cancelled.id, { outcome: "cancelled" });
    expect(
      await a.recoverAbandoned(
        alice.id,
        cancelled.id,
        { outcome: "unknown" },
        new Date(at.getTime() + 100000),
      ),
    ).toBeNull();
    await expect(a.finish(alice.id, randomUUID(), { outcome: "success" })).rejects.toThrow(
      "not found",
    );
    const bulk = await a.begin({
      ...actor,
      action: "share.create",
      source: "web",
      producerOperationId: randomUUID(),
      requestDigest: "bulk",
      requested: {},
      subjects: Array.from({ length: 1000 }, (_, i) => ({
        identityId: identity.id,
        path: `/batch/file-${i}.txt`,
      })),
    });
    const bulkEvent = await a.finish(alice.id, bulk.id, { outcome: "success" });
    expect(await a.subjects(alice.id, [bulkEvent.id])).toHaveLength(21);
    const firstSubjects = await a.subjectPage(alice.id, bulkEvent.id);
    expect(firstSubjects).toHaveLength(100);
    expect(
      (await a.subjectPage(alice.id, bulkEvent.id, firstSubjects.at(-1)?.ordinal)).every(
        (subject) => subject.ordinal > (firstSubjects.at(-1)?.ordinal ?? 0),
      ),
    ).toBe(true);
    await first.db.execute(
      sql`delete from app.activity_operations where owner_account_id = ${alice.id}`,
    );
    expect((await b.event(alice.id, saved.id))?.action).toBe("file.save");
    await first.db.execute(
      sql`update app.identities set account_id = ${bob.id} where id = ${identity.id}`,
    );
    expect((await b.event(alice.id, saved.id))?.actorAccountId).toBe(alice.id);
    expect(await b.event(bob.id, saved.id)).toBeNull();
    await expect(
      a.begin({
        ...actor,
        action: "file.save",
        source: "web",
        producerOperationId: randomUUID(),
        requestDigest: "old",
        requested: { path: "/b.txt" },
      }),
    ).rejects.toThrow("ownership changed");
    await expect(
      first.db.transaction((tx) =>
        appendActivityEvent(tx, {
          ...actor,
          action: "file.save",
          source: "api",
          stage: "outcome",
          evidence: "server_confirmed",
          outcome: "success",
          idempotencyKey: "invalid",
          detail: { path: "/test", secret: "never store" } as ActivityFacts,
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await first.close();
    await second.close();
    await container.stop();
  }
});
