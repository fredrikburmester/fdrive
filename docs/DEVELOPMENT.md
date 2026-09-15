# Developer Guide

Current design: [Architecture](ARCHITECTURE.md). Unfinished work: [Plans](plans/README.md).

This guide covers running fdrive locally for development with hot reloading, seeded test accounts, and integration test environments.

For backend extensions, see [Adding a storage provider](STORAGE-PROVIDERS.md): package setup,
module contracts, registration, capability limits and verification.

---

## Prerequisites

- **Node.js**: Node 24 (pinned in `.node-version` / `.nvmrc`)
- **Package manager**: `pnpm` (version 10+)
- **Docker**: Docker Desktop or Docker Engine running

---

## Quick Start (3 Steps)

### 1. Install dependencies & start the dev database
From the repository root:

```bash
pnpm install
pnpm dev:env
```

`pnpm dev:env` starts a local Postgres database and a pre-seeded SFTPGo container with test users, sample documents, and folders. It also automatically generates your local development `.env` files.

### 2. Start the dev servers
Open two terminal windows (or use background tasks):

```bash
# Terminal 1: API backend (starts on http://localhost:3001)
pnpm --filter @fdrive/api dev

# Terminal 2: Web frontend (starts on http://localhost:3000)
pnpm --filter @fdrive/web dev
```

### 3. Open in browser
Visit **`http://localhost:3000`** and log in with any of the seeded development accounts:

| Username | Password | Role / Setup |
| :--- | :--- | :--- |
| **`dev`** | `dev` | **Admin user**, sample photos, documents, and spreadsheets. |
| **`alice`** | `alice-password` | Standard user with documents and photos. |
| **`bob`** | `bob-password` | Restricted permissions (read-only root, upload to `/inbox`). |
| **`carol`** | `carol-password` | User with a virtual folder mapping. |

---

## Turning on Search Locally (Optional)

By default, `pnpm dev:env` skips the heavy AI models so it starts in seconds. To test search, thumbnails, and OCR locally:

```bash
docker compose -f deploy/compose.dev.yaml --profile index up -d
```

Restart the API server (`pnpm --filter @fdrive/api dev`) so it connects to the local indexer and embedding services.

---

## Local Ports

| Service | Port | Description |
| :--- | :--- | :--- |
| Web UI | `3000` | Next.js frontend |
| API | `3001` | Hono API server |
| Postgres | `55432` | Local development database |
| SFTPGo WebAdmin | `58080` | SFTPGo admin interface (`admin` / `admin-dev-password`) |
| SFTPGo SFTP | `52022` | SFTP service for external client testing |
| Indexer HTTP | `58010` | Python indexer (when `index` profile is up) |
| Embedding Server | `58081` | TEI text embedding model |
| Image Embedding | `58012` | SigLIP image embedding model |

---

## Quality Gates & Verification Scripts

We maintain strict quality gates across the codebase. Run these checks before submitting any pull request:

```bash
# Code formatting & linting (Biome):
pnpm lint
pnpm lint:fix

# TypeScript typechecking:
pnpm typecheck

# Unit tests:
pnpm test

# Unit test coverage (enforces strict per-package thresholds):
pnpm test:coverage

# Container-backed integration tests (requires Docker):
pnpm test:integration

# Playwright browser end-to-end suite:
pnpm --filter @fdrive/web test:e2e
```

---

## Resetting Development Data

- **Stop containers (keep data)**:
  ```bash
  pnpm dev:env:down
  ```
- **Wipe all development data and re-seed from scratch**:
  ```bash
  pnpm dev:env:reset
  ```

## Development ports and worker probes

Set `FDRIVE_DEV_API_PORT`, `FDRIVE_DEV_DB_PORT`, `FDRIVE_DEV_SFTPGO_HTTP_PORT`,
`FDRIVE_DEV_INDEXER_HTTP_PORT`, `FDRIVE_DEV_OCR_HTTP_PORT`, `FDRIVE_DEV_EMBED_PORT`,
`FDRIVE_DEV_IMAGE_EMBED_PORT` and `FDRIVE_DEV_TIKA_PORT` before generating a fresh
environment. `pnpm dev:env` uses those same overrides for the API/web URLs and
compose publishes. Existing environment assignments are preserved; update them
when changing ports in an already configured checkout.

The dev stack serves workers directly. `FDRIVE_TIKA_URL` points to its published
Tika port. Production compose supplies `FDRIVE_EMBED_RUNTIME_URL`,
`FDRIVE_IMAGE_EMBED_RUNTIME_URL` and `FDRIVE_TIKA_RUNTIME_URL` for controller status.
These URLs are explicit: a published worker port does not imply a controller port.
Unmanaged workers have no configuration revision; managed workers must acknowledge it.
