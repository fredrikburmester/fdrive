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

`pnpm dev:env` generates your local development `.env` files, starts a local Postgres database,
copies the committed dev files (`deploy/dev/files`, one folder per user) into the gitignored
`deploy/dev/.data/files` that the API serves as its local folder (`FDRIVE_STORAGE_ROOT`), and
creates the dev users in `app.local_users` (`pnpm dev:users`). Files you change in the dev app
never touch the committed seed. Once a user exists, the setup wizard is skipped.

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
| **`dev`** | `dev` | **Administrator** (`FDRIVE_ADMIN_USERS`), sample photos, documents, and spreadsheets. |
| **`alice`** | `alice-password` | Standard user with documents and a photo. |
| **`bob`** | `bob-password` | Standard user with `inbox` and `public` folders. |
| **`carol`** | `carol-password` | Standard user with one file; share a folder with her to try **Shared with me**. |

These are the fixtures the automated tests use (`@fdrive/testkit`), plus `dev`. Add more under
**System > Users**.

---

## Turning on Search Locally (Optional)

By default, `pnpm dev:env` skips the heavy AI models so it starts in seconds. To test search, thumbnails, and OCR locally:

```bash
docker compose -f deploy/compose.dev.yaml --profile index up -d
```

Restart the API server (`pnpm --filter @fdrive/api dev`) so it connects to the local indexer and embedding services.

---

## Trying the WebDAV Provider Locally (Optional)

A local Apache `mod_dav` server, the one the WebDAV provider's integration tests use:

```bash
docker compose -f deploy/compose.dev.yaml --profile webdav up -d
```

Under **System > Storage**, add a `WebDAV` provider at `http://localhost:58082/dav/` and sign in
as `dev` with the password `dev-webdav-password`. See [WebDAV](WEBDAV.md).

---

## Trying the S3 Provider Locally (Optional)

A local MinIO with one bucket and one read-write key:

```bash
docker compose -f deploy/compose.dev.yaml --profile s3 up -d
```

Under **System > Storage**, add an `S3` provider at `http://localhost:59000/fdrive` and sign in with the access key `fdrive-dev` and secret `fdrive-dev-password`. The MinIO console is on port `59001` (`minio-root` / `minio-root-password`). See [S3](S3.md).

---

## Local Ports

| Service | Port | Description |
| :--- | :--- | :--- |
| Web UI | `3000` | Next.js frontend |
| API | `3001` | Hono API server |
| Postgres | `55432` | Local development database |
| WebDAV | `58082` | Apache `mod_dav` at `/dav/` (when `webdav` profile is up) |
| MinIO S3 API | `59000` | Local S3 bucket `fdrive` (when `s3` profile is up) |
| MinIO console | `59001` | MinIO web console (`minio-root` / `minio-root-password`) |
| Indexer HTTP | `58010` | Python indexer (when `index` profile is up) |
| ML server | `58012` | Text embeddings (`/text`), image embeddings (`/image`) and document extraction (`/extract`), when `index` profile is up |

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
- **Wipe all development data and re-seed from scratch** (a fresh database, a fresh copy of
  the dev files and the dev users again):
  ```bash
  pnpm dev:env:reset
  ```

## Development ports and worker probes

Set `FDRIVE_DEV_API_PORT`, `FDRIVE_DEV_DB_PORT`, `FDRIVE_DEV_INDEXER_HTTP_PORT`,
`FDRIVE_DEV_OCR_HTTP_PORT` and `FDRIVE_DEV_ML_PORT` before generating a fresh environment
(`FDRIVE_DEV_WEBDAV_PORT` and `FDRIVE_DEV_MINIO_PORT` move the optional profiles). `pnpm dev:env` uses those same overrides for the API/web URLs and
compose publishes. Existing environment assignments are preserved; update them
when changing ports in an already configured checkout.

The dev stack keeps every unit of the ml service on (`FDRIVE_ML_STATIC_UNITS`), and
`FDRIVE_EMBED_URL`, `FDRIVE_IMAGE_EMBED_URL` and `FDRIVE_TIKA_URL` point at its `/text`,
`/image` and `/extract` prefixes on the published port. Production compose also supplies
`FDRIVE_EMBED_RUNTIME_URL`, `FDRIVE_IMAGE_EMBED_RUNTIME_URL` and `FDRIVE_TIKA_RUNTIME_URL`,
where the server follows the owner's feature settings and must acknowledge their revision.
Units that are always on have no configuration revision.
