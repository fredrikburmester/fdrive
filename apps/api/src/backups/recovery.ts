import { randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type Inspection,
  inspectArchive,
  limitBytes,
  readBounded,
  restoreArchive,
  type SecretCodec,
} from "@fdrive/backup";
import { Hono } from "hono";
import type { Pool } from "pg";
import { z } from "zod";
import type { AppHono } from "../app.js";
import { open, parseMasterKey, seal } from "../auth/crypto.js";
import type { AppConfig } from "../config.js";

export function restoreOptions(
  config: AppConfig,
  pool: Pool,
  file: string,
  identity: string,
  stateDirectory: string,
) {
  const master = parseMasterKey(config.fdriveMasterKey);
  const secrets: SecretCodec = {
    open: (bytes, context) => open(master, bytes, context),
    seal: (bytes, context) => seal(master, bytes, context),
  };
  return {
    pool,
    file,
    identity,
    stateDirectory,
    secrets,
    reseal: (bytes: Uint8Array, context: string, source: string) =>
      seal(master, open(parseMasterKey(source), bytes, context), context),
  };
}
export function recoveryPreview(inspection: Inspection) {
  return {
    id: inspection.header.id,
    installationId: inspection.header.installationId,
    createdAt: inspection.header.createdAt,
    tables: Object.fromEntries(
      Object.entries(inspection.manifest.tables).map(([table, value]) => [table, value.rows]),
    ),
    blobs: inspection.manifest.blobs.map(({ kind, path, size, identityId, sourceId }) => ({
      kind,
      path,
      size,
      identityId,
      sourceId,
    })),
    coverage: inspection.manifest.coverage,
    dependencies: [
      "Ordinary files and live fileserver configuration require separate backups.",
      "External editor sessions and device-only changes are outside this backup.",
      "Uploaded ZIPs preserve their uploaded version; restore them using the external system's procedure.",
    ],
  };
}
export function recoveryIdentity(text: string): string {
  const key = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^AGE-SECRET-KEY-/.test(line));
  if (!key || key.length > 1000) throw Error("Recovery kit does not contain an age identity");
  return key;
}
/** Deliberately separate from normal composition: no providers, sessions, outboxes or workers. */
export function createRecoveryApp(
  config: AppConfig,
  pool: Pool,
  paused = false,
): { app: AppHono; close: () => Promise<void> } {
  if (paused) {
    const app: AppHono = new Hono();
    app.get("/api/v1/health", (c) => c.json({ ok: true, maintenance: true }));
    app.all("*", (c) =>
      c.json(
        {
          error: {
            kind: "setup_required",
            message:
              "Restore is staged. Review and resume with the host backup CLI; workers remain paused.",
          },
        },
        503,
      ),
    );
    return { app, close: () => pool.end() };
  }
  if (
    !config.fdriveSetupToken ||
    config.fdriveSetupToken.length < 24 ||
    !config.fdriveBackupStateDir
  )
    throw Error(
      "Recovery requires FDRIVE_SETUP_TOKEN (24+ characters) and FDRIVE_BACKUP_STATE_DIR",
    );
  const app: AppHono = new Hono();
  const token = Buffer.from(config.fdriveSetupToken);
  const expires = Date.now() + 60 * 60_000;
  const directory = join(config.fdriveBackupStateDir, `bootstrap-${randomUUID()}`);
  let job: {
    id: string;
    state: string;
    file: string;
    identity: string;
    preview: ReturnType<typeof recoveryPreview> | null;
    error: string | null;
  } | null = null;
  let task: Promise<void> | null = null;
  const expiry = setTimeout(() => {
    if (job) job.identity = "";
    token.fill(0);
  }, 60 * 60_000);
  expiry.unref();
  app.get("/api/v1/health", (c) => c.json({ ok: true, maintenance: true }));
  app.use("/api/v1/recovery/*", async (c, next) => {
    const supplied = Buffer.from(c.req.header("x-fdrive-setup-token") ?? "");
    if (
      Date.now() > expires ||
      supplied.length !== token.length ||
      !timingSafeEqual(token, supplied)
    )
      return c.json(
        { error: { kind: "unauthorized", message: "A current host recovery token is required" } },
        401,
      );
    if (c.req.header("x-requested-with") !== "fdrive")
      return c.json(
        { error: { kind: "forbidden", message: "Recovery request marker required" } },
        403,
      );
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/api/v1/recovery/status", (c) =>
    c.json({
      paused,
      job: job ? { id: job.id, state: job.state, preview: job.preview, error: job.error } : null,
    }),
  );
  app.post("/api/v1/recovery/archive", async (c) => {
    if (paused || task)
      return c.json(
        {
          error: {
            kind: "conflict",
            message: "Recovery is already active; use the CLI to review the restored installation",
          },
        },
        409,
      );
    if (!c.req.raw.body)
      return c.json({ error: { kind: "bad_request", message: "Archive required" } }, 400);
    if (job) {
      job.identity = "";
      await rm(job.file, { force: true });
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const space = await statfs(directory);
    const id = randomUUID();
    const file = join(directory, `${id}.age`);
    const current = { id, state: "uploading", file, identity: "", preview: null, error: null };
    job = current;
    // Upload streams straight to private ciphertext storage; no multipart buffering.
    task = pipeline(
      Readable.fromWeb(c.req.raw.body as import("node:stream/web").ReadableStream<Uint8Array>),
      limitBytes(Math.min(1024 ** 4, Math.max(0, space.bavail * space.bsize - 128 * 1024 * 1024))),
      createWriteStream(file, { flags: "wx", mode: 0o600 }),
    );
    try {
      await task;
      current.state = "uploaded";
      return c.json({ id }, 201);
    } catch {
      job = null;
      await rm(file, { force: true });
      throw Error("Archive upload failed");
    } finally {
      task = null;
    }
  });
  app.post("/api/v1/recovery/inspect", async (c) => {
    if (task || !job || job.state !== "uploaded" || !c.req.raw.body)
      return c.json({ error: { kind: "conflict", message: "Upload an archive first" } }, 409);
    const bytes = await readBounded(
      Readable.fromWeb(c.req.raw.body as import("node:stream/web").ReadableStream<Uint8Array>),
      4096,
    );
    const body = z
      .object({ key: z.string().max(2000) })
      .strict()
      .parse(JSON.parse(bytes.toString()));
    const current = job;
    current.identity = recoveryIdentity(body.key);
    current.state = "inspecting";
    task = inspectArchive(current.file, current.identity)
      .then((inspection) => {
        current.preview = recoveryPreview(inspection);
        current.state = "ready";
      })
      .catch(() => {
        current.identity = "";
        current.state = "uploaded";
        current.error =
          "Archive could not be verified. Check the recovery key and archive integrity.";
      })
      .finally(() => {
        task = null;
      });
    return c.json({ id: current.id }, 202);
  });
  app.post("/api/v1/recovery/apply", async (c) => {
    if (task || !job || job.state !== "ready" || !job.preview || !c.req.raw.body)
      return c.json({ error: { kind: "conflict", message: "Inspect an archive first" } }, 409);
    const body = z
      .object({ snapshotId: z.uuid() })
      .strict()
      .parse(
        JSON.parse(
          (
            await readBounded(
              Readable.fromWeb(
                c.req.raw.body as import("node:stream/web").ReadableStream<Uint8Array>,
              ),
              4096,
            )
          ).toString(),
        ),
      );
    if (body.snapshotId !== job.preview.id)
      return c.json(
        { error: { kind: "bad_request", message: "Snapshot confirmation does not match" } },
        400,
      );
    const current = job;
    current.state = "restoring";
    task = restoreArchive(
      restoreOptions(
        config,
        pool,
        current.file,
        current.identity,
        config.fdriveBackupStateDir as string,
      ),
    )
      .then(() => {
        current.state = "restored";
      })
      .catch(() => {
        current.state = "uploaded";
        current.error =
          "Restore failed. The target must be empty, migrated with the matching release, and have enough free storage.";
      })
      .finally(() => {
        current.identity = "";
        task = null;
      });
    return c.json({ id: current.id }, 202);
  });
  app.notFound((c) =>
    c.json(
      {
        error: {
          kind: "setup_required",
          message: "Recovery mode: open /restore. Normal fdrive services are paused.",
        },
      },
      503,
    ),
  );
  app.onError((_error, c) =>
    c.json(
      {
        error: {
          kind: "bad_request",
          message: "Recovery request failed; check the supplied settings and available storage.",
        },
      },
      400,
    ),
  );
  return {
    app,
    async close() {
      clearTimeout(expiry);
      token.fill(0);
      await task;
      if (job) job.identity = "";
      await rm(directory, { recursive: true, force: true });
      await pool.end();
    },
  };
}
