# Deployment reference

This is the detailed reference behind [the setup guide](README.md): every compose file, how requests flow, container hardening and pinned images. Start with the guide; come here when you need the why.

```sh
cp .env.example .env && chmod 600 .env
```

`.env` holds real secrets (database password, master key, JWT secrets), so it
is created `0600` (owner read-write only) from the start rather than
inheriting the umask's usual `0644`. Edit every `change-me` placeholder in it
before starting anything; `./preflight.sh` (run automatically by
`./update.sh`, right before `docker compose up`) refuses to start while any
remain, along with two other common mistakes. See "Nothing is silent" below.

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
  placeholder values and comments on what generates a real one. Generated
  by `tools/deploy/generate-env-example.ts` (`pnpm env:example`) from the
  same table `apps/api/src/config-keys.ts` uses; do not hand-edit it, edit
  that table and regenerate instead.
- `preflight.sh` — checks `.env` for common mistakes before `docker compose
  up`; see "Nothing is silent" below.
- `update.sh` — pulls, rebuilds, runs `preflight.sh`, brings the stack up,
  and checks the API's health afterwards; see "Running it" below.

## Nothing is silent

A misconfigured fdrive is meant to say so, by variable name, rather than
start up quietly degraded:

- **Startup summary.** On every boot the API logs one line per subsystem
  (core, network, index, search, thumbnails, ocr, office, trash, shares):
  `subsystem=search status=configured` or `subsystem=ocr status=not
  configured missing=FDRIVE_OCR_URL`, naming exactly which variable to set.
  `docker compose logs api` shows this right after the container starts.
- **`GET /api/v1/health`.** Public and unauthenticated (so it never carries
  secrets), its `subsystems` field reports the same per-subsystem
  `"configured"` / `"not_configured"` / `"unreachable"` state, with a
  `missing` array of variable names for anything not configured. A
  monitoring check against this endpoint catches a sidecar that later goes
  unreachable, not only a variable that was never set.
- **The System pages** (`/system/indexer`, `/system/search`, `/system/ocr`,
  `/system/thumbnails`) show one of exactly three states per subsystem: "Not
  configured: set `FDRIVE_X`" (naming the variable), "Unreachable", or the
  working view. A subsystem that only partly depends on another (the
  Thumbnails page needs both `FDRIVE_THUMBS_DIR` and the indexer) never
  shows a working-looking description next to a "Not configured" badge.
- **`./preflight.sh`**, run automatically by `./update.sh` right before `up`
  (or run directly from this directory). Reads only `deploy/.env` and fails
  on: a leftover `change-me` placeholder; an unknown `FDRIVE_*` key (almost
  always a typo, since every real one is documented in `.env.example`); or a
  `FDRIVE_HOME_TEMPLATE` that does not match `<root>:<path with
  {username}>`. On success it prints the `FDRIVE_INDEX_ROOTS` value and the
  bind address that will actually be used, so what you are about to deploy
  is visible before it happens, not only discoverable afterwards.

**Env-configured installs have no `/setup`.** When `SFTPGO_URL` and
`FDRIVE_HOME_TEMPLATE` are both set in `.env`, the API records that
connection on first boot; there is no setup token and the `/setup` wizard
route is never needed. Leave both unset to use `/setup` instead (sign in
once as an SFTPGo admin to complete it in the browser). Setting only one of
the two leaves fdrive waiting on `/setup` regardless, since either the host
or the home-directory mapping would otherwise be missing.

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
Without that profile, `compose.yaml` still points the api at the sidecars
(`FDRIVE_INDEXER_URL`, `FDRIVE_EMBED_URL`, `FDRIVE_OCR_URL` and a default
`FDRIVE_INDEX_ROOTS`), so the startup summary, `/api/v1/health` and the
System pages report index, search, thumbnails and OCR as "unreachable"
rather than "not configured". That is expected until you add the profile;
it is the same state a stopped sidecar produces.
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

