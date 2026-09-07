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
   file), generating a fresh `FDRIVE_MASTER_KEY` the first time. It also
   upserts the keys search, thumbnails, and trash need into
   `apps/api/.env.dev` (`FDRIVE_INDEX_ROOTS`, `FDRIVE_EMBED_URL`,
   `FDRIVE_THUMBS_DIR`, `FDRIVE_INDEXER_URL`, `FDRIVE_ADMIN_USERS`,
   `FDRIVE_SFTPGO_TRASH_PATH`), adding only whichever of those keys are
   missing so a file a developer has already customized keeps its own
   values. Restart the api dev server after `.env.dev` changes; it only
   reads the file at startup.
2. Starts `db` (Postgres) and `sftpgo` (a seeded SFTPGo instance) with
   Docker Compose and waits for both to report healthy.

To also get search and thumbnails working, bring up the `index` profile too
(`indexer`, `tika`, `embed`):

```sh
docker compose -f deploy/compose.dev.yaml --profile index up -d
```

This is not part of the default `pnpm dev:env` because the `embed` model
download and warmup take roughly a minute the first time. With it running
and the api dev server started (or restarted) after `.env.dev` gained the
search keys, search and the admin System pages work locally.

Then, in two more terminals (or via the `.claude/launch.json` configs "api"
and "web"):

```sh
pnpm --filter @fdrive/api dev
pnpm --filter @fdrive/web dev
```

The web app is at http://localhost:3000, and it proxies `/api/*` to the api
dev server at http://127.0.0.1:3001.

This proxy is `apps/web/next.config.ts`'s `rewrites()`, which reads
`API_INTERNAL_URL` from `apps/web/.env.local`. Unlike a production build,
`next dev` re-reads this file on every request, but only what is present
when the dev server starts: if you add or change `API_INTERNAL_URL` in
`.env.local`, restart `pnpm --filter @fdrive/web dev` for it to take effect.
`pnpm dev:env` writes a working default the first time it creates the file.

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
working dev fixtures without running the generator first. The seed dump
also includes the recycle-folder Event Manager rule described in
"Trash" below, at `/.trash`, so the dev environment's Trash view works
out of the box.

## Ports

| Service           | Host port                                    |
| ------------------ | --------------------------------------------- |
| web                | 3000                                          |
| api                | 3001                                          |
| Postgres           | 55432 (override with `FDRIVE_DEV_DB_PORT`)    |
| SFTPGo HTTP/API    | 58080 (override with `FDRIVE_DEV_SFTPGO_HTTP_PORT`) |
| SFTPGo SFTP        | 52022 (override with `FDRIVE_DEV_SFTPGO_SFTP_PORT`) |
| Indexer HTTP       | 58010 (override with `FDRIVE_DEV_INDEXER_HTTP_PORT`), `index` profile only |
| Embedding server (TEI) | 58081 (override with `FDRIVE_DEV_EMBED_PORT`), `index` profile only |
| OCR service        | 58011 (override with `FDRIVE_DEV_OCR_HTTP_PORT`), `index` profile only |

The embedding server, indexer, and OCR service are published on the host,
unlike in the production-shaped `deploy/compose.yaml` stack, because the api
dev server runs on the host with `tsx watch` rather than inside the compose
network.

## Search, thumbnails, and the System pages

With the `index` profile running (see above), the indexer writes WebP
thumbnails to `deploy/dev/.data/thumbs` on the host (bind-mounted into the
indexer container at `/thumbs`, not a named volume, so the host api dev
server can read the files it generates). `apps/api/.env.dev`'s
`FDRIVE_THUMBS_DIR` points at that same directory, and its
`FDRIVE_EMBED_URL`, `FDRIVE_INDEXER_URL`, and `FDRIVE_OCR_URL` point at the
published host ports above.

`FDRIVE_ADMIN_USERS=dev` in `apps/api/.env.dev` makes the `dev` user an
admin in the dev environment, so the account menu's System pages (indexer
stats, reindex, settings) are reachable by logging in as `dev` without any
extra setup.

## SFTPGo admin

Open the SFTPGo web admin at http://127.0.0.1:58080/web/admin and sign in
with `admin` / `admin-dev-password`. From there you can inspect or edit the
seeded users, browse their files, and see server-level settings. This is
separate from fdrive's own web app; fdrive never exposes SFTPGo's admin UI
to end users.

## Trash

fdrive does not own deleted data: a storage provider may expose a trash
surface, and fdrive shows a Trash view (restore, permanent delete) only when
it does. For SFTPGo, "having a trash" means an operator has set up the
Event Manager recycle-folder recipe below and told fdrive about it through
two environment variables (see `apps/api/src/config.ts`):

