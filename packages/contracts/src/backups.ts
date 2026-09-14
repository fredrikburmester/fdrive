import { z } from "zod";

export const BackupSchedule = z
  .object({
    frequency: z.enum(["manual", "hourly", "daily", "weekly"]).default("manual"),
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, "Invalid timezone"),
    hour: z.number().int().min(0).max(23).default(3),
    daily: z.number().int().min(1).max(365).default(7),
    weekly: z.number().int().min(0).max(104).default(4),
    monthly: z.number().int().min(0).max(120).default(12),
  })
  .strict();
export type BackupSchedule = z.infer<typeof BackupSchedule>;
const endpoint = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["https:", "http:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}, "Use an HTTP(S) endpoint without credentials, query or fragment");
const prefix = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part !== ".." && part !== "."),
    "Invalid backup path",
  );
export const BackupDestinationInput = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("s3"),
      name: z.string().trim().min(1).max(120),
      endpoint,
      region: z.string().min(1).max(100),
      bucket: z.string().min(3).max(63),
      prefix,
      pathStyle: z.boolean().default(false),
      accessKeyId: z.string().min(1).max(500),
      secretAccessKey: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal("provider"),
      name: z.string().trim().min(1).max(120),
      providerId: z.uuid(),
      prefix,
      credential: z.record(z.string(), z.string().max(4096)),
    })
    .strict(),
]);
export type BackupDestinationInput = z.infer<typeof BackupDestinationInput>;
export const BackupAttachmentInput = z
  .object({
    label: z.string().trim().min(1).max(120),
    filename: z.string().min(1).max(255),
    sourceDate: z.iso.datetime().nullable().default(null),
    notes: z.string().max(4000).default(""),
  })
  .strict();
export const BackupRunInput = z
  .object({
    destinationIds: z.array(z.uuid()).max(20).default([]),
    metadataOnly: z.boolean().default(false),
  })
  .strict();
export const BackupRunSummary = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  state: z.enum([
    "queued",
    "capturing",
    "transferring",
    "complete",
    "partial",
    "failed",
    "cancelled",
  ]),
  bytes: z.string(),
  sha256: z.string().nullable(),
  error: z.string().nullable(),
  pinned: z.boolean(),
  coverage: z.array(z.string()),
  downloadable: z.boolean(),
  verifiedAt: z.string().nullable(),
  verificationRequested: z.boolean(),
  verificationError: z.string().nullable(),
  deliveries: z.array(
    z.object({
      destinationId: z.string(),
      name: z.string(),
      state: z.string(),
      error: z.string().nullable(),
      verifiedAt: z.string().nullable(),
      retentionUntil: z.string().nullable().optional(),
    }),
  ),
});
export const BackupEstimateJob = z.object({
  id: z.uuid(),
  state: z.enum(["pending", "complete", "failed"]),
  error: z.string().nullable(),
  result: z
    .object({
      estimatedAt: z.iso.datetime(),
      databaseBytes: z.string(),
      recoveryBytes: z.string(),
      uncompressedBytes: z.string(),
      retainedBytes: z.string(),
      transferAndReadbackBytes: z.string(),
      availableSpoolBytes: z.string(),
      coverage: z.array(z.string()),
    })
    .nullable(),
});
export type BackupEstimateJob = z.infer<typeof BackupEstimateJob>;
export const BackupRehearsal = z
  .object({
    sourceInstallationId: z.uuid(),
    snapshotId: z.uuid(),
    completedAt: z.iso.datetime(),
    migrations: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000),
    tableCount: z.number().int().nonnegative(),
    blobCount: z.number().int().nonnegative(),
    result: z.literal("passed"),
  })
  .strict();
export type BackupRehearsal = z.infer<typeof BackupRehearsal>;
export const BackupsResponse = z.object({
  enabled: z.boolean(),
  owner: z.boolean(),
  workerSeenAt: z.string().nullable().optional(),
  estimate: BackupEstimateJob.nullable().optional(),
  rehearsal: BackupRehearsal.nullable().optional(),
  installationId: z.string(),
  recipient: z.string().nullable(),
  keyConfirmed: z.boolean(),
  schedule: BackupSchedule,
  nextRunAt: z.string().nullable(),
  restored: z.boolean(),
  destinations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      type: z.string(),
      location: z.string(),
      enabled: z.boolean(),
      testedAt: z.string().nullable(),
      schedule: BackupSchedule.nullable(),
      nextRunAt: z.string().nullable(),
      retainedProbe: z
        .object({ name: z.string(), retentionUntil: z.string() })
        .nullable()
        .default(null),
    }),
  ),
  attachments: z.array(
    z.object({
      id: z.uuid(),
      versionId: z.uuid(),
      label: z.string(),
      filename: z.string(),
      sourceDate: z.string().nullable(),
      lastCapturedBackupId: z.string().nullable().optional(),
      lastCapturedAt: z.string().nullable().optional(),
      notes: z.string(),
      uploadedAt: z.string(),
      bytes: z.string(),
      sha256: z.string(),
    }),
  ),
  runs: z.array(BackupRunSummary),
});
export type BackupsResponse = z.infer<typeof BackupsResponse>;
export type BackupRunSummary = z.infer<typeof BackupRunSummary>;

export const BackupRecoveryStatus = z.object({
  paused: z.boolean(),
  job: z
    .object({
      id: z.string(),
      state: z.string(),
      error: z.string().nullable(),
      preview: z
        .object({
          id: z.string(),
          installationId: z.string(),
          createdAt: z.string(),
          tables: z.record(z.string(), z.number()),
          blobs: z.array(z.object({ kind: z.string(), path: z.string(), size: z.number() })),
          coverage: z.array(z.string()),
          dependencies: z.array(z.string()),
        })
        .nullable(),
    })
    .nullable(),
});
export type BackupRecoveryStatus = z.infer<typeof BackupRecoveryStatus>;
