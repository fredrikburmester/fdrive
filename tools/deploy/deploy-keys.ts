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
      "Extra compose files update.sh should pass with -f, space separated (for example compose.sftpgo-network.yaml compose.office.yaml).",
    default: null,
    example: "compose.sftpgo-network.yaml compose.office.yaml",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_PROFILES",
    description:
      "Compose profiles update.sh should pass with --profile, space separated (for example index office).",
    default: null,
    example: "index office",
    secret: false,
    subsystem: "core",
  },
  {
    key: "FDRIVE_HTTP_BIND",
    description:
      "Host address the proxy's published port binds to. Edge proxies that run as containers (Nginx Proxy Manager, Traefik, a dockerised Caddy) cannot reach 127.0.0.1 on the host; set 0.0.0.0 or the host's LAN address for them.",
    default: "127.0.0.1",
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
      "Host uid/gid the indexer and OCR containers run as, matching SFTPGo's so 700 folders stay readable.",
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
    key: "ONLYOFFICE_JWT_SECRET",
    description:
      "Shared secret between the api and ONLYOFFICE (compose.office.yaml): at least 32 letters, digits, underscores or hyphens, e.g. from `openssl rand -hex 32`. Treat as a secret. Required with that overlay, ignored otherwise.",
    default: null,
    example: "output-of-openssl-rand-hex-32",
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
];
