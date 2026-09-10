import type { AppConfig } from "./config.js";

/**
 * The functional areas an environment variable can belong to. Used to group
 * `deploy/.env.example` (`tools/deploy/generate-env-example.ts`), to key the
 * per-subsystem status this module computes for the startup summary and
 * `GET /api/v1/health`'s `subsystems` field, and to organize the
 * `compose.yaml` passthrough block.
 */
export const SUBSYSTEMS = [
  "core",
  "index",
  "search",
  "imageSearch",
  "ocr",
  "thumbnails",
  "office",
  "trash",
  "shares",
  "network",
] as const;

export type Subsystem = (typeof SUBSYSTEMS)[number];

/** One row of the single source of truth for every `apps/api` environment variable. */
export interface ConfigKeyDef {
  /** The environment variable's exact name, e.g. `FDRIVE_MASTER_KEY`. */
  readonly key: string;
  /** One sentence describing what this variable controls. */
  readonly description: string;
  /** The value `config.ts` falls back to when the variable is unset or empty, or `null` when there is none (the variable is required, or leaving it unset disables a subsystem). */
  readonly default: string | null;
  /** A realistic, non-default example value shown as a comment in the generated `.env.example`. */
  readonly example: string;
  /** True when this variable's value must never be printed or committed verbatim (credentials, keys, tokens). */
  readonly secret: boolean;
  /** Which subsystem this variable configures. */
  readonly subsystem: Subsystem;
}

/**
 * Every environment variable `apps/api/src/config.ts`'s `envSchema` reads,
 * documented once. `config-keys.test.ts` asserts this list's keys are
 * exactly `configEnvKeys()`'s keys (from `config.ts`), so the two cannot
 * drift silently. `tools/deploy/generate-env-example.ts` renders this table
 * (plus its own deploy-only keys) into `deploy/.env.example` and into
 * `deploy/compose.yaml`'s generated passthrough block.
 */
