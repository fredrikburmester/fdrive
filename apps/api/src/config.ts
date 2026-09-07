import { tmpdir } from "node:os";
import { normalizePath } from "@fdrive/core";
import { z } from "zod";
import { officeConfig } from "./office/config.ts";
import { type OfficeEditRule, parseOfficeEditRules } from "./office/edit-policy.ts";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const NODE_ENVS = ["development", "production", "test"] as const;
const COOKIE_SECURE_MODES = ["auto", "true", "false"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type NodeEnv = (typeof NODE_ENVS)[number];
export type CookieSecureMode = (typeof COOKIE_SECURE_MODES)[number];

/**
 * One configured index root: `name` must match the root name segment of
 * `FDRIVE_HOME_TEMPLATE` (`core`'s `parseHomeTemplate`/`scopesFor`),
 * `sftpgoPath` is how the path looks inside SFTPGo (its `home_dir` or a
 * mapped virtual folder's target), and `indexerPath` is where the same
 * directory is bind-mounted in the indexer container. fdrive's API only
 * ever needs `name`; the other two fields exist so operators can see the
 * whole mapping in one place and the indexer can read the same env var.
 */
export interface IndexRootConfig {
  readonly name: string;
  readonly sftpgoPath: string;
  readonly indexerPath: string;
}

export interface AppConfig {
  readonly fdriveOfficeEditRules?: readonly OfficeEditRule[];
  readonly fdriveOfficeProduct?: "onlyoffice" | "collabora" | undefined;
  readonly fdriveOfficeUrl?: string | undefined;
  readonly fdriveOfficePublicUrl?: string | undefined;
  readonly fdriveWopiUrl?: string | undefined;
  readonly fdriveOfficeMaxBytes?: number | undefined;
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  /**
   * The SFTPGo base URL, when configured by environment. Undefined means
   * the connection must come from `settings` (configured through `/setup`
   * or the admin connection page) or setup is still required. See
   * `src/connection/store.ts`.
   */
  readonly sftpgoUrl: string | undefined;
  readonly fdriveMasterKey: string;
  readonly fdriveHomeTemplate: string;
  readonly fdriveSessionTtlDays: number;
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
  readonly fdrivePublicUrl: string | undefined;
  readonly nodeEnv: NodeEnv;
  readonly fdriveAutoMigrate: boolean;
  /** Directory archive jobs spool temp files into. Defaults to the OS temp dir. */
  readonly fdriveTmpDir: string;
  /** Total bytes a single archive/extract job may read before it fails. */
  readonly fdriveJobMaxBytes: number;
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
  /** Configured index roots (search, thumbnails). `null` when search is unavailable. */
  readonly fdriveIndexRoots: readonly IndexRootConfig[] | null;
  /** Base URL of the TEI embeddings service. `undefined` disables semantic search. */
  readonly fdriveEmbedUrl: string | undefined;
  /** Directory the indexer writes thumbnails into. `undefined` disables thumbnails. */
  readonly fdriveThumbsDir: string | undefined;
  /** SFTPGo usernames that are always treated as admins, in addition to `accounts.is_admin`. */
  readonly fdriveAdminUsers: readonly string[];
  /** Overrides the randomly generated setup token. Mainly for tests and scripted installs. */
  readonly fdriveSetupToken: string | undefined;
  /**
   * Base URL of the indexer's internal HTTP API. `undefined` disables the
   * System > Indexer page and the MCP `read_file_text` tool.
   */
  readonly fdriveIndexerUrl: string | undefined;
  /** Base URL of the OCR service's internal HTTP API. `undefined` disables the System > OCR page. */
  readonly fdriveOcrUrl: string | undefined;
  /** Enables the MCP write tools (`create_folder`, `move_path`). Off by default. */
  readonly fdriveMcpWrites: boolean;
  /**
   * The storage provider's recycle folder virtual path (for example
   * `/.trash`), when the operator has set up the SFTPGo Event Manager
   * recycle-folder rule described in `docs/DEVELOPMENT.md`. `null` means no
   * trash capability: deletes stay permanent.
   */
  readonly fdriveSftpgoTrashPath: string | null;
  /** Informational retention window shown in the Trash UI. fdrive never enforces it itself. */
  readonly fdriveSftpgoTrashRetentionHours: number | null;
}

/** Default cap on the bytes a single archive job may read: 10 GiB. */
export const DEFAULT_JOB_MAX_BYTES = 10 * 1024 * 1024 * 1024;

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

const indexRootConfigSchema = z.object({
  name: z.string().min(1),
  sftpgoPath: z.string().min(1),
  indexerPath: z.string().min(1),
});

/**
 * Parses `FDRIVE_INDEX_ROOTS`'s JSON array of `{ name, sftpgoPath,
 * indexerPath }`. Exported so its shape can be unit tested directly, in
 * addition to through `loadConfig`. Returns `null` for an absent value
 * (search stays unavailable); throws a plain `Error` describing the problem
 * for a present but invalid value, which `loadConfig` turns into one of its
 * aggregated issues.
 */
export function parseIndexRoots(value: string | undefined): IndexRootConfig[] | null {
  if (value === undefined) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("must be valid JSON");
  }

  const result = z.array(indexRootConfigSchema).min(1).safeParse(parsed);
  if (!result.success) {
    throw new Error("must be a non-empty array of { name, sftpgoPath, indexerPath }");
  }
  return result.data;
}

