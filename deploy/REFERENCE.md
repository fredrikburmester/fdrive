# Advanced Deployment Reference

This document provides architectural and operational details for advanced deployments, custom reverse proxies, security hardening, and multi-node setups. For the primary setup guide, see **[deploy/README.md](README.md)**.

---

## Compose Files Overview

| File | Purpose |
| :--- | :--- |
| `compose.yaml` | **Fixed fdrive stack**: Proxy, web, API, database, and idle optional-worker controllers. Models and processing stay off until selected in the UI. |
| `compose.arm64.yaml` | **Native ARM64 embeddings**: Builds pinned upstream TEI source with the same multilingual-e5-small model; layer over the fixed stack on ARM64 hosts. |
| `compose.sftpgo.yaml` | **Optional SFTPGo**: Boots an SFTPGo container alongside fdrive for users who don't already have one. |
| `compose.office.yaml` | **Optional ONLYOFFICE**: Adds ONLYOFFICE Document Server as a WOPI host for collaborative document editing. |
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
set these in `deploy/.env`, then run `./update.sh`:

```dotenv
FDRIVE_PUBLIC_URL=https://drive.example.com
FDRIVE_PROXY_SCHEME=https
```

Leave `FDRIVE_COOKIE_SECURE` at its `auto` default: direct LAN HTTP works with the
HTTP default, and the HTTPS proxy setting makes sessions use Secure cookies.
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