export const CONFIG_KEYS: readonly ConfigKeyDef[] = [
  {
    key: "FDRIVE_WORKER_TOKEN",
    description: "Shared internal credential for bundled worker configuration polling.",
    default: null,
    example: "replace-with-a-random-worker-secret",
    secret: true,
    subsystem: "core",
  },
  {
    key: "PORT",
    description: "TCP port the API listens on.",
    default: "3001",
    example: "3001",
    secret: false,
    subsystem: "network",
  },
  {
    key: "HOST",
    description: "Address the API binds to inside its container or host process.",
    default: "0.0.0.0",
    example: "0.0.0.0",
    secret: false,
    subsystem: "network",
  },
  {
    key: "LOG_LEVEL",
    description: "Minimum pino log level: fatal, error, warn, info, debug, trace, or silent.",
    default: "info",
    example: "debug",
    secret: false,
    subsystem: "core",
  },
  {
    key: "NODE_ENV",
    description: "development, production, or test; affects pretty-printed logs and defaults.",
    default: "development",
    example: "production",
    secret: false,
    subsystem: "core",
  },
  {
    key: "DATABASE_URL",
    description: "Postgres connection string fdrive's own schema lives in.",
    default: null,
    example: "postgres://fdrive:change-me@db:5432/fdrive",
    secret: true,
    subsystem: "core",
  },
  {
    key: "SFTPGO_URL",
    description:
      "Base URL of the SFTPGo instance fdrive proxies. Unset means setup happens through /setup.",
    default: null,
    example: "http://sftpgo:8080",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_MASTER_KEY",
    description:
      "Base64-encoded 32-byte key that encrypts stored credentials. Generate with `openssl rand -base64 32`; losing it makes stored credentials unrecoverable.",
    default: null,
    example: "change-me-32-random-bytes-base64==",
    secret: true,
    subsystem: "core",
  },
  {
    key: "FDRIVE_HOME_TEMPLATE",
    description: "Maps an identity's username to its home path, e.g. sftpgo:/{username}.",
    default: "sftpgo:/{username}",
    example: "sftpgo:/{username}",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_SESSION_TTL_DAYS",
    description: "How many days a signed-in session stays valid.",
    default: "30",
    example: "30",
    secret: false,
    subsystem: "network",
  },
  {
    key: "FDRIVE_SESSION_MAX_AGE_DAYS",
    description:
      "Hard cap in days on a session's age since login; activity never extends a session past it.",
    default: "90",
    example: "90",
    secret: false,
    subsystem: "network",
  },
  {
    key: "FDRIVE_COOKIE_SECURE",
    description:
      "auto, true, or false; whether the session cookie requires HTTPS. Leave auto behind a TLS-terminating edge proxy.",
    default: "auto",
    example: "auto",
    secret: false,
    subsystem: "network",
  },
  {
    key: "FDRIVE_TRUSTED_PROXY_HOPS",
    description:
      "How many reverse proxies in front of fdrive append an honest X-Forwarded-For entry. Edge proxies that run as containers cannot reach 127.0.0.1 on the host; set FDRIVE_HTTP_BIND accordingly and keep this count matching your proxy chain.",
    default: "1",
    example: "1",
    secret: false,
    subsystem: "network",
  },
  {
    key: "FDRIVE_AUTO_MIGRATE",
    description: "Whether the API runs pending database migrations on startup.",
    default: "true",
    example: "true",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_TMP_DIR",
    description:
      "Directory archive jobs spool temporary files into. Defaults to the OS temp directory.",
    default: null,
    example: "/tmp",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_JOB_MAX_BYTES",
    description: "Cap on the bytes a single archive/extract job may read, in bytes.",
    default: "10737418240",
    example: "10737418240",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_JSON_MAX_BYTES",
    description: "Cap on a JSON request body's bytes (mkdir, move, copy, rename, delete, zip).",
    default: "1048576",
    example: "1048576",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_ARCHIVE_PEEK_MAX_BYTES",
    description:
      "Cap on the compressed bytes read while streaming a tar-family archive's entry list.",
    default: "536870912",
    example: "536870912",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_SHARE_UPLOAD_MAX_BYTES",
    description: "Cap on a public share upload's bytes.",
    default: "10737418240",
    example: "10737418240",
    secret: false,
    subsystem: "shares",
  },
  {
    key: "FDRIVE_ADMIN_USERS",
    description:
      "Comma-separated SFTPGo usernames always treated as admins, in addition to account records.",
    default: null,
    example: "alice,bob",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_SETUP_TOKEN",
    description:
      "Overrides the randomly generated one-time setup token. Mainly for tests and scripted installs.",
    default: null,
    example: "",
    secret: true,
    subsystem: "core",
  },
  {
    key: "FDRIVE_MCP_WRITES",
    description: "Enables the MCP write tools (create_folder, move_path). Off by default.",
    default: "false",
    example: "false",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_INDEX_ROOTS",
    description:
      "JSON array of { name, sftpgoPath, indexerPath } mapping every indexed root. Unset disables search, thumbnails, and the Indexer page's per-root data.",
    default: null,
    example: '[{"name":"sftpgo","sftpgoPath":"/srv/sftpgo/data","indexerPath":"/roots/sftpgo"}]',
    secret: false,
    subsystem: "index",
  },
  {
    key: "FDRIVE_INDEXER_URL",
    description:
      "Base URL of the indexer's internal HTTP API. Unset disables the System > Indexer page and the MCP read_file_text tool.",
    default: null,
    example: "http://indexer:8010",
    secret: false,
    subsystem: "index",
  },
  {
    key: "FDRIVE_EMBED_URL",
    description: "Base URL of the TEI embeddings service. Unset disables semantic search.",
    default: null,
    example: "http://embed:80",
    secret: false,
    subsystem: "search",
  },
  {
    key: "FDRIVE_IMAGE_EMBED_URL",
    description: "Base URL of the SigLIP image-embedding sidecar. Unset disables image search.",
    default: null,
    example: "http://image-embed:8012",
    secret: false,
    subsystem: "imageSearch",
  },
  {
    key: "FDRIVE_THUMBS_DIR",
    description:
      "Directory the indexer writes thumbnails into, read by the API. Unset disables thumbnails.",
    default: null,
    example: "/thumbs",
    secret: false,
    subsystem: "thumbnails",
  },
  {
    key: "FDRIVE_OCR_URL",
    description:
      "Base URL of the OCR service's internal HTTP API. Unset disables the System > OCR page.",
    default: null,
    example: "http://ocr:8011",
    secret: false,
    subsystem: "ocr",
  },
  {
    key: "FDRIVE_OFFICE_PRODUCT",
    description:
      "Advanced Office provider override. Activation and the browser origin are controlled in fdrive settings.",
    default: "onlyoffice",
    example: "onlyoffice",
    secret: false,
    subsystem: "office",
  },
  {
    key: "FDRIVE_OFFICE_URL",
    description:
      "Advanced internal Office server override, reachable from the API over the compose network.",
    default: "http://onlyoffice",
    example: "http://onlyoffice",
    secret: false,
    subsystem: "office",
  },
  {
    key: "FDRIVE_OFFICE_PUBLIC_URL",
    description:
      "Advanced external Office server override. Bundled ONLYOFFICE uses the saved fdrive origin plus /onlyoffice.",
    default: null,
    example: "https://office.example.com",
    secret: false,
    subsystem: "office",
  },
  {
    key: "FDRIVE_WOPI_URL",
    description: "Advanced API WOPI callback override; must end in /wopi.",
    default: "http://api:3001/wopi",
    example: "http://api:3001/wopi",
    secret: false,
    subsystem: "office",
  },
  {
    key: "FDRIVE_OFFICE_MAX_BYTES",
    description: "Cap on a document's bytes fdrive will open for editing.",
    default: "104857600",
    example: "104857600",
    secret: false,
    subsystem: "office",
  },
  {
    key: "FDRIVE_OFFICE_EDIT_RULES",
    description:
      "Advanced per-identity path restrictions, applied in addition to the saved editor username list. Empty/unset adds no further restriction.",
    default: null,
    example: "[]",
    secret: false,
    subsystem: "office",
  },
];

