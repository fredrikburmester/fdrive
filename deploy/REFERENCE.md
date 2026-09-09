# Advanced Deployment Reference

This document provides architectural and operational details for advanced deployments, custom reverse proxies, security hardening, and multi-node setups. For the primary setup guide, see **[deploy/README.md](README.md)**.

---

## Compose Files Overview

| File | Purpose |
| :--- | :--- |
| `compose.yaml` | **Fixed fdrive stack**: Proxy, web, API, database, and idle optional-worker controllers. Models and processing stay off until selected in the UI. |
| `compose.arm64.yaml` | **Native ARM64 embeddings**: Builds pinned upstream TEI source with the same multilingual-e5-small model; layer over the fixed stack on ARM64 hosts. |
| `compose.sftpgo.yaml` | **Optional SFTPGo**: Boots an SFTPGo container alongside fdrive for users who don't already have one. |
| `compose.office.collabora.yaml` | **Optional Collabora**: Adds Collabora Online instead of ONLYOFFICE. |
| `compose.sftpgo-network.example.yaml` | Template showing how to attach the fdrive stack to an existing Docker bridge network containing your SFTPGo container. |
| `.env.example` | Minimal secrets-only quick start; configure SFTPGo and features in the walkthrough. |
| `init-env.sh` | Creates `deploy/.env` with one-time private bootstrap secrets; refuses to overwrite it. |
| `preflight.sh` | Sanity-checks `.env` syntax, keys, and values before Docker starts. |
| `update.sh` | Pulls updates, rebuilds images, runs preflight, and safely restarts containers. |

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

When placing an HTTPS reverse proxy (Nginx, Caddy, Traefik, NPM) in front of fdrive,
set the address users reach it at in `deploy/.env`, then run `./update.sh`:

```dotenv
FDRIVE_PUBLIC_URL=https://drive.example.com
```

The bundled proxy derives the browser-facing scheme from that URL and sends it to every
service as `X-Forwarded-Proto`; the api derives Secure cookies from it and the bundled
ONLYOFFICE builds every browser-facing URL from it. Without an `https://` public URL
behind an HTTPS edge, the editor is handed `http://` document URLs that the browser
blocks as mixed content ("Download failed" with clean server logs). The header a client
or the edge proxy sends is replaced, never trusted. (`FDRIVE_PROXY_SCHEME` used to set
this separately; `preflight.sh` now rejects it.)

Leave `FDRIVE_COOKIE_SECURE` at its `auto` default: direct LAN HTTP works without a
public URL, and an HTTPS public URL makes sessions use Secure cookies.
Keep direct LAN HTTP behind your home network firewall; use HTTPS for internet access.

### Proxy Requirements
1. **WebSocket Support**: Ensure WebSocket forwarding is enabled (required for ONLYOFFICE live collaboration).
2. **Large Uploads**: Set client max body size to unlimited or your desired maximum upload limit (e.g. `client_max_body_size 0;` in Nginx).
3. **Forwarding Headers**: Send standard `X-Forwarded-For` and `X-Forwarded-Proto` headers.

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
- **Health Check Endpoint**: `GET /api/v1/health` is an unauthenticated JSON endpoint returning status (`configured`, `not_configured`, `unreachable`) for all services.
- **Web UI Diagnostics**: Administrators can view real-time health, queue depths, and error logs for all components in the **System** section of the sidebar.

---

## Container Hardening & Security

All services are hardened following security best practices:

- **Dropped Linux Capabilities**: Containers drop all capabilities by default (`cap_drop: [ALL]`), adding back only minimal requirements (such as `NET_BIND_SERVICE` for Caddy).
- **No New Privileges**: `security_opt: no-new-privileges:true` is enforced across all services.
- **Read-Only Root Filesystems**: Front-facing containers run with read-only root filesystems and isolated temporary `tmpfs` mounts.
- **Log Rotation**: Built-in JSON log rotation (`max-size: 10m`, `max-file: 3`) prevents disk exhaustion.
- **Pinned Image Digests**: All base images and third-party containers are pinned with exact `@sha256:` immutable digests in compose files to ensure reproducible builds.

## Processing storage and permissions