The `indexer` service (`services/indexer/Dockerfile`) runs as a non-root user
with the same uid/gid as SFTPGo, `1000` by default (`FDRIVE_INDEX_UID` in `.env`),
so folders users keep at mode `700` stay readable to it. Its thumbnail cache (`/thumbs`, read from the `api` service's
`FDRIVE_THUMBS_DIR`) is a named volume, `fdrive-thumbs`, rather than a host
bind mount: Docker always creates a bind-mounted host directory owned by
root, which that uid could not then write into, and this cache is never
operator-facing (only `api` and `indexer` ever touch it). A one-shot
`thumbs-init` service chowns the named volume to that uid once, before
`indexer` starts, the same pattern `compose.dev.yaml`'s `sftpgo-seed` uses for
SFTPGo's own data volume; `indexer`'s `depends_on` waits for it to complete.
If you ever need the thumbnail cache on the host instead (for example to
inspect it directly), replace the `fdrive-thumbs` named volume with a bind
mount and either pre-create that directory owned by the indexer uid, or add an
equivalent `chown`-only init step ahead of it.

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

Updating a running deployment is `git pull` plus the same `up -d --build`
with **every** file and profile you normally pass; a forgotten `-f` silently
detaches the services it defines and a forgotten `--profile` leaves those
services on old images. `update.sh` in this directory does exactly that and
fails when the API does not answer its health check afterwards:

```sh
FDRIVE_COMPOSE_FILES="compose.sftpgo-network.yaml" FDRIVE_PROFILES="index" ./deploy/update.sh
```

Both selectors may also be set once in `deploy/.env` (the script reads only
those two keys from it), so a host needs no wrapper: `./deploy/update.sh`.

Migrations run on API start. When `SFTPGO_URL` and `FDRIVE_HOME_TEMPLATE` are
set in `.env`, the API records the connection on first boot and there is no
setup token or `/setup` wizard: sign in with a normal SFTPGo account. The home
template syntax is `<root>:<path with {username}>`, for example
`sftpgo:/{username}`, which with `FDRIVE_INDEX_SFTPGO_DIR` set to the parent of
the per-user homes maps every user to their own directory.

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

Consequences of that cookie rule worth knowing before you hand out URLs:

- A plain-HTTP address such as `http://<lan-ip>:8090` cannot sign in once
  `FDRIVE_COOKIE_SECURE=true`: the browser refuses a `Secure` cookie over
  HTTP. Treat the published port as the edge proxy's upstream only, and give
  users the HTTPS hostname.
- Caddy stamps `X-Forwarded-Proto: https` on everything it forwards, so any
  client that reaches the published port directly is treated as if it came
  through the edge. Bind it to loopback, a private interface, or a firewalled
  address accordingly.
- `FDRIVE_TRUSTED_PROXY_HOPS` counts the proxies that append to
  `X-Forwarded-For`: the bundled Caddy is one, an edge proxy in front of it
  makes two. Requests that skip the edge carry fewer hops and fall back to
  the socket peer for rate limiting, so all of them share one limiter key.

Every port this stack publishes to the host is loopback-bound
(`127.0.0.1:...`) by default, on the assumption that the edge proxy runs on
the same host and reaches these services over `localhost`. When the edge
proxy itself runs in a container on a bridge network (Nginx Proxy Manager
is the common case), its `127.0.0.1` is its own loopback, not the host's:
set `FDRIVE_HTTP_BIND` to the host address the proxy can reach, and keep
that port firewalled from anything but the proxy if the host is exposed.
Hosts whose root filesystem is ephemeral (Unraid keeps `/` on a RAM disk)
need the clone, `.env`, the data directory and any deploy key on persistent
storage, not under `/opt` or `/root`:

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

## Container hardening

Every service in `compose.yaml` and `office/compose.services.yaml` runs with
`security_opt: no-new-privileges:true`, `cap_drop: [ALL]`, a `pids_limit` of
`512`, and json-file log rotation (`max-size: 10m`, `max-file: 3`, via the
shared `x-logging` anchor). Capabilities are added back only where a service
demonstrably fails to start without them:

- `proxy` (Caddy): `NET_BIND_SERVICE`, since its binary carries a file
  capability requiring it to bind `:80` even as root; `cap_drop: [ALL]`
  strips that from the container's bounding set otherwise, and Caddy refuses
  to `exec` at all ("operation not permitted"), not just to bind the port.
