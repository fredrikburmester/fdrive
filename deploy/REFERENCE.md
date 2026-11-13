# Advanced Deployment Reference

This document provides architectural and operational details for advanced deployments, custom reverse proxies, security hardening, and multi-node setups. For the primary setup guide, see **[deploy/README.md](README.md)**.

---

## Compose Files Overview

| File | Purpose |
| :--- | :--- |
| `compose.yaml` | **The fdrive stack**: proxy, web, API, database and idle optional-worker controllers, from the [published images](#published-images). Models and processing stay off until selected in the UI. |

Each release attaches it. Add an overlay by saving it next to `compose.yaml` and listing both
in Compose's own `COMPOSE_FILE` in `.env`, for example
`COMPOSE_FILE=compose.yaml:compose.office.collabora.yaml`; every `docker compose` command then
includes it.

---

## Published images

Each release publishes these images for `linux/amd64` and `linux/arm64` to the GitHub
Container Registry, built by [`.github/workflows/images.yml`](../.github/workflows/images.yml)
from the release's commit. `compose.yaml` runs them and needs no other file from the
repository.

| Image | Runs |
| :--- | :--- |
| `ghcr.io/fredrikburmester/fdrive-proxy` | Caddy with fdrive's routing ([`Caddyfile`](Caddyfile)), the one published port |
| `ghcr.io/fredrikburmester/fdrive-web` | The web interface |
| `ghcr.io/fredrikburmester/fdrive-api` | The API server; the `backup` service runs the same image as its worker |
| `ghcr.io/fredrikburmester/fdrive-indexer` | Text extraction, thumbnails and search indexing |
| `ghcr.io/fredrikburmester/fdrive-ocr` | Searchable PDF conversion |
| `ghcr.io/fredrikburmester/fdrive-ml` | Document text extraction, text embeddings and image embeddings in one server ([`services/ml`](../services/ml/README.md)), each loaded only while a feature that needs it is enabled |
| `ghcr.io/fredrikburmester/fdrive-onlyoffice` | ONLYOFFICE, behind the controller that starts it only while its feature is enabled |

Tags: `X.Y.Z` for a release, `X.Y` for the newest patch of that minor release, `latest` for
the newest release, and `main` plus `sha-<commit>` for builds of the main branch. Every image
records its source commit in its OCI labels and carries a build provenance attestation. How
releases are cut: [releases](../docs/RELEASES.md).

---

## How Requests Flow

```
[Browser / Mobile]
       │
       ▼ (Port 8090)
┌──────────────┐
│ Caddy Proxy  │
└───┬──────┬───┘
    │      │
    │ /api │ /mcp
    │      ▼
    │  ┌──────────┐
    │  │ Hono API │ ────► [Postgres DB (Port 5432)]
    │  └────┬─────┘ ────► [Files folder (/data)]
    │       │       ────► [Workers: Indexer, ML, OCR]
    │       ▼ (internal network only)
    │   [WOPI / Office Server]
    │
    ▼ (all other routes)
┌──────────────┐
│  Next.js Web │
└──────────────┘
```

- **Single Origin**: All traffic enters through Caddy on port `8090`. Caddy routes `/api/*` and `/mcp*` to the API container, and all page routes to Next.js.
- **Internal WOPI Communication**: Document server callbacks (`/wopi/*`) are routed entirely inside the private Docker bridge network (`http://api:3001/wopi`) and are never exposed publicly.
- **Files**: The API reads and writes the files folder itself, so every download, stream and upload is authenticated by fdrive and served from disk. The indexer reads the same folder; nothing else is in the path.

---

## Network Placement & Reverse Proxies

fdrive publishes port `8090` on all interfaces (`0.0.0.0`) by default. Open
`http://<server-ip>:8090` from another device on your network. `0.0.0.0` is a
listen address, not a browser URL. Override `FDRIVE_HTTP_PORT` to change the port.
For local-only access, explicitly set `FDRIVE_HTTP_BIND=127.0.0.1`.

An HTTPS reverse proxy (Nginx, Caddy, Traefik, NPM) in front of fdrive needs no
`.env` setting. The bundled proxy passes the edge's `X-Forwarded-Proto` through to
every service, so the api sets Secure cookies and the bundled ONLYOFFICE builds `https://`
browser URLs whenever the edge says the request was HTTPS, and direct LAN clients on
`http://<server-ip>:8090` keep working at the same time. Forwarded headers are honoured
from private-network peers only (where an edge proxy lives: the host, the LAN, or another
container); a LAN client forging `https` only breaks its own session.

The address everyone opens fdrive at is chosen in onboarding (afterwards in
**System > Features > Server address**), prefilled from the browser's own address. The
bundled editor is told fdrive lives there and links from connected assistants point there,
so onboard through the address others will use: behind an HTTPS edge, the `https://` one.
An `http://` address saved there hands the editor `http://` document URLs that an HTTPS
page blocks as mixed content ("Download failed" with clean server logs).

Leave `FDRIVE_COOKIE_SECURE` at its `auto` default. Keep direct LAN HTTP
behind your home network firewall; use HTTPS for internet access.

### Proxy Requirements
1. **WebSocket Support**: Ensure WebSocket forwarding is enabled (required for ONLYOFFICE live collaboration).
2. **Large Uploads**: Set client max body size to unlimited or your desired maximum upload limit (e.g. `client_max_body_size 0;` in Nginx).
3. **Forwarding Headers**: Send standard `X-Forwarded-For` and `X-Forwarded-Proto` headers. Both example configurations below do; NPM does by default.

### Reverse Proxy Configuration Examples

#### Caddy (Host)
```caddyfile
drive.example.com {
    reverse_proxy 127.0.0.1:8090
}
```

#### Nginx
```nginx
server {
    server_name drive.example.com;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 0;
    }
}
```

---

## Subsystem Health & Self-Diagnostics

fdrive actively monitors its internal subsystems on startup and exposes diagnostic endpoints:

- **Waiting for readiness**: `docker compose exec api node wait-ready.ts` polls until every
  enabled feature and Office report ready, then prints `Enabled subsystems ready.` After
  `FDRIVE_READY_TIMEOUT_SECONDS` (default 1200; pass it with `docker compose exec -e`) it
  fails and names what is still pending. It checks startup, not finished indexing or
  account-specific search results.

- **Startup Summary**: At launch, `docker compose logs api` logs the exact status of each subsystem (`search`, `indexer`, `ocr`, `office`, `trash`). If a variable is missing, it explicitly logs `missing=VARIABLE_NAME`.
- **ONLYOFFICE:** the bundled controller is healthy while disabled. Enable in **System > Features**; the document engine starts on demand. Readiness is shown in those settings. See [Office setup](../docs/OFFICE.md).
- **Trash:** startup health means its integration is available, not enabled. The saved choice is in **System > Features > Trash**; user capability is reported by `/api/v1/trash/status`.
- **Optional workers:** the `ml` service holds three units (document text extraction, text embeddings, image embeddings) and loads a model only while a feature that needs it is enabled; the Office container runs a small controller that does the same for the document engine. Each reports at `GET /runtime` (per unit under `/extract`, `/text` and `/image` on `ml`; on its own port for Office) with `status` (`preparing`, `ready`, `off`, `failed`; Office also `stopping`), `attempts` and `error`; **System > Features** shows that state per feature. Startup is bounded: after three failed attempts a worker reports `failed` and waits five minutes before trying again (`FDRIVE_RUNTIME_RETRY_AFTER_SECONDS` for Office), so a machine that is briefly out of memory or slow to download a model recovers without an operator restarting anything. Saving features in the UI clears the wait immediately. A worker also distinguishes an API that answers with a document it must reject (stopped after `FDRIVE_RUNTIME_STALE_SECONDS`, default 9) from an API it could not reach at all (`FDRIVE_RUNTIME_UNREACHABLE_SECONDS`, default 60): a loaded host makes the API slow, and stopping a healthy worker for that reloads a model, which loads the host further. Both still fail closed. A `failed` status persisting across several windows means the worker itself cannot start; read that container's logs.
- **Postgres restarts:** the indexer, OCR worker and API reopen their database connections when postgres goes away, for example after `docker compose up -d --force-recreate db`. While the database is down the indexer's `/health` returns 500 and its container reports unhealthy; both recover on the next probe after postgres accepts connections. No container needs to be restarted by hand.
- **Health Check Endpoint**: `GET /api/v1/health` is an unauthenticated JSON endpoint returning status (`configured`, `not_configured`, `unreachable`, `failed`) for all services. `failed` means the worker is down and its controller reports why, with the controller's reason in `detail` (for example `worker exceeded bounded startup retries`), so a worker the controller gave up on is distinguishable from a network problem. The same reason appears in the feature's detail line on **System > Features**.
- **Web UI Diagnostics**: Administrators can view real-time health, queue depths, and error logs for all components in the **System** section of the sidebar.
- **Processing failures**: Thumbnails, Full-text search, Semantic search and Image search
  retain per-file causes in PostgreSQL. **View failures** groups causes, shows paths and
  attempts, and retries unresolved files. Details remain readable with the indexer stopped.
  Unresolved records are retained; resolved history is limited to 30 days / 10,000 records.
- **Indexer diagnostic retention**: `fdrive-indexer-logs` is a persistent Compose volume
  mounted at `/logs`, handed to `FDRIVE_RUN_AS_UID` when the indexer starts. `indexer.log` plus four rotated
  files retain up to 50 MiB through restarts and container replacement. Read the current
  file with `docker compose exec indexer tail -n 200 /logs/indexer.log`. Normal updates
  preserve the volume; explicitly removing volumes removes this raw log history. Older
  lost logs cannot be reconstructed.

---

## Running version and uptime

The account menu's **About** page links to the project, feature guides, FDrive for macOS,
and Buy Me a Coffee. Server version is the release the API image was built as, such as
`0.1.0`, or `main` for the main branch, followed by its Git commit, linked. API uptime is
sampled when the page loads and resets on API restart; it is not host uptime.
`GET /api/v1/about` serves them as `release`, `revision` and `uptimeSeconds`, without probing
optional workers. Its `version`, like the health endpoint's, is the revision when known.

Published API images carry their release and the full Git SHA of the commit they were built
from, in the image and in its OCI version and revision labels. Development builds show
**Development** with their commit. Feature guides follow GitHub's `main` branch. The macOS
link opens the app guide, which includes its requirements and release instructions.

## Processing Worker Resource Limits

Every heavy container sizes its own concurrency from what it can see, and Docker shows it the
*host*, not its share of it. Memory limits alone do not help: nothing OOMs, so nothing
restarts, and the container simply consumes the machine while staying healthy. On a shared box
this has taken the host to a load average above 120 on 12 cores — SSH and the NAS web UI
unreachable — with every fdrive container healthy and `GET /api/v1/health` answering `ok`.
More than one worker can do this on its own, so treat it as a property of the stack rather
than of any single service.

The defaults bound *thread counts*, which needs no knowledge of the host:

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `FDRIVE_ML_THREADS` | `4` | One pool shared by the text and image embedding models, and the number of documents parsed at once. |
| `INDEX_WORKERS` | `4` | Indexer extractions in flight. Each is now one tesseract thread (`OMP_THREAD_LIMIT=1` is set in compose), so this is the real bound rather than a multiplier. |
| `OCR_JOBS` | `2` | `ocrmypdf --jobs` for the PDF-rewriting worker. |

Raise them on a dedicated machine; indexing throughput scales with them.

Hard caps are opt-in, and default to `0` — no limit, identical to the previous behaviour.
Docker rejects a `cpus:` value above the host's core count, so a shipped default would break
small hosts:

| Service | CPU | Memory | Memory default |
| :--- | :--- | :--- | :--- |
| `indexer` | `FDRIVE_INDEXER_CPUS` | `FDRIVE_INDEXER_MEMORY` | unlimited |
| `ocr` | `FDRIVE_OCR_CPUS` | `FDRIVE_OCR_MEMORY` | unlimited |
| `onlyoffice` | `FDRIVE_ONLYOFFICE_CPUS` | `FDRIVE_ONLYOFFICE_MEMORY` | unlimited |
| `ml` | `FDRIVE_ML_CPUS` | `FDRIVE_ML_MEMORY` | `6g` |

Set the CPU caps when you want a guaranteed free core, and keep at least one: leaving one core
free is the difference between a slow box and one you cannot log in to. `ml` holds about 1.7 GB
with image search on and about 1 GB more with semantic search; document extraction needs no
model.

---

## Container Hardening & Security

All services are hardened following security best practices:

- **Dropped Linux Capabilities**: Containers drop all capabilities by default (`cap_drop: [ALL]`), adding back only minimal requirements (such as `NET_BIND_SERVICE` for Caddy).
- **No New Privileges**: `security_opt: no-new-privileges:true` is enforced across all services.
- **Read-Only Root Filesystems**: Front-facing containers run with read-only root filesystems and isolated temporary `tmpfs` mounts.
- **Log Rotation**: Built-in JSON log rotation (`max-size: 10m`, `max-file: 3`) prevents disk exhaustion.
- **Pinned Image Digests**: All base images and third-party containers are pinned with exact `@sha256:` immutable digests in compose files to ensure reproducible builds.
- **Versioned fdrive Images**: fdrive's own images are built in CI from the tagged commit and referenced by release version; `compose.yaml` runs the newest release unless `FDRIVE_VERSION` pins one.

## Files folder and permissions

`FDRIVE_FILES_DIR` on the host (default `files` inside `FDRIVE_DATA_DIR`) is mounted at
`/data` read-write in the `api`, `backup` and `ocr` containers and read-only in the
`indexer`. Compose fixes the rest: `FDRIVE_STORAGE_ROOT=/data`, and one indexed root named
`files` at `/data` in both the API and the indexer. Each user's files are `/data/<username>`.

Users live in fdrive's database, with scrypt password hashes, and are added, reset and
disabled under **System > Users**. `FDRIVE_ADMIN_USERS` lists usernames that are always
administrators.

The four containers start as root for one step: each gives its own state directories to
`FDRIVE_RUN_AS_UID` (default 1000; `FDRIVE_INDEX_UID` is its older name) and then drops to
that user for good. The API also gives a new, empty files folder to that user, but never
changes the owner of files already there, and logs `cannot write /data` when that user
can't write it. The backup worker keeps one capability after the drop, reading any file,
because the state it backs up belongs to other services; it writes as the same user, so a
backup in someone's folder belongs to them. Check the user each process runs as:

```sh
docker compose exec -T api stat -c %u:%g /proc/1
docker compose exec -T indexer stat -c %u:%g /proc/1
```

These ask for the owner of the service process, because `id` would answer for the
container's starting user. Run `docker compose up -d` after changing `FDRIVE_RUN_AS_UID`.

Set `FDRIVE_RUN_AS_UID` to the owner of the existing files rather than changing ownership.
Anything else writing the folder, such as rsync, SMB or Syncthing, should write as that user
too, or leave group or other permissions that let it read and write; otherwise fdrive shows
those files but can't change them. A share the host mounts (NFS, SMB) works when its user
mapping gives `FDRIVE_RUN_AS_UID` that access.

## Native ARM64 embeddings

The published `fdrive-embed` image is native on Apple Silicon and other ARM64 hosts. Its
arm64 variant is built in CI from TEI's pinned upstream source with the same
multilingual-e5-small model, so embeddings match those made on amd64 and no overlay is
needed.
