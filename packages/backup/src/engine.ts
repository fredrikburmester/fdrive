import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chown, mkdir, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BackupRunInput, BackupSchedule } from "@fdrive/contracts";
import { Encrypter } from "age-encryption";
import type { z } from "zod";
import { probeDestination, verifyDelivery } from "./destinations.js";
import { BackupOperations } from "./operations.js";
import { BACKUP_WORKER } from "./registry.js";
import { nextSchedule, retentionKeep } from "./schedule.js";
import { captureSnapshot } from "./snapshot.js";
import type { BackupStore, DestinationRecord, RunRecord } from "./store.js";
import { digest, fileStream, ignoreCleanupError } from "./streams.js";
import type { BackupDestination, BackupSource } from "./types.js";

/** Deletion stopped at copies a destination keeps under retention; the catalog keeps them. */
export class BackupRetainedError extends Error {
  constructor(readonly retained: { name: string; retentionUntil: string | null }[]) {
    super(
      `Retention keeps this backup at ${retained
        .map((copy) =>
          copy.retentionUntil ? `${copy.name} until ${copy.retentionUntil}` : copy.name,
        )
        .join(", ")}. Copies without retention were deleted.`,
    );
    this.name = "BackupRetainedError";
  }
}
export interface EngineOptions {
  store: BackupStore;
  source: BackupSource;
  directory: string;
  destination(record: DestinationRecord): Promise<BackupDestination>;
  now?: () => Date;
  maxRunMs?: number;
}
export class BackupEngine {
  readonly operations: BackupOperations;
  readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private task: Promise<void> | undefined;
  private controller: AbortController | undefined;
  constructor(readonly options: EngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.operations = new BackupOperations(options.store, options.source, options.directory);
  }
  artifact(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid backup ID");
    return join(this.options.directory, `${id}.fdrive.age`);
  }
  async challenge(recipient: string): Promise<string> {
    const encrypt = new Encrypter();
    encrypt.addRecipient(recipient);
    const proof = randomBytes(32).toString("base64url");
    const ciphertext = await encrypt.encrypt(proof);
    await this.options.store.setKey(
      recipient,
      createHash("sha256").update(proof).digest("hex"),
      new Date(this.now().getTime() + 600_000),
    );
    return Buffer.from(ciphertext).toString("base64");
  }
  async confirm(proof: string): Promise<void> {
    if (!(await this.options.store.confirmKey(createHash("sha256").update(proof).digest("hex"))))
      throw Error("Recovery key confirmation expired or failed");
    await this.options.store.event("Backup recovery key confirmed");
  }
  async queue(owner: string, request: z.infer<typeof BackupRunInput>): Promise<string> {
    const id = await this.options.store.queue(owner, request);
    await this.options.store.event("Backup requested", { runId: id, actor: owner });
    return id;
  }
  async testDestination(record: DestinationRecord): Promise<void> {
    const probe = await probeDestination(await this.options.destination(record));
    const { retainedProbe: _, ...config } = record.config;
    await this.options.store.saveDestination({
      ...record,
      config: probe.retained ? { ...config, retainedProbe: probe.retained } : config,
      enabled: true,
      tested_at: this.now(),
    });
    if (probe.retained)
      await this.options.store.event("Backup destination retains its test object", {
        destinationId: record.id,
        ...probe.retained,
      });
  }
  start(): void {
    if (this.timer) return;
    const kick = () => {
      if (!this.task)
        this.task = this.tick()
          .catch(ignoreCleanupError)
          .finally(() => {
            this.task = undefined;
          });
    };
    kick();
    this.timer = setInterval(kick, 5000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.task;
  }
  async tick(): Promise<void> {
    const { store } = this.options;
    const lock = await store.pool.connect();
    let owned = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const abort = () => this.controller?.abort();
    lock.on("error", abort);
    try {
      owned =
        (
          await lock.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [
            BACKUP_WORKER,
          ])
        ).rows[0]?.locked ?? false;
      if (!owned) return;
      const config = await store.configuration();
      if (config.restored) return;
      await this.operations.heartbeat();
      heartbeat = setInterval(() => {
        void this.operations.heartbeat().catch(ignoreCleanupError);
      }, 5000);
      heartbeat.unref();
      // Only the process holding the worker lock may recover abandoned capture state.
      await lock.query(
        "update app.backup_runs set state=case when artifact is null then 'failed' else 'queued' end,error='Previous backup worker stopped; captured artifacts can be retried' where state in ('capturing','transferring')",
      );
      if (config.confirmed) {
        const destinations = (await store.destinations()).filter(
          (destination) => destination.enabled,
        );
        const due = destinations.filter((destination) =>
          destination.config.schedule
            ? typeof destination.config.nextRun === "string" &&
              new Date(destination.config.nextRun) <= this.now()
            : config.next_run_at !== null && config.next_run_at <= this.now(),
        );
        if (due.length) {
          const slot = createHash("sha256")
            .update(
              due
                .map(
                  (destination) =>
                    `${destination.id}:${destination.config.schedule ? destination.config.nextRun : config.next_run_at?.toISOString()}`,
                )
                .sort()
                .join(","),
            )
            .digest("hex");
          await store.queue(
            null,
            { destinationIds: due.map((destination) => destination.id), metadataOnly: false },
            slot,
          );
          for (const destination of due)
            if (destination.config.schedule)
              await store.destinationSchedule(
                destination.id,
                BackupSchedule.parse(destination.config.schedule),
                this.now(),
              );
        }
        if (config.next_run_at && config.next_run_at <= this.now()) {
          if (destinations.length === 0)
            await store.queue(
              null,
              { destinationIds: [], metadataOnly: false },
              `local:${config.next_run_at.toISOString()}`,
            );
          await lock.query(
            "update app.backup_configuration set next_run_at=$1 where id=1 and next_run_at=$2",
            [nextSchedule(config.schedule, this.now()), config.next_run_at],
          );
        }
      }
      const pending = (
        await lock.query<RunRecord>(
          "select * from app.backup_runs where state='queued' order by created_at limit 1",
        )
      ).rows[0];
      if (pending) {
        pending.lease_id = randomUUID();
        const claim = await lock.query(
          "update app.backup_runs set lease_id=$2 where id=$1 and state='queued' returning id",
          [pending.id, pending.lease_id],
        );
        if (claim.rows.length) await this.execute(pending, config.installation_id);
      }
      const verification = (
        await lock.query<{ id: string }>(
          "select id from app.backup_runs where verification_requested=true order by created_at limit 1",
        )
      ).rows[0];
      if (verification) {
        let error: string | null = null;
        try {
          await this.verify(verification.id);
        } catch {
          error = "Verification failed: a retained copy is unavailable or its bytes changed.";
        }
        await lock.query(
          "update app.backup_runs set verification_requested=false,verification_error=$2 where id=$1",
          [verification.id, error],
        );
      }
      await this.operations.estimatePending();
      await this.cleanSpool();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      lock.off("error", abort);
      if (owned)
        await lock
          .query("select pg_advisory_unlock($1)", [BACKUP_WORKER])
          .catch(ignoreCleanupError);
      lock.release();
    }
  }
  private async execute(run: RunRecord, installationId: string): Promise<void> {
    const { store } = this.options;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const setRun = (state: string, values: Parameters<BackupStore["setRun"]>[2] = {}) =>
      store.setRun(run.id, state, { ...values, lease: run.lease_id as string });
    const timeout = setTimeout(
      () => this.controller?.abort(),
      this.options.maxRunMs ?? 60 * 60_000,
    );
    timeout.unref();
    const watcher = setInterval(() => {
      void store
        .run(run.id)
        .then((current) => {
          if (current?.state === "cancelled" || current?.lease_id !== run.lease_id)
            this.controller?.abort();
        })
        .catch(() => this.controller?.abort());
    }, 1000);
    watcher.unref();
    let captured = !!run.artifact;
    try {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      const owner = await stat(join(this.options.directory, ".."));
      if (process.getuid?.() === 0) await chown(this.options.directory, owner.uid, owner.gid);
      const file = this.artifact(run.id);
      let coverage = run.coverage;
      if (!run.artifact) {
        const disk = await statfs(this.options.directory);
        if (disk.bavail * disk.bsize < 128 * 1024 * 1024)
          throw Error("Insufficient backup spool space");
        await setRun("capturing");
        const result = await captureSnapshot(this.options.source, {
          id: run.id,
          installationId,
          recipient: run.recipient,
          output: file,
          metadataOnly: run.request.metadataOnly,
          signal,
        });
        captured = true;
        await this.operations.inventory(
          run.id,
          result.manifest.blobs
            .filter((blob) => blob.kind === "attachment")
            .map((blob) => blob.path),
        );
        if (process.getuid?.() === 0) await chown(file, owner.uid, owner.gid);
        coverage = result.manifest.coverage;
        await setRun("transferring", {
          artifact: file,
          bytes: result.bytes,
          sha256: result.sha256,
          coverage,
        });
      }
      let failed = false;
      for (const delivery of await store.deliveries(run.id)) {
        signal.throwIfAborted();
        if (delivery.state === "complete") continue;
        try {
          const destination = await store.destination(delivery.destination_id);
          if (!destination?.enabled || destination.revision !== delivery.destination_revision)
            throw Error("Destination changed; create a new backup");
          const transport = await this.options.destination(destination);
          const key = `${run.id}.fdrive.age`;
          const known = await store.run(run.id);
          const local = await digest(fileStream(file));
          if (local.sha256 !== known?.sha256 || String(local.bytes) !== known?.bytes)
            throw Error("Retained archive integrity failed");
          const written = await verifyDelivery(transport, key, file, signal);
          const current = await store.run(run.id);
          const completion = join(this.options.directory, `${run.id}-${delivery.id}.complete.json`);
          await writeFile(
            completion,
            JSON.stringify({
              format: 1,
              installationId,
              id: run.id,
              createdAt: run.created_at.toISOString(),
              key,
              bytes: current?.bytes,
              sha256: current?.sha256,
              versionId: written.versionId ?? null,
              coverage,
            }),
            { mode: 0o600 },
          );
          try {
            const marker = await verifyDelivery(
              transport,
              `${run.id}.complete.json`,
              completion,
              signal,
            );
            signal.throwIfAborted();
            const information = await transport.information(key);
            await store.pool.query(
              "update app.backup_deliveries set marker_version_id=$2,retention_until=$3 where id=$1",
              [delivery.id, marker.versionId ?? null, information?.retentionUntil ?? null],
            );
          } finally {
            await rm(completion, { force: true });
          }
          signal.throwIfAborted();
          await store.setDelivery(delivery.id, "complete", key, written.versionId ?? null, null);
        } catch {
          failed = true;
          await store.setDelivery(
            delivery.id,
            "failed",
            null,
            null,
            "Destination unavailable, changed, or failed readback. Test its connection and retry.",
          );
        }
      }
      signal.throwIfAborted();
      await setRun(failed || coverage.length ? "partial" : "complete", {
        coverage,
        error: failed
          ? "One or more destinations failed; the local archive remains available."
          : null,
      });
      await store.event("Backup finished", {
        runId: run.id,
        complete: !failed && !coverage.length,
      });
      if (!failed && !coverage.length) {
        try {
          await this.prune((await store.configuration()).schedule);
        } catch {
          await store.event("Backup retention is blocked; verified copies remain retained", {
            runId: run.id,
          });
        }
      }
    } catch {
      await setRun(signal.aborted ? "cancelled" : "failed", {
        error: signal.aborted
          ? "Backup cancelled"
          : "Backup capture failed. Check required sources, storage space and credentials.",
      });
      await store.event("Backup did not complete", { runId: run.id });
      if (!signal.aborted && !captured && run.schedule_slot && !run.request.metadataOnly) {
        try {
          const fallback = await store.queue(
            null,
            { ...run.request, metadataOnly: true },
            `fallback:${run.schedule_slot}`,
          );
          await store.event("Partial metadata fallback requested", {
            runId: fallback,
            failedRunId: run.id,
          });
        } catch {
          await store.event("Partial metadata fallback could not be queued", { runId: run.id });
        }
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(watcher);
      this.controller = undefined;
    }
  }
  async verify(id: string): Promise<void> {
    const run = await this.options.store.run(id);
    if (!run || !["complete", "partial"].includes(run.state))
      throw Error("Choose a completed backup");
    let checked = false;
    if (run.artifact) {
      const local = await digest(fileStream(this.artifact(id)));
      if (local.sha256 !== run.sha256 || String(local.bytes) !== run.bytes)
        throw Error("Local backup integrity failed");
      checked = true;
    }
    for (const delivery of await this.options.store.deliveries(id)) {
      if (delivery.state !== "complete" || !delivery.object_key) continue;
      const record = await this.options.store.destination(delivery.destination_id);
      if (!record || record.revision !== delivery.destination_revision)
        throw Error("Destination binding changed");
      const destination = await this.options.destination(record);
      const remote = await digest(
        await destination.get(delivery.object_key, delivery.version_id ?? undefined),
      );
      if (remote.sha256 !== run.sha256 || String(remote.bytes) !== run.bytes)
        throw Error("Remote backup integrity failed");
      checked = true;
    }
    if (!checked) throw Error("No retained archive is available");
    await this.options.store.pool.query(
      "update app.backup_runs set verified_at=now() where id=$1",
      [id],
    );
  }
  async cleanSpool(): Promise<void> {
    const cutoff = this.now().getTime() - 24 * 60 * 60_000;
    for (const run of await this.options.store.runs(100_000))
      if (
        run.artifact &&
        !run.pinned &&
        run.created_at.getTime() < cutoff &&
        !["queued", "capturing", "transferring"].includes(run.state)
      ) {
        await this.options.store.lockRun(run.id, async (client, current) => {
          if (
            !current?.artifact ||
            current.pinned ||
            ["queued", "capturing", "transferring"].includes(current.state)
          )
            return;
          await rm(this.artifact(run.id), { force: true });
          await client.query("update app.backup_runs set artifact=null where id=$1", [run.id]);
        });
      }
    const active = ["queued", "capturing", "transferring"];
    for (const name of await readdir(this.options.directory).catch(() => [])) {
      const match =
        /^([a-f0-9-]{36})\.fdrive\.age(\.partial)?$/.exec(name) ??
        /^([a-f0-9-]{36})-[a-f0-9-]{36}(\.complete\.json)$/.exec(name);
      if (!match) continue;
      const file = join(this.options.directory, name);
      const modified = await stat(file).then(
        (info) => info.mtimeMs,
        () => Number.POSITIVE_INFINITY,
      );
      if (modified >= cutoff) continue;
      if (!match[2]) {
        // A final archive published just before the process died has no run artifact
        // referencing it. Remove it only once its run is gone or settled, never while the run
        // is active, pinned or still owns an artifact (the loop above handles those).
        const run = await this.options.store.run(match[1] as string);
        if (run && (run.artifact || run.pinned || active.includes(run.state))) continue;
      }
      await rm(file, { force: true });
    }
  }
  async prune(schedule: BackupSchedule): Promise<void> {
    const { store } = this.options;
    const runs = (await store.runs(100_000)).filter((run) => run.state === "complete");
    const catalogs = await Promise.all(
      runs.map(async (run) => ({ run, deliveries: await store.deliveries(run.id) })),
    );
    const keep = new Set(runs.filter((run) => run.pinned).map((run) => run.id));
    const select = (values: RunRecord[], policy: BackupSchedule) => {
      for (const id of retentionKeep(
        values.map((run) => ({
          id: run.id,
          createdAt: run.created_at.toISOString(),
          pinned: run.pinned,
        })),
        policy,
      ))
        keep.add(id);
    };
    select(
      catalogs.filter((item) => !item.deliveries.length).map((item) => item.run),
      schedule,
    );
    for (const destination of await store.destinations())
      select(
        catalogs
          .filter((item) =>
            item.deliveries.some(
              (delivery) =>
                delivery.destination_id === destination.id && delivery.state === "complete",
            ),
          )
          .map((item) => item.run),
        destination.config.schedule ? BackupSchedule.parse(destination.config.schedule) : schedule,
      );
    // A shared snapshot may be retained longer when another destination still needs it.
    for (const run of runs) if (!keep.has(run.id)) await this.remove(run.id);
  }
  async remove(id: string): Promise<void> {
    const { store } = this.options;
    const retained = await store.lockRun(id, async (client, run) => {
      if (!run || run.pinned || ["queued", "capturing", "transferring"].includes(run.state))
        throw Error("Backup is pinned or running");
      const retained: BackupRetainedError["retained"] = [];
      for (const delivery of await store.deliveries(id)) {
        if (delivery.state === "deleted" || !delivery.object_key) continue;
        const destination = await store.destination(delivery.destination_id);
        if (!destination || destination.revision !== delivery.destination_revision)
          throw Error("Destination changed; cannot prune its backups");
        const transport = await this.options.destination(destination);
        try {
          await transport.remove(delivery.object_key, delivery.version_id ?? undefined);
        } catch (error) {
          // A copy the destination keeps under retention is status, not corruption: record
          // its deadline, keep the catalog entry and continue with the other copies.
          const information = await transport.information(delivery.object_key).catch(() => null);
          if (!information?.retentionUntil) throw error;
          await client.query("update app.backup_deliveries set retention_until=$2 where id=$1", [
            delivery.id,
            information.retentionUntil,
          ]);
          retained.push({ name: delivery.name, retentionUntil: information.retentionUntil });
          continue;
        }
        await transport.remove(`${run.id}.complete.json`, delivery.marker_version_id ?? undefined);
        await store.setDelivery(delivery.id, "deleted", null, null, null);
      }
      if (retained.length) return retained;
      if (run.artifact) await rm(this.artifact(id), { force: true });
      await client.query("update app.backup_runs set artifact=null where id=$1", [id]);
      return retained;
    });
    if (retained.length) throw new BackupRetainedError(retained);
  }
}
