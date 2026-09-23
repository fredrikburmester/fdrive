import type { ConfigKeyDef } from "../../apps/api/src/config-keys.ts";

/**
 * Environment variables the `deploy/` compose files read that are not part
 * of `apps/api`'s own `envSchema` (`apps/api/src/config-keys.ts`'s
 * `CONFIG_KEYS`): Postgres credentials, the proxy's published port and bind
 * address, host paths bind-mounted into containers, and the OCR service's
 * own include/exclude globs. Kept separate from `CONFIG_KEYS` so that
 * table's round-trip test against `apps/api/src/config.ts` stays exact;
 * `generate-env-example.ts` merges both tables when rendering
 * `deploy/.env.example`.
 */
export const DEPLOY_EXTRA_KEYS: readonly ConfigKeyDef[] = [
  {
    key: "FDRIVE_VERSION",
    description:
      "Release to run, for example 0.3.1. Unset follows the newest release and main follows the main branch's edge images; update.sh checks out the matching source and pulls the matching images.",
    default: "latest",
    example: "0.3.1",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_BUILD_REVISION",
    description:
      "Git commit a source build (compose.build.yaml) bakes into the API image; update.sh sets it automatically after checking out.",
    default: null,
    example: "0123456789abcdef0123456789abcdef01234567",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_READY_TIMEOUT_SECONDS",
    description: "Maximum seconds update.sh waits for enabled subsystems to finish starting.",
    default: "1200",
    example: "1800",
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
    description: "Host directory holding Postgres data, OCR state, and the embedding model cache.",
    default: "./data",
    example: "./data",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_COMPOSE_FILES",
    description:
      "Extra compose files update.sh should pass with -f, space separated (for example compose.sftpgo-network.yaml).",
    default: null,
    example: "compose.sftpgo-network.yaml",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_PROFILES",
    description:
      "Optional-overlay profiles update.sh should pass with --profile, space separated (for example collabora).",
    default: null,
    example: "collabora",
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
    key: "FDRIVE_INDEX_SFTPGO_DIR",
    description:
      "Host directory SFTPGo itself serves, bind-mounted read-only into the indexer and read-write into OCR. Required to use the index profile.",
    default: null,
    example: "/srv/sftpgo/data",
    secret: false,
    subsystem: "index",
  },
  {
    key: "FDRIVE_INDEX_SFTPGO_PATH",
    description:
      "The path at which SFTPGo itself sees FDRIVE_INDEX_SFTPGO_DIR; feeds the api's FDRIVE_INDEX_ROOTS default sftpgoPath.",
    default: "/srv/sftpgo/data",
    example: "/srv/sftpgo/data",
    secret: false,
    subsystem: "index",
  },
  {
    key: "FDRIVE_INDEX_UID",
    description:
      "Host uid/gid the indexer runs as, matching SFTPGo's so 700 folders stay readable; its thumbnail and log volumes are owned by it too.",
    default: "1000",
    example: "1000",
    secret: false,
    subsystem: "index",
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
    key: "SFTPGO_ADMIN_USERNAME",
    description:
      "Admin username the bundled SFTPGo (compose.sftpgo.yaml) creates on first boot. Ignored unless that overlay is in use.",
    default: "admin",
    example: "admin",
    secret: false,
    subsystem: "core",
  },
  {
    key: "SFTPGO_ADMIN_PASSWORD",
    description:
      "Admin password for the bundled SFTPGo (compose.sftpgo.yaml). Treat as a secret. Required when that overlay is in use, ignored otherwise.",
    default: null,
    example: "a-strong-password",
    secret: false,
    subsystem: "core",
  },
  {
    key: "SFTPGO_ADMIN_PORT",
    description:
      "Loopback host port the bundled SFTPGo's admin UI and API are published on (compose.sftpgo.yaml). Reach it through an SSH tunnel; never expose it.",
    default: "8091",
    example: "8091",
    secret: false,
    subsystem: "network",
  },
  {
    key: "SFTPGO_ADMIN_BIND",
    description:
      "Host address the bundled SFTPGo's admin port binds to (compose.sftpgo.yaml). Default reaches it only from the server itself; set 0.0.0.0 to open it to your LAN, and keep it firewalled from the internet.",
    default: "127.0.0.1",
    example: "0.0.0.0",
    secret: false,
    subsystem: "network",
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
  // interpolates these straight into each sidecar's environment or its
  // cpus:/mem_limit:, so they never reach the api and live only here.
  {
    key: "FDRIVE_EMBED_THREADS",
    description:
      "Thread count for the text embedding sidecar (TEI's RAYON_NUM_THREADS and TOKENIZATION_WORKERS); raise on a dedicated machine.",
    default: "4",
    example: "8",
    secret: false,
    subsystem: "search",
  },
  {
    key: "FDRIVE_IMAGE_EMBED_THREADS",
    description:
      "Thread count for the SigLIP image embedding sidecar (IMAGE_EMBED_THREADS and OMP_NUM_THREADS); raise on a dedicated machine.",
    default: "4",
    example: "8",
    secret: false,
    subsystem: "imageSearch",
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
    key: "FDRIVE_TIKA_CPUS",
    description:
      "Hard CPU cap for the tika text extraction container (Docker cpus:); 0 means no limit, and Docker refuses a value above the host's core count.",
    default: "0",
    example: "2",
    secret: false,
    subsystem: "index",
  },
  {
    key: "FDRIVE_TIKA_MEMORY",
    description:
      "Hard memory cap for the tika text extraction container (Docker mem_limit); 0 means no limit, and the JVM then sizes its heap from host RAM.",
    default: "0",
    example: "2g",
    secret: false,
    subsystem: "index",
  },
  {
    key: "FDRIVE_TIKA_JAVA_OPTS",
    description:
      "Extra JVM options for the tika container (passed as JAVA_TOOL_OPTIONS), for an explicit -Xmx when FDRIVE_TIKA_MEMORY is unset.",
    default: null,
    example: "-Xmx1g",
    secret: false,
    subsystem: "index",
  },
  {
    key: "FDRIVE_EMBED_CPUS",
    description:
      "Hard CPU cap for the text embedding sidecar (Docker cpus:); 0 means no limit, and Docker refuses a value above the host's core count.",
    default: "0",
    example: "2",
    secret: false,
    subsystem: "search",
  },
  {
    key: "FDRIVE_EMBED_MEMORY",
    description:
      "Hard memory cap for the text embedding sidecar (Docker mem_limit); 0 means no limit.",
    default: "4g",
    example: "2g",
    secret: false,
    subsystem: "search",
  },
  {
    key: "FDRIVE_IMAGE_EMBED_CPUS",
    description:
      "Hard CPU cap for the image embedding sidecar (Docker cpus:); 0 means no limit, and Docker refuses a value above the host's core count.",
    default: "0",
    example: "2",
    secret: false,
    subsystem: "imageSearch",
  },
  {
    key: "FDRIVE_IMAGE_EMBED_MEMORY",
    description:
      "Hard memory cap for the image embedding sidecar (Docker mem_limit); 0 means no limit.",
    default: "6g",
    example: "3g",
    secret: false,
    subsystem: "imageSearch",
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