/** A subsystem's configuration state, before any liveness probe is applied. */
export interface SubsystemStatus {
  readonly status: "configured" | "not_configured";
  /** Variable names an operator must set for this subsystem to become "configured". Empty when already configured. */
  readonly missing: readonly string[];
}

/**
 * Pure, config-only status for every subsystem: whether the variables that
 * gate it are set, and by name, which are missing when they are not. Never
 * makes a network call; `applyReachability` layers a liveness probe's result
 * on top for subsystems where one exists.
 */
export function subsystemsStatus(config: AppConfig): Record<Subsystem, SubsystemStatus> {
  const indexMissing: string[] = [];
  if (config.fdriveIndexRoots === null) indexMissing.push("FDRIVE_INDEX_ROOTS");
  if (config.fdriveIndexerUrl === undefined) indexMissing.push("FDRIVE_INDEXER_URL");

  return {
    core: { status: "configured", missing: [] },
    network: { status: "configured", missing: [] },
    shares: { status: "configured", missing: [] },
    index:
      indexMissing.length === 0
        ? { status: "configured", missing: [] }
        : { status: "not_configured", missing: indexMissing },
    search:
      config.fdriveEmbedUrl === undefined
        ? { status: "not_configured", missing: ["FDRIVE_EMBED_URL"] }
        : { status: "configured", missing: [] },
    imageSearch:
      config.fdriveImageEmbedUrl === undefined
        ? { status: "not_configured", missing: ["FDRIVE_IMAGE_EMBED_URL"] }
        : { status: "configured", missing: [] },
    thumbnails:
      config.fdriveThumbsDir === undefined
        ? { status: "not_configured", missing: ["FDRIVE_THUMBS_DIR"] }
        : { status: "configured", missing: [] },
    ocr:
      config.fdriveOcrUrl === undefined
        ? { status: "not_configured", missing: ["FDRIVE_OCR_URL"] }
        : { status: "configured", missing: [] },
    office: { status: "configured", missing: [] },
    trash: { status: "configured", missing: [] },
  };
}

/** A subsystem's status once a liveness probe (where one exists) has been applied. */
export interface HealthSubsystem {
  readonly status: "configured" | "not_configured" | "unreachable" | "failed";
  readonly missing: readonly string[];
  /** The bundled controller's literal reason when `status` is `failed`. */
  readonly detail?: string;
}

/**
 * One liveness probe's outcome: `true` reachable, `false` unreachable, or
 * `{ failed }` when the subsystem's bundled controller answered and reports
 * that the worker it manages could not start. `failed` carries the
 * controller's own fixed reason so a latched worker is distinguishable from
 * a network problem on the public health endpoint.
 */
export type SubsystemProbe = boolean | { readonly failed: string };

/**
 * Layers reachability results (indexer, embed/search, OCR, office; absent
 * means no probe was run for that subsystem, for example because it is not
 * configured) on top of `subsystemsStatus`'s config-only result. A subsystem
 * already `not_configured` never becomes `unreachable` or `failed`: there is
 * nothing to reach.
 */
export function applyReachability(
  base: Record<Subsystem, SubsystemStatus>,
  reachable: Partial<Record<Subsystem, SubsystemProbe>>,
): Record<Subsystem, HealthSubsystem> {
  const result = {} as Record<Subsystem, HealthSubsystem>;
  for (const subsystem of SUBSYSTEMS) {
    const entry = base[subsystem];
    const probe = reachable[subsystem];
    result[subsystem] =
      entry.status !== "configured" || probe === undefined || probe === true
        ? { status: entry.status, missing: entry.missing }
        : probe === false
          ? { status: "unreachable", missing: [] }
          : { status: "failed", missing: [], detail: probe.failed };
  }
  return result;
}

/** `FDRIVE_TRUSTED_PROXY_HOPS`'s default, matching `config.ts`'s `envSchema`. */
const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/**
 * One log line per subsystem for the API's startup summary, plus a bind
 * hint when `FDRIVE_TRUSTED_PROXY_HOPS` is left at its default (the
 * variable does not distinguish "left unset" from "explicitly set to the
 * default" once parsed, so this nudges either way rather than staying
 * silent). Pure: `composition.ts` is the only caller and passes each line to
 * its logger.
 */
export function startupSummaryLines(config: AppConfig): string[] {
  const statuses = subsystemsStatus(config);
  const lines = SUBSYSTEMS.map((subsystem) => {
    const entry = statuses[subsystem];
    return entry.status === "configured"
      ? `subsystem=${subsystem} status=configured`
      : `subsystem=${subsystem} status=not configured missing=${entry.missing.join(",")}`;
  });
  if (config.fdriveTrustedProxyHops === DEFAULT_TRUSTED_PROXY_HOPS) {
    lines.push(
      `subsystem=network bind hint: FDRIVE_TRUSTED_PROXY_HOPS is at its default (${DEFAULT_TRUSTED_PROXY_HOPS}); set it to the number of reverse proxies actually in front of fdrive so client IPs and rate limiting stay accurate.`,
    );
  }
  return lines;
}
