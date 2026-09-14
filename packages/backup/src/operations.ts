import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { BackupEstimateJob, BackupRehearsal, BackupSchedule } from "@fdrive/contracts";
import { DURABLE_TABLES } from "./registry.js";
import type { BackupStore } from "./store.js";
import type { BackupSource } from "./types.js";

/** Persisted operator status; worker ownership itself remains a PostgreSQL advisory lock. */
export class BackupOperations {
  constructor(
    readonly store: BackupStore,
    readonly source: BackupSource,
    readonly directory: string,
    /** Upper bound for one size estimate, including source enumeration during an outage. */
    readonly estimateDeadlineMs = 10 * 60_000,
  ) {}
  async heartbeat(): Promise<void> {
    await this.store.setting("backup.worker.v1", { seenAt: new Date().toISOString() });
  }
  async status() {
    const values = await this.store.settings([
      "backup.worker.v1",
      "backup.estimate.v1",
      "backup.rehearsal.v1",
    ]);
    const worker = values["backup.worker.v1"] as { seenAt?: string } | undefined;
    return {
      workerSeenAt: worker?.seenAt ?? null,
      estimate: values["backup.estimate.v1"]
        ? BackupEstimateJob.parse(values["backup.estimate.v1"])
        : null,
      rehearsal: values["backup.rehearsal.v1"]
        ? BackupRehearsal.parse(values["backup.rehearsal.v1"])
        : null,
    };
  }
  async requestEstimate(): Promise<string> {
    const id = randomUUID();
    await this.store.setting("backup.estimate.v1", {
      id,
      state: "pending",
      result: null,
      error: null,
    });
    return id;
  }
  async estimatePending(): Promise<void> {
    const job = (await this.status()).estimate;
    if (job?.state !== "pending") return;
    let result: BackupEstimateJob["result"] = null;
    let error: string | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        this.estimate(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(Error("Size estimate timed out")),
            this.estimateDeadlineMs,
          );
          deadline.unref();
        }),
      ]);
    } catch {
      error = "Size estimate unavailable. Check source access and available storage.";
    } finally {
      clearTimeout(deadline);
    }
    await this.store.pool.query(
      "update app.settings set value=$2 where key='backup.estimate.v1' and value->>'id'=$1",
      [job.id, JSON.stringify({ id: job.id, state: error ? "failed" : "complete", result, error })],
    );
  }
  private async estimate(): Promise<NonNullable<BackupEstimateJob["result"]>> {
    const client = await this.source.pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      await client.query("set local statement_timeout='120s'");
      const database =
        (
          await client.query<{ bytes: string }>(
            "select sum(pg_total_relation_size(t::regclass))::text as bytes from unnest($1::text[]) t",
            [DURABLE_TABLES],
          )
        ).rows[0]?.bytes ?? "0";
      const capture = await this.source.blobs(client);
      const recovery = capture.sources.reduce((sum, blob) => sum + BigInt(blob.size), 0n);
      const total = BigInt(database) + recovery;
      const policy = (await this.store.configuration()).schedule;
      const destinations = (await this.store.destinations()).filter(
        (destination) => destination.enabled,
      );
      let retained = 0n;
      for (const destination of destinations) {
        const schedule = destination.config.schedule
          ? BackupSchedule.parse(destination.config.schedule)
          : policy;
        retained += BigInt(schedule.daily + schedule.weekly + schedule.monthly) * total;
      }
      const space = await statfs(dirname(this.directory));
      await client.query("commit");
      return {
        estimatedAt: new Date().toISOString(),
        databaseBytes: database,
        recoveryBytes: String(recovery),
        uncompressedBytes: String(total),
        retainedBytes: String(retained),
        transferAndReadbackBytes: String(total * BigInt(destinations.length) * 2n),
        availableSpoolBytes: String(BigInt(space.bavail) * BigInt(space.bsize)),
        coverage: capture.coverage,
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async recordRehearsal(input: BackupRehearsal): Promise<void> {
    const report = BackupRehearsal.parse(input);
    const config = await this.store.configuration();
    if (
      report.sourceInstallationId !== config.installation_id ||
      !(await this.store.run(report.snapshotId)) ||
      new Date(report.completedAt).getTime() > Date.now() + 60_000
    )
      throw Error("Rehearsal report does not match this installation and snapshot");
    await this.store.setting("backup.rehearsal.v1", report);
  }
  async inventory(id: string, attachmentVersions: string[]): Promise<void> {
    await this.store.setting(`backup.inventory.${id}`, { attachmentVersions });
  }
  async inventories(ids: string[]): Promise<Record<string, { attachmentVersions: string[] }>> {
    const values = await this.store.settings(ids.map((id) => `backup.inventory.${id}`));
    return Object.fromEntries(
      ids.map((id) => [id, values[`backup.inventory.${id}`] ?? { attachmentVersions: [] }]),
    ) as Record<string, { attachmentVersions: string[] }>;
  }
}
