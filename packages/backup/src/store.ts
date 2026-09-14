import { randomUUID } from "node:crypto";
import { BackupSchedule } from "@fdrive/contracts";
import type { Pool, PoolClient } from "pg";
import { nextSchedule } from "./schedule.js";

export interface Configuration {
  installation_id: string;
  recipient: string | null;
  confirmed: boolean;
  challenge_hash: string | null;
  challenge_expires_at: Date | null;
  schedule: BackupSchedule;
  next_run_at: Date | null;
  restored: boolean;
}
export interface DestinationRecord {
  id: string;
  revision: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  secret: Buffer;
  enabled: boolean;
  tested_at: Date | null;
}
export interface AttachmentRecord {
  id: string;
  version_id: string;
  label: string;
  filename: string;
  source_date: Date | null;
  notes: string;
  uploaded_at: Date;
  bytes: string;
  sha256: string;
  secret: Buffer;
}
export interface RunRecord {
  schedule_slot: string | null;
  verification_requested: boolean;
  verification_error: string | null;
  lease_id: string | null;
  verified_at: Date | null;
  id: string;
  state: string;
  request: { destinationIds: string[]; metadataOnly: boolean };
  recipient: string;
  created_at: Date;
  completed_at: Date | null;
  bytes: string;
  sha256: string | null;
  error: string | null;
  coverage: string[];
  pinned: boolean;
  artifact: string | null;
}
export interface DeliveryRecord {
  marker_version_id: string | null;
  retention_until: Date | null;
  id: string;
  run_id: string;
  destination_id: string;
  destination_revision: string;
  name: string;
  state: string;
  object_key: string | null;
  version_id: string | null;
  verified_at: Date | null;
  error: string | null;
}
export class BackupStore {
  constructor(readonly pool: Pool) {}
  async setting(key: string, value: unknown): Promise<void> {
    await this.pool.query(
      "insert into app.settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value",
      [key, JSON.stringify(value)],
    );
  }
  async settings(keys: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(
      (
        await this.pool.query<{ key: string; value: unknown }>(
          "select key,value from app.settings where key=any($1::text[])",
          [keys],
        )
      ).rows.map((row) => [row.key, row.value]),
    );
  }
  async configuration(): Promise<Configuration> {
    await this.pool.query(
      "insert into app.backup_configuration(id) values (1) on conflict do nothing",
    );
    const row = (
      await this.pool.query<Configuration>("select * from app.backup_configuration where id = 1")
    ).rows[0];
    if (!row) throw Error("Backup configuration unavailable");
    row.schedule = BackupSchedule.parse(row.schedule);
    return row;
  }
  async owner(accountId: string): Promise<boolean> {
    const result = await this.pool.query(
      "select 1 from app.settings where key = 'setup.owner.v1' and value->>'state' = 'complete' and value->>'accountId' = $1",
      [accountId],
    );
    return result.rows.length === 1;
  }
  async setKey(recipient: string, hash: string, expires: Date): Promise<void> {
    await this.configuration();
    await this.pool.query(
      "update app.backup_configuration set recipient=$1, confirmed=false, challenge_hash=$2, challenge_expires_at=$3, next_run_at=null where id=1",
      [recipient, hash, expires],
    );
  }
  async confirmKey(hash: string): Promise<boolean> {
    return (
      (
        await this.pool.query(
          "update app.backup_configuration set confirmed=true, challenge_hash=null, challenge_expires_at=null where id=1 and challenge_hash=$1 and challenge_expires_at > now() returning id",
          [hash],
        )
      ).rows.length === 1
    );
  }
  async setSchedule(schedule: BackupSchedule, now: Date): Promise<void> {
    const config = await this.configuration();
    if ((!config.confirmed || config.restored) && schedule.frequency !== "manual")
      throw Error("Confirm the recovery key and finish restore before scheduling");
    await this.pool.query(
      "update app.backup_configuration set schedule=$1, next_run_at=$2 where id=1",
      [JSON.stringify(schedule), nextSchedule(schedule, now)],
    );
  }
  async destinations(): Promise<DestinationRecord[]> {
    return (
      await this.pool.query<DestinationRecord>(
        "select * from app.backup_destinations order by name,id",
      )
    ).rows;
  }
  async destination(id: string): Promise<DestinationRecord | null> {
    return (
      (
        await this.pool.query<DestinationRecord>(
          "select * from app.backup_destinations where id=$1",
          [id],
        )
      ).rows[0] ?? null
    );
  }
  async saveDestination(record: DestinationRecord): Promise<void> {
    const saved = await this.pool.query(
      "insert into app.backup_destinations(id,revision,name,type,config,secret,enabled,tested_at) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(id) do update set revision=excluded.revision,name=excluded.name,type=excluded.type,config=excluded.config,secret=excluded.secret,enabled=excluded.enabled,tested_at=excluded.tested_at where app.backup_destinations.revision=excluded.revision or not exists(select 1 from app.backup_deliveries d where d.destination_id=excluded.id and d.state <> 'deleted') returning id",
      [
        record.id,
        record.revision,
        record.name,
        record.type,
        JSON.stringify(record.config),
        record.secret,
        record.enabled,
        record.tested_at,
      ],
    );
    if (!saved.rows.length)
      throw Error("Retained backups use this destination binding; add a new destination instead");
  }
  async destinationSchedule(id: string, schedule: BackupSchedule | null, now: Date): Promise<void> {
    const config = await this.configuration();
    if (!config.confirmed || config.restored) throw Error("Confirm the recovery key first");
    await this.pool.query(
      "update app.backup_destinations set config=config || $2::jsonb where id=$1",
      [
        id,
        JSON.stringify({
          schedule,
          nextRun: schedule ? (nextSchedule(schedule, now)?.toISOString() ?? null) : null,
        }),
      ],
    );
  }
  async deleteDestination(id: string): Promise<void> {
    const removed = await this.pool.query(
      "delete from app.backup_destinations where id=$1 and not exists(select 1 from app.backup_deliveries d where d.destination_id=$1 and d.state <> 'deleted') returning id",
      [id],
    );
    if (!removed.rows.length && (await this.destination(id)))
      throw Error("Delete retained backups before removing their destination");
  }
  async attachments(client: Pool | PoolClient = this.pool): Promise<AttachmentRecord[]> {
    return (
      await client.query<AttachmentRecord>(
        "select * from app.backup_attachments order by uploaded_at,id",
      )
    ).rows;
  }
  async attachment(id: string): Promise<AttachmentRecord | null> {
    return (
      (
        await this.pool.query<AttachmentRecord>(
          "select * from app.backup_attachments where id=$1",
          [id],
        )
      ).rows[0] ?? null
    );
  }
  async saveAttachment(record: AttachmentRecord): Promise<void> {
    await this.pool.query(
      "insert into app.backup_attachments(id,version_id,label,filename,source_date,notes,uploaded_at,bytes,sha256,secret) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(id) do update set version_id=excluded.version_id,label=excluded.label,filename=excluded.filename,source_date=excluded.source_date,notes=excluded.notes,uploaded_at=excluded.uploaded_at,bytes=excluded.bytes,sha256=excluded.sha256,secret=excluded.secret",
      [
        record.id,
        record.version_id,
        record.label,
        record.filename,
        record.source_date,
        record.notes,
        record.uploaded_at,
        record.bytes,
        record.sha256,
        record.secret,
      ],
    );
  }
  async deleteAttachment(id: string): Promise<void> {
    await this.pool.query("delete from app.backup_attachments where id=$1", [id]);
  }
  async queue(
    requestedBy: string | null,
    request: RunRecord["request"],
    slot?: string,
  ): Promise<string> {
    await this.configuration();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const config = (
        await client.query<Configuration>(
          "select * from app.backup_configuration where id=1 for share",
        )
      ).rows[0];
      if (!config?.confirmed || !config.recipient || config.restored)
        throw Error("Confirm a recovery key and complete restore before backing up");
      const destinations: DestinationRecord[] = [];
      for (const destinationId of new Set(request.destinationIds)) {
        const row = (
          await client.query<DestinationRecord>(
            "select * from app.backup_destinations where id=$1 for share",
            [destinationId],
          )
        ).rows[0];
        if (!row?.enabled) throw Error("Backup destination is not enabled");
        destinations.push(row);
      }
      const id = randomUUID();
      const inserted = await client.query(
        "insert into app.backup_runs(id,requested_by,request,recipient,schedule_slot) values($1,$2,$3,$4,$5) on conflict(schedule_slot) do nothing returning id",
        [id, requestedBy, JSON.stringify(request), config.recipient, slot ?? null],
      );
      if (inserted.rows.length)
        for (const destination of destinations) {
          await client.query(
            "insert into app.backup_deliveries(run_id,destination_id,destination_revision,name) values($1,$2,$3,$4)",
            [id, destination.id, destination.revision, destination.name],
          );
        }
      await client.query("commit");
      return inserted.rows.length ? id : "";
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async runs(limit = 100): Promise<RunRecord[]> {
    return (
      await this.pool.query<RunRecord>(
        "select * from app.backup_runs order by created_at desc,id limit $1",
        [limit],
      )
    ).rows;
  }
  async run(id: string): Promise<RunRecord | null> {
    return (
      (await this.pool.query<RunRecord>("select * from app.backup_runs where id=$1", [id]))
        .rows[0] ?? null
    );
  }
  async lockRun<T>(
    id: string,
    work: (client: PoolClient, run: RunRecord | undefined) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout='10s'");
      const run = (
        await client.query<RunRecord>("select * from app.backup_runs where id=$1 for update", [id])
      ).rows[0];
      const result = await work(client, run);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async pin(id: string, pinned: boolean): Promise<void> {
    await this.lockRun(id, async (client, run) => {
      if (!run) throw Error("Backup no longer exists");
      const remote = await client.query(
        "select 1 from app.backup_deliveries where run_id=$1 and state='complete' limit 1",
        [id],
      );
      if (pinned && !run.artifact && !remote.rows.length)
        throw Error("No retained copy is available to keep");
      await client.query("update app.backup_runs set pinned=$2 where id=$1", [id, pinned]);
    });
  }
  async deliveries(id: string): Promise<DeliveryRecord[]> {
    return (
      await this.pool.query<DeliveryRecord>(
        "select * from app.backup_deliveries where run_id=$1 order by name",
        [id],
      )
    ).rows;
  }
  async setRun(
    id: string,
    state: string,
    values: {
      artifact?: string;
      bytes?: number;
      sha256?: string;
      coverage?: string[];
      error?: string | null;
      lease?: string;
    } = {},
  ): Promise<void> {
    await this.pool.query(
      "update app.backup_runs set state=$2,artifact=coalesce($3,artifact),bytes=coalesce($4,bytes),sha256=coalesce($5,sha256),coverage=coalesce($6,coverage),error=$7,completed_at=case when $2 in ('complete','partial','failed','cancelled') then now() else null end where id=$1 and ($8::uuid is null or lease_id=$8)",
      [
        id,
        state,
        values.artifact ?? null,
        values.bytes?.toString() ?? null,
        values.sha256 ?? null,
        values.coverage ? JSON.stringify(values.coverage) : null,
        values.error ?? null,
        values.lease ?? null,
      ],
    );
  }
  async setDelivery(
    id: string,
    state: string,
    key: string | null,
    version: string | null,
    error: string | null,
  ): Promise<void> {
    await this.pool.query(
      "update app.backup_deliveries set state=$2,object_key=coalesce($3,object_key),version_id=coalesce($4,version_id),error=$5,verified_at=case when $2='complete' then now() else verified_at end where id=$1",
      [id, state, key, version, error],
    );
  }
  async event(message: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query(
      "insert into app.system_events(subsystem,level,message,data) values('general','info',$1,$2)",
      [message, JSON.stringify(data)],
    );
  }
}
