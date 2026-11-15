import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { validateOfficeInfrastructure } from "./office/config.ts";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const NODE_ENVS = ["development", "production", "test"] as const;
const COOKIE_SECURE_MODES = ["auto", "true", "false"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type NodeEnv = (typeof NODE_ENVS)[number];
export type CookieSecureMode = (typeof COOKIE_SECURE_MODES)[number];

/** The ml service's units, each served below `FDRIVE_ML_URL` at its own path. */
export type MlUnit = "text" | "image" | "extract";

/** Where `unit` of the ml service is, or `undefined` when no ml service is configured. */
export function mlUnitUrl(
  config: Pick<AppConfig, "fdriveMlUrl">,
  unit: MlUnit,
): string | undefined {
  return config.fdriveMlUrl === undefined ? undefined : `${config.fdriveMlUrl}/${unit}`;
}

export interface AppConfig {
  readonly fdriveWorkerToken?: string | undefined;
  readonly fdriveOfficeProduct?: "onlyoffice" | "collabora" | undefined;
  readonly fdriveOfficeUrl?: string | undefined;
  readonly fdriveOfficePublicUrl?: string | undefined;
  readonly fdriveWopiUrl?: string | undefined;
  readonly fdriveOfficeMaxBytes?: number | undefined;
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  /** The folder fdrive serves as its storage, one home per user as `<root>/<username>`. */
  readonly fdriveStorageRoot: string;
  readonly fdriveMasterKey: string;
  readonly fdriveSessionTtlDays: number;
  /** Hard cap on a session's age since login; sliding expiry never extends past it. */
  readonly fdriveSessionMaxAgeDays: number;
  readonly fdriveCookieSecure: CookieSecureMode;
  /**
   * How many reverse-proxy hops in front of fdrive are trusted to append an
   * honest entry to `x-forwarded-for` (normally `1` for a single Caddy).
   * `extractClientIp` (`net.ts`) reads the entry that many hops from the
   * right of the header and falls back to the raw socket peer when the
   * header has fewer entries than this, so a spoofed leading hop is never
   * trusted as the client's IP.
   */
  readonly fdriveTrustedProxyHops: number;
  readonly nodeEnv: NodeEnv;
  /** Directory archive jobs spool temp files into. Defaults to the OS temp dir. */
  readonly fdriveTmpDir: string;
  /** Durable, private spool. Unset disables desktop writes. */
  readonly fdriveBackupStateDir?: string;
  readonly fdriveBackupSources?: { kind: "ocr" | "logs" | "office"; path: string }[];
  readonly fdriveBackupWorker?: boolean;
  readonly fdriveRestoreMode?: boolean;
  /** Days before acknowledged or cancelled Mac write backups are reclaimed. */
  /** Total bytes a single archive/extract job may read before it fails. */
  readonly fdriveJobMaxBytes: number;
  /**
   * Cap on the compressed bytes `GET /fs/archive-entries` reads while
   * streaming a tar-family archive's entries. Unused for zip, whose two
   * Range reads are already bounded by its own metadata sizes. Optional
   * (unlike `fdriveJobMaxBytes`) so a hand-built `AppConfig` value outside
   * `loadConfig` (as some tests construct) does not have to name it;
   * `loadConfig` itself always sets it. See `DEFAULT_ARCHIVE_PEEK_MAX_BYTES`.
   */
  readonly fdriveArchivePeekMaxBytes?: number | undefined;
  /**
   * Cap on a JSON request body's bytes for `fs/routes.ts`'s `parseBody`
   * (mkdir, move, copy, rename, delete, zip). See `DEFAULT_JSON_MAX_BYTES`.
   */
  readonly fdriveJsonMaxBytes: number;
  /**
   * Cap on a public share upload's bytes (`PUT /public/shares/:id/upload`),
   * checked against `Content-Length` and enforced while streaming so an
   * absent or dishonest header cannot bypass it. See
   * `DEFAULT_SHARE_UPLOAD_MAX_BYTES`.
   */
  readonly fdriveShareUploadMaxBytes: number;
  /**
   * Base URL of the ml service, whose units sit below it (`mlUnitUrl`).
   * `undefined` disables semantic search, image search and document
   * extraction.
   */
  readonly fdriveMlUrl: string | undefined;
  /** Directory the indexer writes thumbnails into. `undefined` disables thumbnails. */
  readonly fdriveThumbsDir: string | undefined;
  /** Overrides the randomly generated setup token. Mainly for tests and scripted installs. */
  readonly fdriveSetupToken: string | undefined;
  /**
   * Base URL of the indexer's internal HTTP API. `undefined` disables the
   * System > Indexer page and MCP document extraction. MCP still reads UTF-8 directly.
   */
  readonly fdriveIndexerUrl: string | undefined;
  /** Base URL of the OCR service's internal HTTP API. `undefined` disables the System > OCR page. */
  readonly fdriveOcrUrl: string | undefined;
}

/** Default cap on the bytes a single archive job may read: 10 GiB. */
export const DEFAULT_JOB_MAX_BYTES = 10 * 1024 * 1024 * 1024;

/** Default cap on the bytes `GET /fs/archive-entries` reads for a tar-family archive: 512 MiB. */
export const DEFAULT_ARCHIVE_PEEK_MAX_BYTES = 512 * 1024 * 1024;

/** Default cap on a JSON request body's bytes: 1 MiB. */
export const DEFAULT_JSON_MAX_BYTES = 1024 * 1024;

/** Default cap on a public share upload's bytes: 10 GiB. */
export const DEFAULT_SHARE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * True when `value` parses as an absolute URL whose protocol is http or
 * https.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * True when `value` is valid base64 that decodes to exactly 32 bytes.
 */
export function isBase64Of32Bytes(value: string): boolean {
  if (!BASE64_PATTERN.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").length === 32;
}

/**
 * Returns `value` when it is a non-empty string, otherwise `fallback`. Used
 * to apply defaults to environment variables before the rest of the schema
 * validates the (now always-present) string.
 */
export function withDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Returns `value` when it is a non-empty string, otherwise `undefined`. Used
 * for genuinely optional environment variables, so an empty string in the
 * environment behaves the same as the variable being unset.
 */
export function undefinedWhenEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const envSchema = z.object({
  FDRIVE_WORKER_TOKEN: z.preprocess(undefinedWhenEmpty, z.string().min(1).optional()),
  FDRIVE_OFFICE_PRODUCT: z.preprocess(
    undefinedWhenEmpty,
    z.enum(["onlyoffice", "collabora"]).optional(),
  ),
  FDRIVE_OFFICE_URL: z.preprocess(undefinedWhenEmpty, z.string().optional()),
  FDRIVE_OFFICE_PUBLIC_URL: z.preprocess(undefinedWhenEmpty, z.string().optional()),
  FDRIVE_WOPI_URL: z.preprocess(undefinedWhenEmpty, z.string().optional()),
  FDRIVE_OFFICE_MAX_BYTES: z.preprocess(
    (v) => withDefault(v, "104857600"),
    z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(1073741824)),
  ),
  PORT: z.preprocess(
    (value) => withDefault(value, "3001"),
    z
      .string()
      .regex(/^\d+$/, "must be a positive integer")
      .transform(Number)
      .pipe(z.number().int().min(1).max(65535)),
  ),
  HOST: z.preprocess((value) => withDefault(value, "0.0.0.0"), z.string().min(1)),
  LOG_LEVEL: z.preprocess((value) => withDefault(value, "info"), z.enum(LOG_LEVELS)),
  DATABASE_URL: z.string().min(1, "is required"),
  FDRIVE_STORAGE_ROOT: z
    .string()
    .min(1, "is required")
    .refine((value) => isAbsolute(value), { message: "must be an absolute path" }),
  FDRIVE_MASTER_KEY: z
    .string()
    .min(1, "is required")
    .refine((value) => isBase64Of32Bytes(value), {
      message: "must be base64-encoded 32 bytes",
    }),
  FDRIVE_SESSION_TTL_DAYS: z.preprocess(
    (value) => withDefault(value, "30"),
    z
      .string()
      .regex(/^\d+$/, "must be a positive integer")
      .transform(Number)
      .pipe(z.number().int().min(1)),
  ),
  FDRIVE_SESSION_MAX_AGE_DAYS: z.preprocess(
    (value) => withDefault(value, "90"),
    z
      .string()
      .regex(/^\d+$/, "must be a positive integer")
      .transform(Number)
      .pipe(z.number().int().min(1)),
  ),
  FDRIVE_COOKIE_SECURE: z.preprocess(
    (value) => withDefault(value, "auto"),
    z.enum(COOKIE_SECURE_MODES),
  ),
  FDRIVE_TRUSTED_PROXY_HOPS: z.preprocess(
    (value) => withDefault(value, "1"),
    z
      .string()
      .regex(/^\d+$/, "must be a non-negative integer")
      .transform(Number)
      .pipe(z.number().int().min(0)),
  ),
  NODE_ENV: z.preprocess((value) => withDefault(value, "development"), z.enum(NODE_ENVS)),
  FDRIVE_TMP_DIR: z.preprocess((value) => withDefault(value, tmpdir()), z.string().min(1)),
  FDRIVE_BACKUP_STATE_DIR: z.preprocess(undefinedWhenEmpty, z.string().startsWith("/").optional()),
  FDRIVE_RESTORE_MODE: z.preprocess(
    (value) => withDefault(value, "false"),
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ),
  FDRIVE_BACKUP_WORKER: z.preprocess(
    (value) => withDefault(value, "false"),
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ),
  FDRIVE_BACKUP_SOURCES: z.preprocess(
    (value) => {
      if (value === undefined || value === "") return [];
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    },
    z
      .array(
        z
          .object({ kind: z.enum(["ocr", "logs", "office"]), path: z.string().startsWith("/") })
          .strict(),
      )
      .max(20),
  ),
  FDRIVE_JOB_MAX_BYTES: z.preprocess(
    (value) => withDefault(value, String(DEFAULT_JOB_MAX_BYTES)),
    z
      .string()
      .regex(/^\d+$/, "must be a positive integer")
      .transform(Number)
      .pipe(z.number().int().min(1)),
  ),
  FDRIVE_JSON_MAX_BYTES: z.preprocess(
    (value) => withDefault(value, String(DEFAULT_JSON_MAX_BYTES)),
    z
      .string()
      .regex(/^\d+$/, "must be a positive integer")
      .transform(Number)
      .pipe(z.number().int().min(1)),
  ),
  FDRIVE_ARCHIVE_PEEK_MAX_BYTES: z.preprocess(
    (value) => withDefault(value, String(DEFAULT_ARCHIVE_PEEK_MAX_BYTES)),
    z
      .string()
      .regex(/^\d+$/, "must be a positive integer")
      .transform(Number)
      .pipe(z.number().int().min(1)),
  ),
  FDRIVE_SHARE_UPLOAD_MAX_BYTES: z.preprocess(
    (value) => withDefault(value, String(DEFAULT_SHARE_UPLOAD_MAX_BYTES)),
    z
      .string()
      .regex(/^\d+$/, "must be a positive integer")
      .transform(Number)
      .pipe(z.number().int().min(1)),
  ),
  FDRIVE_ML_URL: z.preprocess(
    undefinedWhenEmpty,
    z
      .string()
      .optional()
      .refine((value) => value === undefined || isHttpUrl(value), {
        message: "must be an http(s) URL",
      })
      .transform((value) => value?.replace(/\/+$/, "")),
  ),
  FDRIVE_THUMBS_DIR: z.preprocess(undefinedWhenEmpty, z.string().min(1).optional()),
  FDRIVE_SETUP_TOKEN: z.preprocess(
    (value) => (typeof value === "string" && value.length === 0 ? undefined : value),
    z.string().min(1).optional(),
  ),
  FDRIVE_INDEXER_URL: z.preprocess(
    undefinedWhenEmpty,
    z
      .string()
      .min(1)
      .optional()
      .refine((value) => value === undefined || isHttpUrl(value), {
        message: "must be an http(s) URL",
      }),
  ),
  FDRIVE_OCR_URL: z.preprocess(
    undefinedWhenEmpty,
    z
      .string()
      .min(1)
      .optional()
      .refine((value) => value === undefined || isHttpUrl(value), {
        message: "must be an http(s) URL",
      }),
  ),
});

/**
 * Every environment variable key `envSchema` reads. `config-keys.ts` holds a
 * documented table describing each of these keys (description, default,
 * example, whether it is a secret, and which subsystem it belongs to); a
 * round-trip test compares this list against that table's keys so the two
 * can never drift silently.
 */
export function configEnvKeys(): readonly string[] {
  return Object.keys(envSchema.shape);
}

/**
 * Parses process-environment-shaped input into a typed `AppConfig`. Throws
 * an `Error` whose message lists every invalid variable when validation
 * fails, rather than stopping at the first problem.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    throw new Error(`Invalid environment configuration:\n${problems.join("\n")}`);
  }

  const parsed = result.data;

  const config: AppConfig = {
    fdriveWorkerToken: parsed.FDRIVE_WORKER_TOKEN,
    fdriveOfficeProduct: parsed.FDRIVE_OFFICE_PRODUCT,
    fdriveOfficeUrl: parsed.FDRIVE_OFFICE_URL,
    fdriveOfficePublicUrl: parsed.FDRIVE_OFFICE_PUBLIC_URL,
    fdriveWopiUrl: parsed.FDRIVE_WOPI_URL,
    fdriveOfficeMaxBytes: parsed.FDRIVE_OFFICE_MAX_BYTES,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    fdriveStorageRoot: parsed.FDRIVE_STORAGE_ROOT,
    fdriveMasterKey: parsed.FDRIVE_MASTER_KEY,
    fdriveSessionTtlDays: parsed.FDRIVE_SESSION_TTL_DAYS,
    fdriveSessionMaxAgeDays: parsed.FDRIVE_SESSION_MAX_AGE_DAYS,
    fdriveCookieSecure: parsed.FDRIVE_COOKIE_SECURE,
    fdriveTrustedProxyHops: parsed.FDRIVE_TRUSTED_PROXY_HOPS,
    nodeEnv: parsed.NODE_ENV,
    fdriveTmpDir: parsed.FDRIVE_TMP_DIR,
    ...(parsed.FDRIVE_BACKUP_STATE_DIR
      ? { fdriveBackupStateDir: parsed.FDRIVE_BACKUP_STATE_DIR }
      : {}),
    fdriveBackupSources: parsed.FDRIVE_BACKUP_SOURCES,
    fdriveRestoreMode: parsed.FDRIVE_RESTORE_MODE,
    fdriveBackupWorker: parsed.FDRIVE_BACKUP_WORKER,
    fdriveJobMaxBytes: parsed.FDRIVE_JOB_MAX_BYTES,
    fdriveArchivePeekMaxBytes: parsed.FDRIVE_ARCHIVE_PEEK_MAX_BYTES,
    fdriveJsonMaxBytes: parsed.FDRIVE_JSON_MAX_BYTES,
    fdriveShareUploadMaxBytes: parsed.FDRIVE_SHARE_UPLOAD_MAX_BYTES,
    fdriveMlUrl: parsed.FDRIVE_ML_URL,
    fdriveThumbsDir: parsed.FDRIVE_THUMBS_DIR,
    fdriveSetupToken: parsed.FDRIVE_SETUP_TOKEN,
    fdriveIndexerUrl: parsed.FDRIVE_INDEXER_URL,
    fdriveOcrUrl: parsed.FDRIVE_OCR_URL,
  };
  validateOfficeInfrastructure(config);
  return config;
}
