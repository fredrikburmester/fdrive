# Local development

This is the one-command local environment: a seeded SFTPGo and Postgres in
Docker, running against the api and web dev servers on the host with hot
reload.

## Quick start

```sh
pnpm install
pnpm dev:env
```

`dev:env` does two things:

1. Creates `apps/api/.env.dev` and `apps/web/.env.local` if they do not
   already exist (both are gitignored; it never overwrites an existing
   file), generating a fresh `FDRIVE_MASTER_KEY` the first time.
2. Starts `db` (Postgres) and `sftpgo` (a seeded SFTPGo instance) with
   Docker Compose and waits for both to report healthy.

Then, in two more terminals (or via the `.claude/launch.json` configs "api"
and "web"):

```sh
pnpm --filter @fdrive/api dev
pnpm --filter @fdrive/web dev
```

The web app is at http://localhost:3000, and it proxies `/api/*` to the api
dev server at http://127.0.0.1:3001.

## Dev users

The SFTPGo instance is seeded with the same fixtures the automated tests
use, plus a fourth account meant for browsing around:

| Username | Password         | Notes                                   |
| -------- | ---------------- | ---------------------------------------- |
| `dev`    | `dev`             | Full permissions; has sample files (a README, a photo, a CSV) |
| `alice`  | `alice-password`  | Full permissions; has a docs folder and a photo |
| `bob`    | `bob-password`    | List/download on `/`, upload into `/inbox` |
| `carol`  | `carol-password`  | Full permissions; has a `/shared` virtual folder |

Regenerate this seed data (for example after changing
`packages/testkit/src/seed-data.ts`) with:

```sh
pnpm dev:seed
```

This writes `deploy/dev/sftpgo-seed.json` and the files under
`deploy/dev/files/`, both of which are committed so a fresh clone has
working dev fixtures without running the generator first.

## Ports

| Service           | Host port                                    |
| ------------------ | --------------------------------------------- |
| web                | 3000                                          |
| api                | 3001                                          |
| Postgres           | 55432 (override with `FDRIVE_DEV_DB_PORT`)    |
| SFTPGo HTTP/API    | 58080 (override with `FDRIVE_DEV_SFTPGO_HTTP_PORT`) |
| SFTPGo SFTP        | 52022 (override with `FDRIVE_DEV_SFTPGO_SFTP_PORT`) |

## SFTPGo admin

Open the SFTPGo web admin at http://127.0.0.1:58080/web/admin and sign in
with `admin` / `admin-dev-password`. From there you can inspect or edit the
seeded users, browse their files, and see server-level settings. This is
separate from fdrive's own web app; fdrive never exposes SFTPGo's admin UI
to end users.

## Resetting

To stop the containers but keep their data:

```sh
pnpm dev:env:down
```

To wipe all dev data (Postgres and SFTPGo) and start clean:

```sh
pnpm dev:env:reset
```

Both commands operate on the standalone `deploy/compose.dev.yaml` project
(`fdrive-dev`), which is separate from the production-shaped
`deploy/compose.yaml` stack described in `deploy/README.md`.
