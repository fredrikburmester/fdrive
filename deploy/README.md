# Deploying fdrive

This directory holds the Docker Compose files for running fdrive. Copy
`.env.example` to `.env` and fill in real values before starting anything.

## Files

- `compose.yaml` — the core stack: `proxy` (Caddy, single origin), `web`
  (Next.js), `api` (Hono API), and `db` (Postgres with pgvector). This is
  the file you normally run.
- `Caddyfile` — routes `/api/*` and `/mcp*` to the API and everything else to
  the web app, on one origin. WOPI callbacks never traverse this proxy: the
  office server reaches the API directly at `http://api:3001/wopi` over the
  compose network, so `/wopi/*` is never a public route.
- `compose.sftpgo.yaml` — **opt-in**. Adds an SFTPGo service for people who
  do not already run one. Never referenced by `compose.yaml` automatically;
  you choose it explicitly with `-f`.
- `compose.sftpgo-network.example.yaml` — an example override showing how
  to attach the `api` service to an existing external Docker network that
  your own SFTPGo instance lives on, instead of running SFTPGo yourself.
- `compose.office.yaml` — **opt-in**. Adds ONLYOFFICE Document Server as a
  WOPI host for editing office documents. Also never referenced
  automatically.
- `.env.example` — every environment variable used by the files above, with
  placeholder values and comments on what generates a real one.

## How requests flow

The browser only ever talks to `proxy` (Caddy) on one origin. Caddy routes
`/api/*` and `/mcp*` straight to the `api` service; every other path goes to
`web`, which only serves pages. This means the web app's own
`/api/:path*` rewrite (see `apps/web/next.config.ts`) never runs in this
deployment: Caddy intercepts those paths before they reach `web`. The
`API_INTERNAL_URL` build arg on the `web` service exists only as a fallback
for anyone who runs the `fdrive-web` image without a proxy in front of it.

## The `index` profile

`compose.yaml` also defines `indexer`, `tika`, `embed`, and `ocr` behind an
`index` Compose profile: search, thumbnails, content extraction, and the
nightly OCR pass only run when you opt in with `--profile index` (see below).
`FDRIVE_INDEX_SFTPGO_DIR` in `.env` must point at the same host directory
SFTPGo itself serves. It is bind-mounted read-only into the indexer at
`/roots/sftpgo` and read-write into `ocr` at the same path, since OCR rewrites
files in place (see docs/OCR.md for the safety guarantees around that). `ocr`
keeps its own state (kept originals, the done-log lives in Postgres) under
`${FDRIVE_DATA_DIR}/ocr`. See `docs/INDEXER.md` for what gets indexed, the
indexer's internal HTTP API, and how to add more roots; see `docs/OCR.md` for
the OCR service's settings and endpoints. The api's `FDRIVE_OCR_URL` points at
`ocr` so the web app's System page can show OCR status; it is only reachable
when the `index` profile is up.

## The external SFTPGo assumption

fdrive never manages SFTPGo's own database and treats it as an external
service reachable at `SFTPGO_URL`. There are two ways to satisfy that:

1. **You already run SFTPGo somewhere** (its own compose stack, another
   host, etc). Point `SFTPGO_URL` at it. If it lives on a Docker network
   that this stack cannot otherwise reach, copy
   `compose.sftpgo-network.example.yaml` to `compose.sftpgo-network.yaml`,
   adjust the network name, and include it with `-f`.
2. **You have no SFTPGo yet.** Start the opt-in `compose.sftpgo.yaml` file
   alongside the core stack (see below) and point `SFTPGO_URL` at the
   service it adds.

## Running it

Core stack only, assuming an external SFTPGo:

```sh
docker compose -f compose.yaml up -d
```

Core stack plus a fresh SFTPGo:

```sh
docker compose -f compose.yaml -f compose.sftpgo.yaml up -d
```

Core stack plus ONLYOFFICE editing:

```sh
docker compose -f compose.yaml -f compose.office.yaml --profile office up -d
```

Core stack plus indexing, search, and thumbnails:

```sh
docker compose -f compose.yaml --profile index up -d
```

Validate a compose file's syntax without starting anything:

```sh
docker compose -f compose.yaml --env-file .env.example config
```

## TLS and network placement

None of the compose files terminate TLS themselves. An operator's own edge
proxy (a load balancer, another Caddy, nginx, a cloud provider's HTTPS
frontend) must sit in front of `proxy`'s published port and terminate TLS
there before forwarding plain HTTP to `compose.yaml`'s `proxy` service. The
default deployment must not be served over plain HTTP with no such edge in
front: the session cookie only becomes `Secure` when the request looks like
it arrived over HTTPS (see `FDRIVE_COOKIE_SECURE=auto` in `.env.example`),
and every Caddyfile in this directory adds `header_up X-Forwarded-Proto
https` on the `api` and `web` upstreams so that check passes once an edge is
actually there. Set `FDRIVE_COOKIE_SECURE=false` only for plain-HTTP LAN
testing with no edge and no real users, never for a deployment reachable
from the internet.

Every port this stack publishes to the host is loopback-bound
(`127.0.0.1:...`) by default, on the assumption that the edge proxy runs on
the same host and reaches these services over `localhost`:

- `proxy` (`FDRIVE_HTTP_PORT`, default `8090`): set `FDRIVE_HTTP_BIND=0.0.0.0`
  only when the edge proxy runs on a different host and must reach this port
  over the network.
- The opt-in SFTPGo overlay's admin/HTTP port (`SFTPGO_ADMIN_PORT`, default
  `8091`): this is SFTPGo's own admin API and must never be internet-reachable
  regardless of where the edge proxy runs. fdrive itself talks to SFTPGo over
  the internal compose network (`SFTPGO_URL=http://sftpgo:8080`), not this
  published port; only unbind it (or bind it more broadly) for a deliberate,
  temporary admin-UI session, and re-bind it to loopback afterward. SFTPGo's
  SFTP port (`2022`) stays published for actual SFTP clients, since it needs
  its own authentication regardless of network placement.

The `api`, `db`, `onlyoffice`, and `collabora` services publish no host ports
at all: everything reaches them over the compose network only.

## The two opt-in files

`compose.sftpgo.yaml` and `compose.office.yaml` both exist so that the
default `compose.yaml` stays minimal and never assumes you want fdrive to
also run SFTPGo or ONLYOFFICE for you. Add either one with `-f` only when
you actually want it; combine them freely with the core stack and with each
other.