- `FDRIVE_SFTPGO_TRASH_PATH`: the recycle folder's virtual path, for example
  `/.trash`. Must be an absolute, already-normalized path other than the
  root (no `..`, no trailing slash, no repeated slashes). Unset (the
  default) means no trash capability: deletes made through fdrive stay
  permanent, and the delete dialog says so.
- `FDRIVE_SFTPGO_TRASH_RETENTION_HOURS`: an optional positive integer.
  Purely informational: fdrive displays it ("items are removed automatically
  after N hours") but never enforces it itself. Configure the matching data
  retention rule (below) separately if you want SFTPGo to actually enforce
  it.

`pnpm dev:env` (via `tools/dev/ensure-env.ts`) upserts
`FDRIVE_SFTPGO_TRASH_PATH=/.trash` into `apps/api/.env.dev`, and
`pnpm dev:seed` (via `tools/dev/generate-seed.ts`) seeds the matching
Event Manager rule into every dev user's SFTPGo account, so trash works out
of the box in local development. A production or self-hosted deployment
must set up the rule itself; `deploy/.env.example` documents both variables.

### The recycle-folder rule

The open-source SFTPGo Event Manager can be configured to rename a file
into the trash folder immediately before it would be deleted, instead of
actually deleting it. `packages/testkit/src/sftpgo-dump.ts` builds exactly
this action and rule (as JSON in SFTPGo's own dump/load format) for the
test and dev fixtures; the same shapes work through the SFTPGo admin UI's
Event Manager pages or its REST API (`POST /api/v2/eventactions` and
`POST /api/v2/eventrules`). Substitute your own trash path for `/.trash`
everywhere it appears:

```json
{
  "name": "fdrive-move-to-trash",
  "type": 9,
  "options": {
    "fs_config": {
      "type": 1,
      "renames": [
        {
          "key": "/{{.VirtualPath}}",
          "value": "/.trash/{{.VirtualDirPath}}/{{.ObjectName}}/{{.Timestamp}}"
        }
      ]
    }
  }
}
```

```json
{
  "name": "fdrive-trash",
  "status": 1,
  "trigger": 1,
  "conditions": {
    "fs_events": ["pre-delete"],
    "options": {
      "fs_paths": [{ "pattern": "/.trash/**", "inverse_match": true }]
    }
  },
  "actions": [
    {
      "name": "fdrive-move-to-trash",
      "order": 1,
      "relation_options": { "execute_sync": true, "stop_on_failure": true }
    }
  ]
}
```

The rule triggers on `pre-delete` (trigger type `1`, filesystem event),
matching every path except the trash folder itself (`inverse_match: true`
on `/.trash/**`), and runs the rename action synchronously
(`execute_sync: true`) so a failure to move the file into the trash denies
the delete instead of silently succeeding (`stop_on_failure: true`).
`{{.Timestamp}}` is SFTPGo's nanosecond epoch placeholder, which is also
`packages/core/src/trash/recycle-folder.ts`'s trash leaf id format
(`<original dir>/<original name>/<nanosecond timestamp>`); fdrive parses it
back into `originalPath`, `name`, and `deletedAt`.

### Retention (optional, informational only)

To have SFTPGo itself expire old trash entries, add a scheduled data
retention check action plus a schedule trigger. This is entirely optional
and separate from `FDRIVE_SFTPGO_TRASH_RETENTION_HOURS`, which only
controls what fdrive *displays*; SFTPGo does not read that variable.

```json
{
  "name": "fdrive-trash-retention",
  "type": 8,
  "options": {
    "retention_checks": [
      {
        "folder_path": "/.trash",
        "retention": 168,
        "delete_empty_dirs": true,
        "ignore_user_permissions": true
      }
    ]
  }
}
```

Bind that action to a rule with trigger type `2` (schedule) and a cron-style
schedule (for example, once a day). `retention` is in hours; keep it in
sync with `FDRIVE_SFTPGO_TRASH_RETENTION_HOURS` so the UI's message matches
what actually happens.

### Caveats

- Directories are trashed per file: deleting a folder moves every file it
  contains into the trash individually (mirroring how SFTPGo's own
  recursive directory delete works under the hood); the now-empty
  directories are removed rather than appearing in the trash themselves.
- Overwrites (uploading or renaming on top of an existing file) do not
  trigger the `pre-delete` event, so they are never trashed. This is a
  known SFTPGo limitation, out of scope for v1.
- Deletes made *inside* the trash folder itself are permanent: the rule's
  `inverse_match` on the trash path exists precisely so purging and
  emptying the trash do not recurse into it.

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