/**
 * Parses `FDRIVE_SFTPGO_TRASH_PATH`. Returns `null` for an absent value (no
 * trash capability); throws a plain `Error` for a present but invalid value
 * (not absolute, not already normalized, or the root itself), which
 * `loadConfig` turns into one of its aggregated issues.
 */
export function parseTrashPath(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  let normalized: string;
  try {
    normalized = normalizePath(value);
  } catch {
    throw new Error("must be a valid path");
  }
  if (normalized !== value || normalized === "/") {
    throw new Error('must be an absolute, normalized path other than the root, with no ".."');
  }
  return normalized;
}

/**
 * Splits a comma-separated list of SFTPGo usernames (`FDRIVE_ADMIN_USERS`)
 * into a trimmed, non-empty array. An empty or missing value yields an
 * empty array.
 */
export function parseAdminUsers(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((username) => username.trim())
    .filter((username) => username.length > 0);
}

const envSchema = z.object({
  FDRIVE_OFFICE_EDIT_RULES: z.preprocess(
    undefinedWhenEmpty,
    z
      .string()
      .optional()
      .transform((value, ctx) => {
        try {
          return parseOfficeEditRules(value);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "must be valid bounded Office edit policy JSON",
          });
          return z.NEVER;
        }
      }),
  ),
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
  SFTPGO_URL: z.preprocess(
    (value) => (typeof value === "string" && value.length === 0 ? undefined : value),
    z
      .string()
      .min(1)
      .optional()
      .refine((value) => value === undefined || isHttpUrl(value), {
        message: "must be an http(s) URL",
      }),
  ),
  FDRIVE_MASTER_KEY: z
    .string()
    .min(1, "is required")
    .refine((value) => isBase64Of32Bytes(value), {
      message: "must be base64-encoded 32 bytes",
    }),
  FDRIVE_HOME_TEMPLATE: z.preprocess(
    (value) => withDefault(value, "sftpgo:/{username}"),
    z.string().min(1),
  ),
  FDRIVE_SESSION_TTL_DAYS: z.preprocess(
    (value) => withDefault(value, "30"),
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
  FDRIVE_PUBLIC_URL: z.preprocess(
    (value) => (typeof value === "string" && value.length === 0 ? undefined : value),
    z
      .string()
      .min(1)
      .optional()
      .refine((value) => value === undefined || isHttpUrl(value), {
        message: "must be an http(s) URL",
      }),
  ),
  NODE_ENV: z.preprocess((value) => withDefault(value, "development"), z.enum(NODE_ENVS)),
  FDRIVE_AUTO_MIGRATE: z.preprocess(
    (value) => withDefault(value, "true"),
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ),
  FDRIVE_TMP_DIR: z.preprocess((value) => withDefault(value, tmpdir()), z.string().min(1)),
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
  FDRIVE_SHARE_UPLOAD_MAX_BYTES: z.preprocess(
    (value) => withDefault(value, String(DEFAULT_SHARE_UPLOAD_MAX_BYTES)),
    z
      .string()
      .regex(/^\d+$/, "must be a positive integer")
      .transform(Number)
      .pipe(z.number().int().min(1)),
  ),
  FDRIVE_INDEX_ROOTS: z.preprocess(
    undefinedWhenEmpty,
    z
      .string()
      .optional()
      .transform((value, ctx) => {
        try {
          return parseIndexRoots(value);
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: error instanceof Error ? error.message : "invalid FDRIVE_INDEX_ROOTS",
          });
          return z.NEVER;
        }
      }),
  ),
  FDRIVE_EMBED_URL: z.preprocess(
    undefinedWhenEmpty,
    z
      .string()
      .min(1)
      .optional()
      .refine((value) => value === undefined || isHttpUrl(value), {
        message: "must be an http(s) URL",
      }),
  ),
  FDRIVE_THUMBS_DIR: z.preprocess(undefinedWhenEmpty, z.string().min(1).optional()),
  FDRIVE_ADMIN_USERS: z.string().optional(),
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
  FDRIVE_MCP_WRITES: z.preprocess(
    (value) => withDefault(value, "false"),
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ),
  FDRIVE_SFTPGO_TRASH_PATH: z.preprocess(
    undefinedWhenEmpty,
    z
      .string()
      .optional()
      .transform((value, ctx) => {
        try {
          return parseTrashPath(value);
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: error instanceof Error ? error.message : "invalid FDRIVE_SFTPGO_TRASH_PATH",
          });
          return z.NEVER;
        }
      }),
  ),
  FDRIVE_SFTPGO_TRASH_RETENTION_HOURS: z.preprocess(
    undefinedWhenEmpty,
    z
      .string()
      .regex(/^\d+$/, "must be a positive integer")
      .optional()
      .transform((value) => (value === undefined ? null : Number(value)))
      .pipe(z.number().int().positive().nullable()),
  ),
});

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
    fdriveOfficeEditRules: parsed.FDRIVE_OFFICE_EDIT_RULES,
    fdriveOfficeProduct: parsed.FDRIVE_OFFICE_PRODUCT,
    fdriveOfficeUrl: parsed.FDRIVE_OFFICE_URL,
    fdriveOfficePublicUrl: parsed.FDRIVE_OFFICE_PUBLIC_URL,
    fdriveWopiUrl: parsed.FDRIVE_WOPI_URL,
    fdriveOfficeMaxBytes: parsed.FDRIVE_OFFICE_MAX_BYTES,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    sftpgoUrl: parsed.SFTPGO_URL,
    fdriveMasterKey: parsed.FDRIVE_MASTER_KEY,
    fdriveHomeTemplate: parsed.FDRIVE_HOME_TEMPLATE,
    fdriveSessionTtlDays: parsed.FDRIVE_SESSION_TTL_DAYS,
    fdriveCookieSecure: parsed.FDRIVE_COOKIE_SECURE,
    fdriveTrustedProxyHops: parsed.FDRIVE_TRUSTED_PROXY_HOPS,
    fdrivePublicUrl: parsed.FDRIVE_PUBLIC_URL,
    nodeEnv: parsed.NODE_ENV,
    fdriveAutoMigrate: parsed.FDRIVE_AUTO_MIGRATE,
    fdriveTmpDir: parsed.FDRIVE_TMP_DIR,
    fdriveJobMaxBytes: parsed.FDRIVE_JOB_MAX_BYTES,
    fdriveJsonMaxBytes: parsed.FDRIVE_JSON_MAX_BYTES,
    fdriveShareUploadMaxBytes: parsed.FDRIVE_SHARE_UPLOAD_MAX_BYTES,
    fdriveIndexRoots: parsed.FDRIVE_INDEX_ROOTS,
    fdriveEmbedUrl: parsed.FDRIVE_EMBED_URL,
    fdriveThumbsDir: parsed.FDRIVE_THUMBS_DIR,
    fdriveAdminUsers: parseAdminUsers(parsed.FDRIVE_ADMIN_USERS),
    fdriveSetupToken: parsed.FDRIVE_SETUP_TOKEN,
    fdriveIndexerUrl: parsed.FDRIVE_INDEXER_URL,
    fdriveOcrUrl: parsed.FDRIVE_OCR_URL,
    fdriveMcpWrites: parsed.FDRIVE_MCP_WRITES,
    fdriveSftpgoTrashPath: parsed.FDRIVE_SFTPGO_TRASH_PATH,
    fdriveSftpgoTrashRetentionHours: parsed.FDRIVE_SFTPGO_TRASH_RETENTION_HOURS,
  };
  officeConfig(config);
  return config;
}
