import { z } from "zod";

const ColumnSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    type: z.string().max(200),
    generated: z.boolean(),
  })
  .strict();
export const HeaderSchema = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    installationId: z.uuid(),
    createdAt: z.iso.datetime(),
    masterKey: z.string().refine((v) => Buffer.from(v, "base64").length === 32),
    schema: z.record(z.string(), z.array(ColumnSchema).max(200)),
    migrations: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    environment: z.record(z.string(), z.unknown()),
  })
  .strict();
export const BlobSchema = z
  .object({
    entry: z.string().regex(/^blobs\/\d+$/),
    kind: z.enum(["attachment", "desktop", "ocr", "logs", "office", "remote"]),
    path: z.string().max(8192),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    identityId: z.uuid().optional(),
    sourceId: z.string().max(100).optional(),
  })
  .strict();
export const ManifestSchema = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    tables: z.record(
      z.string(),
      z
        .object({
          rows: z.number().int().nonnegative(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    blobs: z.array(BlobSchema).max(100_000),
    coverage: z.array(z.string().max(4096)).max(1000),
  })
  .strict();
