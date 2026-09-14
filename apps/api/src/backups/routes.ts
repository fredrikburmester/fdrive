import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { readBounded, withBackupWriter } from "@fdrive/backup";
import {
  BackupAttachmentInput,
  BackupDestinationInput,
  BackupRehearsal,
  BackupRunInput,
  BackupSchedule,
  BackupsResponse,
} from "@fdrive/contracts";
import type { Handler } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppRouteGroups, AppVariables } from "../app.js";
import type { PrincipalVariables } from "../auth/principal.js";
import { COOKIE_NAME } from "../auth/sessions.js";
import { ApiHttpError } from "../errors.js";
import { extractClientIp } from "../net.js";
import type { BackupModule } from "./module.js";

const BASE = "/system/backups";
const id = (value: string) => {
  const result = z.uuid().safeParse(value);
  if (!result.success) throw new ApiHttpError("bad_request", "Invalid backup ID");
  return result.data;
};
async function parsed<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (!request.body) throw new ApiHttpError("bad_request", "JSON body required");
  let text: string;
  try {
    text = (
      await readBounded(
        Readable.fromWeb(request.body as import("node:stream/web").ReadableStream<Uint8Array>),
        65_536,
      )
    ).toString();
  } catch {
    throw new ApiHttpError("payload_too_large", "Backup request exceeds its size limit");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiHttpError("bad_request", "Invalid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new ApiHttpError("bad_request", "Invalid backup settings");
  return result.data;
}
export function registerBackupRoutes(
  groups: AppRouteGroups,
  module: BackupModule,
  reauthenticate: (
    accountId: string,
    identityId: string,
    credential: Record<string, string>,
    ip: string,
  ) => Promise<void>,
  trustedProxyHops = 1,
): void {
  const router = groups.authed;
  const fresh = new Map<string, number>();
  router.use(`${BASE}/*`, async (c, next) => {
    if (c.req.header("authorization") || !getCookie(c, COOKIE_NAME))
      throw new ApiHttpError("forbidden", "An owner browser session is required");
    if (!(await module.store.owner(c.get("principal").accountId)))
      throw new ApiHttpError("forbidden", "Only the installation owner can manage backups");
    if (!module.enabled)
      throw new ApiHttpError(
        "unsupported",
        "Configure persistent backup storage to enable backups",
      );
    c.header("Cache-Control", "no-store");
    const sensitive = c.req.method !== "GET" || c.req.path.endsWith("/download");
    const cookie = getCookie(c, COOKIE_NAME) as string;
    if (sensitive && !c.req.path.endsWith("/unlock") && (fresh.get(cookie) ?? 0) < Date.now())
      throw new ApiHttpError("reauth_required", "Confirm your password to manage backups");
    await next();
    if (sensitive && c.res.ok)
      await module.store.event("Backup administration", {
        actor: c.get("principal").accountId,
        method: c.req.method,
        path: c.req.path,
      });
  });
  // The collection route needs the same owner check (Hono's wildcard is used for both).
  router.get(BASE, async (c) => {
    const config = await module.store.configuration();
    const destinations = await module.store.destinations();
    const attachments = await module.store.attachments();
    const runs = await Promise.all(
      (await module.store.runs()).map(async (run) => ({
        id: run.id,
        createdAt: run.created_at.toISOString(),
        completedAt: run.completed_at?.toISOString() ?? null,
        state: run.state,
        bytes: run.bytes,
        sha256: run.sha256,
        error: run.error,
        pinned: run.pinned,
        coverage: run.coverage,
        downloadable: !!run.artifact,
        verifiedAt: run.verified_at?.toISOString() ?? null,
        verificationRequested: run.verification_requested,
        verificationError: run.verification_error,
        deliveries: (await module.store.deliveries(run.id)).map((delivery) => ({
          destinationId: delivery.destination_id,
          name: delivery.name,
          state: delivery.state,
          error: delivery.error,
          verifiedAt: delivery.verified_at?.toISOString() ?? null,
          retentionUntil: delivery.retention_until?.toISOString() ?? null,
        })),
      })),
    );
    const operationStatus = await module.engine.operations.status();
    const inventories = await module.engine.operations.inventories(runs.map((run) => run.id));
    return c.json(
      BackupsResponse.parse({
        enabled: module.enabled,
        owner: true,
        ...operationStatus,
        installationId: config.installation_id,
        recipient: config.recipient,
        keyConfirmed: config.confirmed,
        schedule: config.schedule,
        nextRunAt: config.next_run_at?.toISOString() ?? null,
        restored: config.restored,
        destinations: destinations.map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type,
          location:
            row.type === "s3"
              ? `${row.config.bucket}/${row.config.prefix}`
              : String(row.config.prefix),
          enabled: row.enabled,
          testedAt: row.tested_at?.toISOString() ?? null,
          schedule: row.config.schedule ?? null,
          nextRunAt: row.config.nextRun ?? null,
          retainedProbe: row.config.retainedProbe ?? null,
        })),
        attachments: attachments.map((row) => ({
          id: row.id,
          versionId: row.version_id,
          label: row.label,
          filename: row.filename,
          sourceDate: row.source_date?.toISOString() ?? null,
          notes: row.notes,
          uploadedAt: row.uploaded_at.toISOString(),
          bytes: row.bytes,
          sha256: row.sha256,
          lastCapturedBackupId:
            runs.find(
              (run) =>
                run.state === "complete" &&
                inventories[run.id]?.attachmentVersions.includes(row.version_id),
            )?.id ?? null,
          lastCapturedAt:
            runs.find(
              (run) =>
                run.state === "complete" &&
                inventories[run.id]?.attachmentVersions.includes(row.version_id),
            )?.createdAt ?? null,
        })),
        runs,
      }),
    );
  });
  router.post(`${BASE}/unlock`, async (c) => {
    fresh.delete(getCookie(c, COOKIE_NAME) as string);
    const body = await parsed(
      c.req.raw,
      z.object({ credential: z.record(z.string(), z.string().max(4096)) }).strict(),
    );
    const principal = c.get("principal");
    await reauthenticate(
      principal.accountId,
      principal.identityId,
      body.credential,
      extractClientIp(c, trustedProxyHops),
    );
    for (const [key, expiry] of fresh) if (expiry < Date.now()) fresh.delete(key);
    if (fresh.size >= 1000) throw new ApiHttpError("rate_limited", "Too many backup sessions");
    fresh.set(getCookie(c, COOKIE_NAME) as string, Date.now() + 600_000);
    return c.json({ ok: true });
  });
  router.post(`${BASE}/key`, async (c) => {
    const body = await parsed(c.req.raw, z.object({ recipient: z.string().max(1000) }).strict());
    return c.json({ challenge: await module.engine.challenge(body.recipient) });
  });
  router.post(`${BASE}/estimate`, async (c) =>
    c.json({ id: await module.engine.operations.requestEstimate() }, 202),
  );
  router.post(`${BASE}/rehearsal`, async (c) => {
    await module.engine.operations.recordRehearsal(await parsed(c.req.raw, BackupRehearsal));
    return c.json({ ok: true });
  });
  router.post(`${BASE}/key/confirm`, async (c) => {
    const body = await parsed(c.req.raw, z.object({ proof: z.string().max(200) }).strict());
    await module.engine.confirm(body.proof);
    return c.json({ ok: true });
  });
  router.put(`${BASE}/schedule`, async (c) => {
    await module.store.setSchedule(await parsed(c.req.raw, BackupSchedule), new Date());
    return c.json({ ok: true });
  });
  router.post(`${BASE}/runs`, async (c) => {
    const request = await parsed(c.req.raw, BackupRunInput);
    return c.json({ id: await module.engine.queue(c.get("principal").accountId, request) }, 202);
  });
  router.post(`${BASE}/runs/:id/cancel`, async (c) => {
    const key = id(c.req.param("id"));
    const run = await module.store.run(key);
    if (!run || !["queued", "capturing", "transferring"].includes(run.state))
      throw new ApiHttpError("conflict", "Backup is not running");
    await module.store.setRun(key, "cancelled");
    return c.json({ ok: true });
  });
  router.post(`${BASE}/runs/:id/retry`, async (c) => {
    const key = id(c.req.param("id"));
    const run = await module.store.run(key);
    if (!run?.artifact || !["partial", "failed"].includes(run.state))
      throw new ApiHttpError("conflict", "No retained archive to retry");
    await module.store.setRun(key, "queued");
    return c.json({ ok: true }, 202);
  });
  router.post(`${BASE}/runs/:id/verify`, async (c) => {
    const key = id(c.req.param("id"));
    await module.pool.query(
      "update app.backup_runs set verification_requested=true,verification_error=null where id=$1 and state in ('complete','partial')",
      [key],
    );
    return c.json({ ok: true }, 202);
  });
  router.put(`${BASE}/destinations/:id/schedule`, async (c) => {
    const body = await parsed(
      c.req.raw,
      z.object({ schedule: BackupSchedule.nullable() }).strict(),
    );
    await module.store.destinationSchedule(id(c.req.param("id")), body.schedule, new Date());
    return c.json({ ok: true });
  });
  router.put(`${BASE}/runs/:id/pin`, async (c) => {
    const body = await parsed(c.req.raw, z.object({ pinned: z.boolean() }).strict());
    await module.store.pin(id(c.req.param("id")), body.pinned);
    return c.json({ ok: true });
  });
  router.delete(`${BASE}/runs/:id`, async (c) => {
    await module.engine.remove(id(c.req.param("id")));
    return c.json({ ok: true });
  });
  router.get(`${BASE}/runs/:id/download`, async (c) => {
    const key = id(c.req.param("id"));
    const run = await module.store.run(key);
    if (!run?.artifact) throw new ApiHttpError("not_found", "Backup archive unavailable");
    const file = module.engine.artifact(key);
    const handle = await open(file, "r");
    const metadata = await handle.stat();
    let start = 0,
      end = metadata.size - 1;
    let partial = false;
    const range = c.req.header("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        await handle.close();
        return c.body(null, 416);
      }
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        end >= metadata.size
      ) {
        await handle.close();
        return c.body(null, 416);
      }
      partial = true;
    }
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="fdrive-${key}.fdrive.age"`);
    c.header("Accept-Ranges", "bytes");
    c.header("Content-Length", String(end - start + 1));
    if (partial) c.header("Content-Range", `bytes ${start}-${end}/${metadata.size}`);
    return c.body(
      Readable.toWeb(handle.createReadStream({ start, end })) as ReadableStream<Uint8Array>,
      partial ? 206 : 200,
    );
  });
  router.post(`${BASE}/destinations`, async (c) => {
    const record = await module.destinationRecord(await parsed(c.req.raw, BackupDestinationInput));
    await module.engine.testDestination(record);
    return c.json({ id: record.id }, 201);
  });
  router.put(`${BASE}/destinations/:id`, async (c) => {
    const record = await module.destinationRecord(
      await parsed(c.req.raw, BackupDestinationInput),
      id(c.req.param("id")),
    );
    await module.engine.testDestination(record);
    return c.json({ id: record.id });
  });
  router.post(`${BASE}/destinations/:id/test`, async (c) => {
    const record = await module.store.destination(id(c.req.param("id")));
    if (!record) throw new ApiHttpError("not_found", "Backup destination unavailable");
    await module.engine.testDestination(record);
    return c.json({ ok: true });
  });
  router.delete(`${BASE}/destinations/:id`, async (c) => {
    await module.store.deleteDestination(id(c.req.param("id")));
    return c.json({ ok: true });
  });
  const upload: Handler<{ Variables: AppVariables & PrincipalVariables }> = async (c) => {
    const metadata = c.req.header("x-backup-metadata");
    if (!metadata || metadata.length > 16_000)
      throw new ApiHttpError("bad_request", "Configuration metadata required");
    let input: z.infer<typeof BackupAttachmentInput>;
    try {
      input = BackupAttachmentInput.parse(JSON.parse(Buffer.from(metadata, "base64").toString()));
    } catch {
      throw new ApiHttpError("bad_request", "Invalid configuration metadata");
    }
    if (!c.req.raw.body) throw new ApiHttpError("bad_request", "ZIP body required");
    const replacing = c.req.param("id");
    if (replacing && !(await module.store.attachment(id(replacing))))
      throw new ApiHttpError("not_found", "Configuration bundle unavailable");
    const key = await withBackupWriter(module.gatePool, () =>
      module.attachments.upload(
        input,
        Readable.fromWeb(c.req.raw.body as import("node:stream/web").ReadableStream<Uint8Array>),
        replacing ? id(replacing) : undefined,
      ),
    );
    return c.json({ id: key }, 201);
  };
  router.post(`${BASE}/attachments`, upload);
  router.put(`${BASE}/attachments/:id`, upload);
  router.get(`${BASE}/attachments/:id/download`, async (c) => {
    const row = await module.store.attachment(id(c.req.param("id")));
    if (!row) throw new ApiHttpError("not_found", "Configuration bundle unavailable");
    c.header("Content-Type", "application/zip");
    c.header(
      "Content-Disposition",
      `attachment; filename="configuration.zip"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    );
    c.header("Content-Length", row.bytes);
    return c.body(
      Readable.toWeb(await module.attachments.download(row)) as ReadableStream<Uint8Array>,
    );
  });
  router.delete(`${BASE}/attachments/:id`, async (c) => {
    await withBackupWriter(module.gatePool, () =>
      module.store.deleteAttachment(id(c.req.param("id"))),
    );
    return c.json({ ok: true });
  });
}
