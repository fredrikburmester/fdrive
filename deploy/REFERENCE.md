# Advanced Deployment Reference

This document provides architectural and operational details for advanced deployments, custom reverse proxies, security hardening, and multi-node setups. For the primary setup guide, see **[deploy/README.md](README.md)**.

---

## Compose Files Overview

| File | Purpose |
| :--- | :--- |
| `compose.yaml` | **The fdrive stack**: proxy, web, API, database and idle optional-worker controllers, from the [published images](#published-images). Models and processing stay off until selected in the UI. |
| `compose.sftpgo.yaml` | **Optional SFTPGo**: runs an SFTPGo container alongside fdrive for people who don't have one yet. See [bundled SFTPGo](#bundled-sftpgo). |

Each release attaches both files. Add an overlay by saving it next to `compose.yaml` and
listing both in Compose's own `COMPOSE_FILE` in `.env`, for example
`COMPOSE_FILE=compose.yaml:compose.sftpgo.yaml`; every `docker compose` command then includes
it. The [SFTPGo network](#existing-sftpgo-docker-network) and
[named volume](#processing-storage-and-permissions) overlays below work the same way.

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
| `ghcr.io/fredrikburmester/fdrive-tika`, `-embed`, `-image-embed`, `-onlyoffice` | Apache Tika, text embeddings, image embeddings and ONLYOFFICE, each behind the controller that starts it only while its feature is enabled |

Tags: `X.Y.Z` for a release, `X.Y` for the newest patch of that minor release, `latest` for
the newest release, and `main` plus `sha-<commit>` for builds of the main branch. Every image
records its source commit in its OCI labels and carries a build provenance attestation.
Upstream text-embeddings-inference publishes amd64 only, so the `arm64` variant of
`fdrive-embed` is built from its pinned source. How releases are cut:
[releases](../docs/RELEASES.md).

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
    │  └────┬─────┘ ────► [SFTPGo API (Port 8080)]
    │       │       ────► [Sidecars: Indexer, Embed, OCR]
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
- **Direct Storage Proxy**: All user file interactions (downloads, streaming, uploads) are authenticated by fdrive and proxied directly through SFTPGo's user REST API.

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

- **Startup Summary**: At launch, `docker compose logs api` logs the exact status of each subsystem (`search`, `indexer`, `ocr`, `office`, `trash`). If a variable is missing, it explicitly logs `missing=VARIABLE_NAME`.
- **ONLYOFFICE:** the bundled controller is healthy while disabled. Enable in **System > Features**; the document engine starts on demand. Readiness is shown in those settings. See [Office setup](../docs/OFFICE.md).
- **Trash:** startup health means its integration is available, not enabled. The saved choice is in **System > Features > Trash**; user capability is reported by `/api/v1/trash/status`.
- **Optional-worker controllers:** the Tika, embedding, image-embedding and Office containers run a small controller that starts the model or engine only while the matching feature is enabled. Each controller reports at `GET /runtime` on its own port with `status` (`preparing`, `ready`, `off`, `stopping`, `failed`), `attempts` and `error`; **System > Features** shows that state per feature. Startup is bounded: after three failed child starts the controller reports `failed` and waits `FDRIVE_RUNTIME_RETRY_AFTER_SECONDS` (default 300) before trying again, so a machine that is briefly out of memory or slow to pull a model recovers without an operator restarting anything. Saving features in the UI clears the wait immediately. The controller also distinguishes an API that answers with a document it must reject (stopped after `FDRIVE_RUNTIME_STALE_SECONDS`, default 9) from an API it could not reach at all (`FDRIVE_RUNTIME_UNREACHABLE_SECONDS`, default 60): a loaded host makes the API slow, and stopping a healthy worker for that reloads a model, which loads the host further. Both still fail closed. A `failed` status persisting across several windows means the child itself cannot start; read that container's logs.
- **Postgres restarts:** the indexer, OCR worker and API reopen their database connections when postgres goes away, for example after `docker compose up -d --force-recreate db`. While the database is down the indexer's `/health` returns 500 and its container reports unhealthy; both recover on the next probe after postgres accepts connections. No container needs to be restarted by hand.
- **Health Check Endpoint**: `GET /api/v1/health` is an unauthenticated JSON endpoint returning status (`configured`, `not_configured`, `unreachable`, `failed`) for all services. `failed` means the worker is down and its controller reports why, with the controller's reason in `detail` (for example `worker exceeded bounded startup retries`), so a worker the controller gave up on is distinguishable from a network problem. The same reason appears in the feature's detail line on **System > Features**.
- **Web UI Diagnostics**: Administrators can view real-time health, queue depths, and error logs for all components in the **System** section of the sidebar.
- **Processing failures**: Thumbnails, Full-text search, Semantic search and Image search
  retain per-file causes in PostgreSQL. **View failures** groups causes, shows paths and
  attempts, and retries unresolved files. Details remain readable with the indexer stopped.
  Unresolved records are retained; resolved history is limited to 30 days / 10,000 records.
- **Indexer diagnostic retention**: `fdrive-indexer-logs` is a persistent Compose volume
  mounted at `/logs`, initialized for `FDRIVE_INDEX_UID`. `indexer.log` plus four rotated
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
| `FDRIVE_EMBED_THREADS` | `4` | TEI's `RAYON_NUM_THREADS` and `TOKENIZATION_WORKERS`. |
| `FDRIVE_IMAGE_EMBED_THREADS` | `4` | `IMAGE_EMBED_THREADS` and `OMP_NUM_THREADS` for the SigLIP sidecar. |
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
| `tika` | `FDRIVE_TIKA_CPUS` | `FDRIVE_TIKA_MEMORY` | unlimited |
| `onlyoffice` | `FDRIVE_ONLYOFFICE_CPUS` | `FDRIVE_ONLYOFFICE_MEMORY` | unlimited |
| `embed` | `FDRIVE_EMBED_CPUS` | `FDRIVE_EMBED_MEMORY` | `4g` |
| `image-embed` | `FDRIVE_IMAGE_EMBED_CPUS` | `FDRIVE_IMAGE_EMBED_MEMORY` | `6g` |

Set the CPU caps when you want a guaranteed free core, and keep at least one: leaving one core
free is the difference between a slow box and one you cannot log in to. `tika` additionally
takes `FDRIVE_TIKA_JAVA_OPTS` (passed as `JAVA_TOOL_OPTIONS`) — a JVM with no container memory
limit sizes its heap from host RAM, so set `FDRIVE_TIKA_MEMORY` or an explicit `-Xmx`.

---

## Container Hardening & Security

All services are hardened following security best practices:

- **Dropped Linux Capabilities**: Containers drop all capabilities by default (`cap_drop: [ALL]`), adding back only minimal requirements (such as `NET_BIND_SERVICE` for Caddy).
- **No New Privileges**: `security_opt: no-new-privileges:true` is enforced across all services.
- **Read-Only Root Filesystems**: Front-facing containers run with read-only root filesystems and isolated temporary `tmpfs` mounts.
- **Log Rotation**: Built-in JSON log rotation (`max-size: 10m`, `max-file: 3`) prevents disk exhaustion.
- **Pinned Image Digests**: All base images and third-party containers are pinned with exact `@sha256:` immutable digests in compose files to ensure reproducible builds.
- **Versioned fdrive Images**: fdrive's own images are built in CI from the tagged commit and referenced by release version; `compose.yaml` runs the newest release unless `FDRIVE_VERSION` pins one.

## Processing storage and permissions

Follow [installation step 2](README.md#2-mount-sftpgos-files-optional)
for the standard bind mount. `FDRIVE_DATA_DIR` stores fdrive state;
`FDRIVE_INDEX_SFTPGO_DIR` supplies existing user files. They are different settings.
Setting only the former never attaches SFTPGo storage.

Check permissions using the actual worker identities:

```sh
docker compose exec -T indexer id
docker compose exec -T ocr id
```

`FDRIVE_INDEX_UID` sets the UID and GID the indexer runs as, and owns its thumbnail and
log volumes; its default is 1000, the UID of SFTPGo's official image. It does not configure
the OCR worker, which runs as UID 1000. Verify both rather than assuming they run as
SFTPGo's user. Give the indexer read/traverse access and, if PDF conversion will be used,
give the OCR worker read/write/traverse access through the host's existing permission
model. Do not recursively change ownership of the SFTPGo library to make an installation
succeed. Run `docker compose up -d` after changing `FDRIVE_INDEX_UID` to recreate the
indexer.

For an account whose home is not named after its username, an administrator can set a
per-account mapping in **Account** after setup. **System > Connection** also contains
the common home template. Correct the underlying worker mount first: an account override
cannot expose a host directory that is absent from the container. Existing SFTPGo virtual
folders need their own mapping (next section); do not assume one user's successful check
proves every account and virtual folder is configured.

### SFTPGo virtual folders

A virtual folder is not a directory inside the user's home on disk: SFTPGo mounts a
separate `mapped_path` at a virtual path (for example `/shared`). The indexer only sees
what is under a configured root, so search, thumbnails, duplicates, folder sizes, and MCP
work for a virtual folder only when **both** of these hold:

1. The folder's SFTPGo `mapped_path` sits inside a configured `FDRIVE_INDEX_ROOTS` root,
   or it has a root of its own plus a matching indexer bind mount
   (`<host path>:/roots/<name>:ro`, see [multiple roots](../docs/INDEXER.md#multiple-roots)).
2. An administrator maps it once, in **Account**, under any login's index status that names
   the folder: choose the root and enter the physical prefix, the folder's path inside that
   root. By default the mapping is saved as a **shared folder mapping** and every login that
   mounts the same virtual path adopts it automatically, but only while SFTPGo actually
   shows that folder in the login's files and the index lacks it there. A real directory of
   the same name in someone's home is never affected. The same physical folder is indexed
   once, and each user's SFTPGo permissions still apply to results. Untick "Apply to every
   login" to store the mapping for one login only. Shared folder mappings are listed and
   removed under **System > Connection**.

fdrive cannot read a folder's `mapped_path`: that is only available through SFTPGo's admin
API, which fdrive never uses. The physical prefix is therefore always confirmed by a human.
fdrive does propose it: it lists the folder over SFTP and offers indexed directories whose
files match, confirmed against the indexer's own listing. A folder with no files at its top
level gets no suggestion. Until a mapping exists, the account's status names the mount
(`/shared is not indexed`) and the home scope keeps its index-backed features; the unmapped
folder alone stays out of search. If the folder deliberately lives outside every indexed
root, mark it **Not indexed** on the same page so it stops being reported.

The dev stack satisfies constraint 1 by placing folders under `_folders/` inside
`/srv/sftpgo/data`, the one seeded root, so the mapping for `carol`'s `/shared` is root
`sftpgo`, physical prefix `/_folders/shared`. A production deployment gets none of this for
free: a folder mapped elsewhere on the host needs its own root and mount before any
account mapping can verify.

For SFTPGo backed by a Docker named volume, explicitly share that existing volume through
an overlay instead of depending on Docker's internal volume directory. Example
`compose.storage.yaml` next to `compose.yaml`:

```yaml
services:
  indexer:
    volumes:
      - existing-files:/roots/sftpgo:ro
  ocr:
    volumes:
      - existing-files:/roots/sftpgo
volumes:
  existing-files:
    external: true
    name: replace-with-existing-volume-name
```

The volume must already hold SFTPGo's user files. Set `FDRIVE_INDEX_SFTPGO_PATH` to their
location inside SFTPGo. Add `compose.storage.yaml` to `COMPOSE_FILE` in `.env`, keeping any
other overlays, and check both mounts in `docker compose config` before starting.
A remote host path or S3 bucket is not a local Docker volume: browsing can work without
local processing, but this stack does not automatically mirror remote files.

## Existing SFTPGo Docker network

To reach SFTPGo by container name instead of a published HTTP port, attach fdrive's API to
SFTPGo's Docker network. Save this as `compose.sftpgo-network.yaml` next to `compose.yaml`,
with that network's name:

```yaml
services:
  api:
    networks:
      - default
      - sftpgo
networks:
  sftpgo:
    external: true
    name: replace-with-sftpgo-network
```

Add it to `COMPOSE_FILE` in `.env`, for example
`COMPOSE_FILE=compose.yaml:compose.sftpgo-network.yaml`, keeping any other overlays. Run
`docker compose up -d`, then enter SFTPGo's container name and internal HTTP port, such as
`http://sftpgo:8080`, during setup.

This only connects fdrive's API to SFTPGo; it doesn't mount SFTPGo's files, which is the
separate storage step above. SFTPGo's own configuration doesn't change.

## Bundled SFTPGo

Use this only when the operator has no existing SFTPGo service. Download
`compose.sftpgo.yaml` from the same release next to `compose.yaml`, then in `.env` configure:

```dotenv
COMPOSE_FILE=compose.yaml:compose.sftpgo.yaml
FDRIVE_DATA_DIR=/srv/fdrive-state
FDRIVE_INDEX_SFTPGO_DIR=/srv/fdrive-state/sftpgo/data
SFTPGO_ADMIN_USERNAME=admin
SFTPGO_ADMIN_PASSWORD=replace-with-a-strong-unique-password
```

These paths are examples. The processing source must match the bundled SFTPGo data
mount, which is `FDRIVE_DATA_DIR/sftpgo/data`. Create that directory as part of this **new**
SFTPGo deployment, with appropriate service permissions. Keep any other overlays in
`COMPOSE_FILE`. Leave `SFTPGO_URL` unset so fdrive uses web onboarding.

Run `docker compose up -d`. The bundled WebAdmin defaults to the host's loopback port 8091;
access it through the operator's chosen tunnel/proxy or deliberately configure its bind
address. Create a normal file user in SFTPGo with a home such as `/srv/sftpgo/data/alice`. Then open
fdrive, connect to `http://sftpgo:8080`, and verify that file user as fdrive's administrator.
The SFTPGo WebAdmin account and fdrive's chosen file-user account are separate.

## Native ARM64 embeddings

The published `fdrive-embed` image is native on Apple Silicon and other ARM64 hosts. Its
arm64 variant is built in CI from TEI's pinned upstream source with the same
multilingual-e5-small model, so embeddings match those made on amd64 and no overlay is
needed.