Follow [installation step 3](README.md#3-prepare-file-access-before-offering-processing-features)
for the standard bind mount. `FDRIVE_DATA_DIR` stores fdrive state;
`FDRIVE_INDEX_SFTPGO_DIR` supplies existing user files. They are different settings.
Setting only the former never attaches SFTPGo storage.

Check permissions using the actual worker identities:

```sh
docker compose -f compose.yaml exec -T indexer id
docker compose -f compose.yaml exec -T ocr id
```

`FDRIVE_INDEX_UID` sets the indexer image's UID and GID at build time; its default is
1000. It does not configure the OCR image's identity. Verify both rather than assuming
they run as SFTPGo's user. Give the indexer read/traverse access and, if PDF conversion
will be used, give the OCR worker read/write/traverse access through the host's existing
permission model. Do not recursively change ownership of the SFTPGo library to make
an installation succeed. Rebuilding is required after changing the indexer build UID.

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
2. An administrator maps it for each account that mounts it, in **Account**, under the
   login's index status: choose the root and enter the physical prefix, the folder's path
   inside that root. The same physical folder is indexed once; every account that mounts
   it carries its own mapping, and each user's SFTPGo permissions still apply to results.

fdrive cannot read a folder's `mapped_path`: that is only available through SFTPGo's admin
API, which fdrive never uses. The physical prefix is therefore always supplied by a human.
Until it is, the account's status names the mount (`/shared is not indexed`) and the home
scope keeps its index-backed features; the unmapped folder alone stays out of search. If
the folder deliberately lives outside every indexed root, mark it **Not indexed** on the
same page so it stops being reported.

The dev stack satisfies constraint 1 by placing folders under `_folders/` inside
`/srv/sftpgo/data`, the one seeded root, so the mapping for `carol`'s `/shared` is root
`sftpgo`, physical prefix `/_folders/shared`. A production deployment gets none of this for
free: a folder mapped elsewhere on the host needs its own root and mount before any
account mapping can verify.

For SFTPGo backed by a Docker named volume, explicitly share that existing volume through
an overlay instead of depending on Docker's internal volume directory. Example
`compose.storage.yaml` in `deploy`:

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
location inside SFTPGo. Add `compose.storage.yaml` to `FDRIVE_COMPOSE_FILES` in `.env`,
retaining any other overlays. Verify both rendered mount destinations before starting.
A remote host path or S3 bucket is not a local Docker volume: browsing can work without
local processing, but this stack does not automatically mirror remote files.

## Existing SFTPGo Docker network

If using the container-name URL instead of a published host HTTP port:

1. Identify the existing Docker network shared with SFTPGo.
2. Copy `compose.sftpgo-network.example.yaml` to `compose.sftpgo-network.yaml` and replace
   the example external network name with that existing network.
3. Add `compose.sftpgo-network.yaml` to `FDRIVE_COMPOSE_FILES` in `deploy/.env`. Preserve
   any other filenames already in that space-separated list.
4. Run `./update.sh`, then enter SFTPGo's network name and HTTP port in web onboarding.

This attaches fdrive's API to the network; it does not mount SFTPGo's files. Processing
storage remains the separate deployment input described above. No SFTPGo configuration
change is required to use its existing network.

## Bundled SFTPGo

Use this only when the operator has no existing SFTPGo service. In `deploy/.env`, configure:

```dotenv
FDRIVE_COMPOSE_FILES=compose.sftpgo.yaml
FDRIVE_DATA_DIR=/srv/fdrive-state
FDRIVE_INDEX_SFTPGO_DIR=/srv/fdrive-state/sftpgo/data
SFTPGO_ADMIN_USERNAME=admin
SFTPGO_ADMIN_PASSWORD=replace-with-a-strong-unique-password
```

These paths are examples. The processing source must match the bundled SFTPGo data
mount, which is `FDRIVE_DATA_DIR/sftpgo/data`. Create that directory as part of this **new**
SFTPGo deployment, with appropriate service permissions. Keep existing overlay selections
when adding `compose.sftpgo.yaml`. Leave `SFTPGO_URL` unset so fdrive uses web onboarding.

Run `./update.sh`. The bundled WebAdmin defaults to the host's loopback port 8091; access
it through the operator's chosen tunnel/proxy or deliberately configure its bind address.
Create a normal file user in SFTPGo with a home such as `/srv/sftpgo/data/alice`. Then open
fdrive, connect to `http://sftpgo:8080`, and verify that file user as fdrive's administrator.
The SFTPGo WebAdmin account and fdrive's chosen file-user account are separate.

## Native ARM64 embeddings

On Apple Silicon or other ARM64 hosts, use the native TEI override to avoid amd64
emulation. It retains the configured model, volumes and service limits, and builds
the pinned upstream source. First build requires network access and several minutes.

```bash
docker compose -f deploy/compose.yaml -f deploy/compose.arm64.yaml up -d --build embed
```

When using Compose directly, first run `./deploy/build-arm64-runtime.sh`; the
normal `./deploy/update.sh` detects `compose.arm64.yaml` automatically.

Optional processing starts off until selected in the walkthrough or System > Features.

For local development, replace `deploy/compose.yaml` with `deploy/compose.dev.yaml`.
This changes the embedding runtime only; existing embeddings remain compatible.
The performance harness selects this same runtime automatically on ARM64 hosts.
