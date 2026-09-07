# P7 loud configuration (first-user feedback, 2026-09-07)

Principle: a misconfigured fdrive must say what is missing, by variable name, at startup and
on the System pages. Healthy containers plus a passing health check must never coexist with
a silently disabled subsystem. Eight findings, one chunk.

## Single source of truth for settings (apps/api)

- `apps/api/src/config-keys.ts`: a table of every environment variable the API reads:
  `{ key, description (one sentence), default (string | null), example, secret: boolean,
  subsystem: "core" | "index" | "search" | "ocr" | "thumbnails" | "office" | "trash" |
  "shares" | "network" }`. `config.ts` is refactored to read keys only through this table
  (a test asserts every `process.env.X` / schema key in `config.ts` appears in the table and
  vice versa). Empty strings are treated as unset for every key, so a compose passthrough
  of `${KEY:-}` is safe.
- Startup summary: after loading config the API logs one line per subsystem:
  `subsystem=search status=configured` or `status=not configured missing=FDRIVE_EMBED_URL`,
  plus `subsystem=network bind hint` when `FDRIVE_TRUSTED_PROXY_HOPS` is unset.
- `GET /api/v1/health` (public, unauthenticated, so no secrets) gains
  `subsystems: { [name]: { status: "configured" | "not_configured" | "unreachable", missing:
  string[] } }`, contract in `packages/contracts/src/about.ts` or a new `health.ts`.
  Reachability is the existing probe where one exists (indexer, embed, OCR, office).
- `/api/v1/system/*` responses and the System pages render one of exactly three states per
  subsystem: "Not configured: set FDRIVE_X" (with the variable name), "Unreachable at
  <host>" or the working view. The Thumbnails page never shows "cache is available" next to
  "Not configured": it derives its badge from the same subsystem status.

## Deploy (deploy/, tools/deploy/)

- `deploy/.env.example` is generated from the table by `tools/deploy/generate-env-example.ts`
  (`pnpm env:example`), grouped by subsystem, each key with its description, default and a
  commented example, secrets marked. A test (`tools/deploy/env-example.test.ts`) regenerates
  into memory and fails when the committed file differs, so example and code cannot drift.
  The generator writes the file; do not hand-edit it. Include, next to `FDRIVE_HTTP_BIND`:
  "Edge proxies that run as containers (Nginx Proxy Manager, Traefik, a dockerised Caddy)
  cannot reach 127.0.0.1 on the host; set 0.0.0.0 or the host's LAN address for them."
- `deploy/compose.yaml` `api.environment` passes every non-secret key from the table as
  `KEY: ${KEY:-}` (generated section between markers, checked by the same test), and the
  secrets it already passes. `FDRIVE_INDEX_ROOTS` defaults, when unset, to the single root
  the compose mounts create: `[{"name":"sftpgo","sftpgoPath":"${FDRIVE_INDEX_SFTPGO_PATH:-/srv/sftpgo/data}","indexerPath":"/roots/sftpgo"}]`, with `FDRIVE_INDEX_SFTPGO_PATH`
  documented as "the path at which SFTPGo itself sees FDRIVE_INDEX_SFTPGO_DIR".
  `OCR_EXCLUDE_GLOBS` and `OCR_INCLUDE_GLOBS` (add include support to `services/ocr` if
  absent: include wins over the default set, exclude then applies) are passed through so a
  single-user instance can restrict OCR to one home (`fredrik/**`) without changing the
  template.
- `deploy/preflight.sh`, run by `update.sh` before `up`: fails on `change-me` values, on
  unknown `FDRIVE_*` keys in `.env` (typos), on a home template that does not match
  `<root>:<path with {username}>`, and prints the resolved `FDRIVE_INDEX_ROOTS` and bind
  address so the operator sees what will be used. Reads only `deploy/.env`.
- `deploy/update.sh` resolves its own path through symlinks (portable: `readlink -f` when
  available, else a `cd`/`pwd -P` loop).
- `deploy/README.md`: a "Nothing is silent" section listing the startup summary, the health
  fields and the preflight; the setup-flow paragraph says plainly that env-configured
  installs have no `/setup`.

## Tests and gates

API config table round trip, health contract, startup summary snapshot, System page states
(jsdom), preflight shell tests (`bash` with fixture env files, run from the root `pnpm test`
via a tools vitest config or a `tests/preflight.sh` executed by vitest), generated example
diff test, compose config validation with and without the index profile.
