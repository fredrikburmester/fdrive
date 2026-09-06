# Deploying fdrive

This directory holds the Docker Compose files for running fdrive. Copy
`.env.example` to `.env` and fill in real values before starting anything.

## Files

- `compose.yaml` — the core stack: `proxy` (Caddy, single origin), `web`
  (Next.js), `api` (Hono API), and `db` (Postgres with pgvector). This is
  the file you normally run.
- `Caddyfile` — routes `/api/*`, `/wopi/*`, and `/mcp*` to the API and
  everything else to the web app, on one origin.
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

## The `index` profile

`compose.yaml` also defines `indexer`, `tika`, and `embed` behind an `index`
Compose profile: search, thumbnails, and content extraction only run when you
opt in with `--profile index` (see below). `FDRIVE_INDEX_SFTPGO_DIR` in
`.env` must point at the same host directory SFTPGo itself serves, bind-mounted
read-only into the indexer at `/roots/sftpgo`. See `docs/INDEXER.md` for what
gets indexed, the internal HTTP API, and how to add more roots.

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

## The two opt-in files

`compose.sftpgo.yaml` and `compose.office.yaml` both exist so that the
default `compose.yaml` stays minimal and never assumes you want fdrive to
also run SFTPGo or ONLYOFFICE for you. Add either one with `-f` only when
you actually want it; combine them freely with the core stack and with each
other.
