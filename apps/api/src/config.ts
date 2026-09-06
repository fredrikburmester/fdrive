import { tmpdir } from "node:os";
import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const NODE_ENVS = ["development", "production", "test"] as const;
const COOKIE_SECURE_MODES = ["auto", "true", "false"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type NodeEnv = (typeof NODE_ENVS)[number];
export type CookieSecureMode = (typeof COOKIE_SECURE_MODES)[number];

export interface AppConfig {
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly sftpgoUrl: string;
  readonly fdriveMasterKey: string;
  readonly fdriveHomeTemplate: string;
  readonly fdriveSessionTtlDays: number;
  readonly fdriveCookieSecure: CookieSecureMode;
  readonly fdrivePublicUrl: string | undefined;
  readonly nodeEnv: NodeEnv;
  readonly fdriveAutoMigrate: boolean;
  /** Directory archive jobs spool temp files into. Defaults to the OS temp dir. */
  readonly fdriveTmpDir: string;
  /** Total bytes a single archive/extract job may read before it fails. */
  readonly fdriveJobMaxBytes: number;
}

/** Default cap on the bytes a single archive job may read: 10 GiB. */
export const DEFAULT_JOB_MAX_BYTES = 10 * 1024 * 1024 * 1024;

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

const envSchema = z.object({
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
  SFTPGO_URL: z
    .string()
    .min(1, "is required")
    .refine((value) => isHttpUrl(value), { message: "must be an http(s) URL" }),
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

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    sftpgoUrl: parsed.SFTPGO_URL,
    fdriveMasterKey: parsed.FDRIVE_MASTER_KEY,
    fdriveHomeTemplate: parsed.FDRIVE_HOME_TEMPLATE,
    fdriveSessionTtlDays: parsed.FDRIVE_SESSION_TTL_DAYS,
    fdriveCookieSecure: parsed.FDRIVE_COOKIE_SECURE,
    fdrivePublicUrl: parsed.FDRIVE_PUBLIC_URL,
    nodeEnv: parsed.NODE_ENV,
    fdriveAutoMigrate: parsed.FDRIVE_AUTO_MIGRATE,
    fdriveTmpDir: parsed.FDRIVE_TMP_DIR,
    fdriveJobMaxBytes: parsed.FDRIVE_JOB_MAX_BYTES,
  };
}
