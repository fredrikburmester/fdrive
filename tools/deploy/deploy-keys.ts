import type { ConfigKeyDef } from "../../apps/api/src/config-keys.ts";

/**
 * Environment variables the `deploy/` compose files read that are not part
 * of `apps/api`'s own `envSchema` (`apps/api/src/config-keys.ts`'s
 * `CONFIG_KEYS`): Postgres credentials, the proxy's published port and bind
 * address, host paths bind-mounted into containers, the uid the file
 * workers run as, and the OCR service's own include/exclude globs. Kept separate from `CONFIG_KEYS` so that
 * table's round-trip test against `apps/api/src/config.ts` stays exact;
 * `generate-env-example.ts` merges both tables when rendering
 * `deploy/.env.example`.
 */
export const DEPLOY_EXTRA_KEYS: readonly ConfigKeyDef[] = [
  {
    key: "FDRIVE_VERSION",
    description:
      "Release to run, for example 0.3.1. Unset follows the newest release and main follows the main branch's edge images.",
    default: "latest",
    example: "0.3.1",
    secret: false,
    subsystem: "core",
  },
  {
    key: "POSTGRES_PASSWORD",
    description: "Hex password for the bundled Postgres database's fdrive user.",
    default: null,
    example: "change-me",
    secret: true,
    subsystem: "core",
  },
  {
    key: "FDRIVE_DATA_DIR",
    description:
      "Host directory holding Postgres data, OCR state and, unless FDRIVE_FILES_DIR names another folder, the files.",
    default: "./data",
    example: "/srv/fdrive",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_FILES_DIR",
    description:
      "Host folder with every user's files, one folder per username, by default the files folder in FDRIVE_DATA_DIR. Mounted read-write into the api, backup worker and OCR and read-only into the indexer.",
    default: "./data/files",
    example: "/srv/files",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_RUN_AS_UID",
    description:
      "Host uid/gid the api, backup worker, indexer and OCR run as, which must own the files folder.",
    default: "1000",
    example: "1000",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_HTTP_BIND",
    description:
      "Host address for the web interface. Defaults to all interfaces for access from another device; set 127.0.0.1 for local-only access.",
    default: "0.0.0.0",
    example: "0.0.0.0",
    secret: false,
    subsystem: "network",
  },
  {
    key: "FDRIVE_HTTP_PORT",
    description: "Host port the proxy publishes.",
    default: "8090",
    example: "8090",
    secret: false,
    subsystem: "network",
  },
  {
    key: "TZ",
    description: "Time zone the OCR service schedules its nightly pass in.",
    default: "UTC",
    example: "Europe/Stockholm",
    secret: false,
    subsystem: "ocr",
  },
  {
    key: "OCR_EXCLUDE_GLOBS",
    description:
      "Comma-separated globs OCR never processes, matched against <root>/<relative path>.",
    default: "Programs/**,Photos/**,Videos/**",
    example: "Programs/**,Photos/**,Videos/**",
    secret: false,
    subsystem: "ocr",
  },
  {
    key: "OCR_INCLUDE_GLOBS",
    description:
      "Comma-separated globs OCR is restricted to when set; overrides the default exclude set (OCR_EXCLUDE_GLOBS still applies on top). Lets a single-user instance restrict OCR to one home, for example fredrik/**, without changing the template.",
    default: null,
    example: "fredrik/**",
    secret: false,
    subsystem: "ocr",
  },
  {
    key: "FDRIVE_COLLABORA_APP_URL",
    description:
      "The address everyone opens fdrive at, which Collabora (compose.office.collabora.yaml) allows to frame its editor. Required with that overlay, ignored otherwise; the bundled ONLYOFFICE reads the address saved in onboarding instead.",
    default: null,
    example: "https://drive.example.com",
    secret: false,
    subsystem: "office",
  },
  {
    key: "FDRIVE_COLLABORA_HOST",
    description:
      "Public hostname for Collabora (compose.office.collabora.yaml), routed to the same proxy port as fdrive. Required with that overlay, ignored otherwise.",
    default: null,
    example: "office.example.com",
    secret: false,
    subsystem: "office",
  },
  // Processing worker thread counts and opt-in resource caps
  // (deploy/REFERENCE.md, "Processing Worker Resource Limits"). compose.yaml
  // interpolates these straight into each worker's environment or its
  // cpus:/mem_limit:, so they never reach the api and live only here.
  {
    key: "FDRIVE_ML_THREADS",
    description:
      "Thread count shared by every model in the ml service (text and image embeddings); raise on a dedicated machine.",
    default: "4",
    example: "8",
    secret: false,
    subsystem: "search",
  },
  {
    key: "FDRIVE_INDEXER_CPUS",
    description:
      "Hard CPU cap for the indexer container (Docker cpus:); 0 means no limit, and Docker refuses a value above the host's core count.",
    default: "0",
    example: "2",
    secret: false,
    subsystem: "index",
  },
  {
    key: "FDRIVE_INDEXER_MEMORY",
    description: "Hard memory cap for the indexer container (Docker mem_limit); 0 means no limit.",
    default: "0",
    example: "2g",
    secret: false,
    subsystem: "index",
  },
  {
    key: "FDRIVE_ML_CPUS",
    description:
      "Hard CPU cap for the ml service (Docker cpus:); 0 means no limit, and Docker refuses a value above the host's core count.",
    default: "0",
    example: "2",
    secret: false,
    subsystem: "search",
  },
  {
    key: "FDRIVE_ML_MEMORY",
    description:
      "Hard memory cap for the ml service (Docker mem_limit); 0 means no limit. Image search alone needs about 3g.",
    default: "6g",
    example: "4g",
    secret: false,
    subsystem: "search",
  },
  {
    key: "FDRIVE_OCR_CPUS",
    description:
      "Hard CPU cap for the OCR container (Docker cpus:); 0 means no limit, and Docker refuses a value above the host's core count.",
    default: "0",
    example: "1",
    secret: false,
    subsystem: "ocr",
  },
  {
    key: "FDRIVE_OCR_MEMORY",
    description: "Hard memory cap for the OCR container (Docker mem_limit); 0 means no limit.",
    default: "0",
    example: "1g",
    secret: false,
    subsystem: "ocr",
  },
  {
    key: "FDRIVE_ONLYOFFICE_CPUS",
    description:
      "Hard CPU cap for the bundled ONLYOFFICE container (Docker cpus:); 0 means no limit, and Docker refuses a value above the host's core count.",
    default: "0",
    example: "2",
    secret: false,
    subsystem: "office",
  },
  {
    key: "FDRIVE_ONLYOFFICE_MEMORY",
    description:
      "Hard memory cap for the bundled ONLYOFFICE container (Docker mem_limit); 0 means no limit.",
    default: "0",
    example: "4g",
    secret: false,
    subsystem: "office",
  },
];