- `db` (Postgres): `CHOWN`, `FOWNER`, `DAC_OVERRIDE`, `SETUID`, `SETGID`, for
  the upstream entrypoint script's one-time permission fixup and privilege
  drop from root to the `postgres` user on first start.
- `embed` (the embeddings server) also binds a low port (`:80`) as root but,
  verified empirically, does not need `NET_BIND_SERVICE` added back to do
  so.

`web`'s `Content-Security-Policy` header (`apps/web/next.config.ts`) only
allows the office editor iframe to load when the image was built with
`--build-arg FDRIVE_OFFICE_PUBLIC_URL=...` (matching the `api` service's own
`FDRIVE_OFFICE_PUBLIC_URL`, see `compose.office.yaml`/
`compose.office.collabora.yaml`): like `API_INTERNAL_URL`, this is read once
at `next build` time, not from the running container's environment, so
setting it only in `web`'s `environment:` block has no effect. Neither office
overlay currently passes this `build.args` value to the `web` service; add it
there before relying on office editing with this CSP in place, or the
editor's iframe will be blocked by `frame-src`.

`web` and `proxy` additionally run `read_only: true` with a `tmpfs` for
`/tmp` (and, for `proxy`, `/config/caddy` and `/data/caddy`, which Caddy would
otherwise try to write its autosave config and TLS state into; this
deployment uses neither, see "TLS and network placement" above). `web`
carries a `HEALTHCHECK` (`apps/web/Dockerfile`, hitting `/login` with
Node's own `fetch`, since the Alpine base has neither `curl` nor `wget`);
`proxy`'s `depends_on` waits for both `api` and `web` to report healthy
before starting, so it never proxies to a backend that is not actually
serving yet.

Validate all of this without starting anything:

```sh
docker compose -f compose.yaml config -q
```

Bring up just the core stack and confirm every container reports healthy:

```sh
docker compose -f compose.yaml up -d proxy web api db
docker compose -f compose.yaml ps
```

## Pinned image digests

Every base and third-party image below is pinned by tag and `@sha256:`
digest, so a rebuild never silently picks up a new release. Re-resolve and
bump the digest deliberately (`docker buildx imagetools inspect
<image>:<tag>`) when you want to move to a newer version.

| Image | Tag | Digest | Used by |
| --- | --- | --- | --- |
| `caddy` | `2` | `sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d` | `compose.yaml` (`proxy`) |
| `pgvector/pgvector` | `pg17` | `sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f` | `compose.yaml` (`db`) |
| `apache/tika` | `3.2.1.0` | `sha256:df12b41af58c9833e60bdc231ffc4b59f5b7a83bfe2d63e3dc7aab7da923abba` | `compose.yaml` (`tika`) |
| `ghcr.io/huggingface/text-embeddings-inference` | `cpu-1.9.2` | `sha256:16230cd8f679ae5f8a51d585033628b1c0d45cd70c2bc9b0d208170d71218fdb` | `compose.yaml` (`embed`) |
| `node` | `24-alpine` | `sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf` | `apps/web/Dockerfile` |
| `python` | `3.12-slim` | `sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea` | `services/indexer/Dockerfile` |
| `jbarlow83/ocrmypdf` | `v17.11.0` | `sha256:c6bcc39ae87cccdbf243d62dba39032a3aacd8a1463365170db3604139aba977` | `services/ocr/Dockerfile` |
| `onlyoffice/documentserver` | `9.4.0.1` | `sha256:3ab6ebc7c605e5a32b7ae3ff19daed4925090245acc8100ce2230bd766c88212` | `office/compose.services.yaml` (`onlyoffice`) |
| `collabora/code` | `26.04.3.2.1` | `sha256:379b8f1fc955dd6d01ba24adf61d1b177048ddaae179ae8c1e6a6342daccb282` | `office/compose.services.yaml` (`collabora`) |

`node:24-alpine` also backs `apps/api/Dockerfile`'s build and runtime
stages; that Dockerfile is outside this chunk's scope (see the hardening
review), so its own `FROM` lines were not repinned here and should get the
same digest above in a follow-up.
