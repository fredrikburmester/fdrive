# P6 trash as a provider capability

Decided 2026-09-07 with the user. fdrive does not own deleted data. A storage provider may
expose a trash surface; when it does, fdrive shows a Trash view with restore and permanent
delete, and the delete dialog says "Move to Trash". When it does not, deletes stay permanent
and the UI says so. Nothing in fdrive moves files into a trash folder itself.

## Verified facts (real SFTPGo 2.7.5, `tools/…/trash-probe.ts` run 2026-09-07)

- SFTPGo has no native trash. The open-source Event Manager recipe works: rule trigger
  `1` (filesystem event), `fs_events: ["pre-delete"]`, condition
  `fs_paths: [{ pattern: "<trash>/**", inverse_match: true }]`, one action of type `9`
  (filesystem) with `fs_config.type: 1` (rename) `{ key: "/{{.VirtualPath}}", value:
  "<trash>/{{.VirtualDirPath}}/{{.ObjectName}}/{{.Timestamp}}" }`, bound with
  `relation_options: { execute_sync: true, stop_on_failure: true }`. Pre-delete actions are
  always synchronous; a failing action denies the delete (client gets permission denied).
- `{{.Timestamp}}` is nanoseconds since the epoch (19 digits). `{{.VirtualDirPath}}` of
  `/top.txt` is `/`, so the layout is `<trash>/<original dir>/<original name>/<ns>`.
- `DELETE /api/v2/user/files` returns 200 after the rename; SFTPGo treats "file removed by
  the pre-action" as success (`RemoveFile`, status > 0 and not-exist).
- `DELETE /api/v2/user/dirs` is recursive and calls `RemoveFile` per file, so every file of a
  deleted directory lands in the trash individually; the emptied directories are removed.
  Directories themselves never appear in the trash.
- Deleting under the trash prefix bypasses the rule (inverse path match) and is permanent.
- Overwrites via rename or upload do not trigger pre-delete. Out of scope for v1.
- Retention is an SFTPGo scheduled rule (action type `8`, data retention check on the trash
  folder). fdrive only displays the configured number of hours.
- Placeholders resolve in the triggering user's virtual filesystem. Filesystem actions run
  with the user's directory permissions raised, so restricted users still get a trash.

## Configuration

- `FDRIVE_SFTPGO_TRASH_PATH`: optional virtual path of the recycle folder, for example
  `/.trash`. Must be absolute, normalized, not `/`. Unset means no trash capability.
- `FDRIVE_SFTPGO_TRASH_RETENTION_HOURS`: optional positive integer, informational only.
- Both are documented in `deploy/.env.example` and `docs/DEVELOPMENT.md` with the exact
  Event Manager rule the operator must create (also as a JSON snippet for the admin API).
- Dev and test seeds ship the rule in the load dump so `pnpm dev:env` and the testkit
  container have a working trash at `/.trash`. `tools/dev/ensure-env.ts` writes
  `FDRIVE_SFTPGO_TRASH_PATH=/.trash` into `apps/api/.env.dev` when absent.

## Core contract (packages/core)

```ts
// ports/storage.ts additions
export interface TrashEntry {
  readonly id: string;           // trash-relative leaf path, e.g. "docs/a.txt/1788761221798866471"
  readonly originalPath: string; // "/docs/a.txt"
  readonly name: string;         // "a.txt"
  readonly size: number;
  readonly deletedAt: Date;      // from the nanosecond timestamp
}
export interface TrashListing { readonly entries: TrashEntry[]; readonly truncated: boolean }
export interface TrashProvider {
  list(options?: { limit?: number; signal?: AbortSignal }): Promise<TrashListing>;
  /** Moves the leaf back to `target ?? originalPath`; parents are created; existing target => StorageError "conflict". */
  restore(id: string, options?: { target?: string }): Promise<FileEntry>;
  /** Permanent. Missing ids are ignored. */
  purge(ids: readonly string[]): Promise<void>;
  /** Permanent removal of everything under the trash folder. */
  empty(): Promise<void>;
}
export interface StorageProvider { /* existing */ readonly trash?: TrashProvider }
```

- New pure module `packages/core/src/trash/recycle-folder.ts`:
  `parseTrashLeaf(trashPath, leafPath)` → `{ originalPath, name, deletedAt } | null` (leaf name
  must be 1–20 ASCII digits; parent chain gives the original path; reject anything under
  `trashPath` that does not parse), `trashLeafPath(trashPath, id)`, `isUnderPath(prefix,
  path)`. 100 percent coverage, property tests for round trips with spaces, Unicode and
  literal percent sequences.
- New `packages/core/src/trash/recycle-folder-trash.ts`: `createRecycleFolderTrash({ storage,
  trashPath, limit = 10000 })` implementing `TrashProvider` purely on top of a
  `StorageProvider` (list, move, mkdir, deleteFile, deleteDir). `list` walks the trash
  breadth-first, bounded by `limit` entries and 10,000 directory visits, sorted by
  `deletedAt` descending, `truncated` when the bound is hit. `restore` verifies the id
  parses, moves the leaf to the target (mkdir parents first), then best-effort removes the
  now-empty `<name>` directory. `purge` deletes leaves then best-effort removes empty
  `<name>` directories. `empty` lists the trash root and `deleteDir`/`deleteFile`s each
  child (never the trash folder itself). Tested against the memory storage fixture.

## Contracts (packages/contracts)

- `ROUTES.trash = { status: "/api/v1/trash/status", list: "/api/v1/trash", restore:
  "/api/v1/trash/restore", purge: "/api/v1/trash/purge", empty: "/api/v1/trash/empty" }`.
- `TrashStatusResponse = { available: boolean; path: string | null; retentionHours: number | null }`.
- `TrashEntry` (id, originalPath, name, size, deletedAt ISO), `TrashListResponse = { entries,
  truncated }`.
- `TrashRestoreRequest = { ids: string[] (1..1000); target?: string }` (target only allowed with
  exactly one id, validated by `isValidPath`), `TrashRestoreResponse = { restored: FsEntry[] }`.
- `TrashPurgeRequest = { ids: string[] (1..1000) }`, `OkResponse` for purge and empty.
- Client methods `trashStatus`, `trashList`, `trashRestore`, `trashPurge`, `trashEmpty`.
- `FsEvent.op` unchanged; restore publishes `move` (paths = trash virtual paths, targetPaths =
  targets), purge/empty publish `delete` with the trash virtual paths.

## API (apps/api)

- `config.ts`: `fdriveSftpgoTrashPath: string | null`, `fdriveSftpgoTrashRetentionHours:
  number | null`, validated as above.
- `auth/storage-factory.ts` (or a decorator applied there): when the trash path is set, the
  identity storage provider gets `trash = createRecycleFolderTrash({ storage, trashPath })`.
- New `trash/routes.ts` on `authed`: status always answers; list, restore, purge and empty
  return 404 with kind `not_found` and message "trash is not configured" when
  `principal.storage.trash` is undefined. Restore calls `fsMetadata.onMoved(identityId,
  trashVirtualPath, target, false)` per restored id and publishes one `move` event; purge and
  empty publish `delete` events for the removed trash virtual paths (empty publishes the
  trash folder path only).
- `fs/routes.ts` delete: when `principal.storage.trash` exists, do not call
  `metadata.onDeleted`; call `recents.deletePrefix` only (add `onTrashed(identityId, path,
  isDir)` to `MetadataService` that does exactly that; the office decorator passes it
  through untouched so registrations survive until rename tracking or purge). Tags,
  favorites and office registrations follow the file through indexer rename tracking when an
  index is configured, and otherwise stay keyed at the original path so a same-path restore
  recovers them. Restore to a different target without an index loses tags; documented.
- `fs/routes.ts` list: omit the entry whose path equals the trash path. `stat` and navigation
  under the trash prefix remain allowed (previews and downloads from the Trash page use them).
- Search: results whose virtual path is under the trash prefix are filtered before sections,
  counts and folder grouping (`search/service.ts`, one helper reused by duplicates/similar).
- Integration test `test/integration/trash-sftp.test.ts` against the real container seeded with
  the rule: delete file and directory, listing parses timestamps and original paths with
  spaces/Unicode/`%20`, restore (same path, conflict 409, target path with new parents),
  purge, empty, and the fs list omission. A second user's trash is invisible to the first.

## Testkit and fake (packages/testkit, packages/sftpgo)

- `buildSftpgoDump(users, folders, { dataDir, trash?: { path } })` adds `event_actions` and
  `event_rules` in SFTPGo's dump format. Verify against the container that
  `SFTPGO_LOADDATA_FROM` accepts them (the prototype used the REST API). `startSftpgo` takes
  `trash?: { path }` and passes it through; `tools/dev/generate-seed.ts` enables it at `/.trash`.
- Fake server: `createFakeSftpgoServer({ trash?: { path } , now })`: `deleteFile` outside the
  prefix moves the node to `<path>/<dir>/<name>/<ns>` using `now()` nanoseconds (monotonic
  when equal), `deleteDir` applies the same per file then removes the directory, deletes
  under the prefix are permanent. Contract suite covers the same scenarios against fake and
  container.

## Web (apps/web)

- `useTrashStatus()` (query, staleTime 5 min), `useTrash()`, `useTrashRestore()`,
  `useTrashPurge()`, `useTrashEmpty()` in `lib/trash/queries.ts`; any fs SSE event invalidates
  the trash list.
- Delete dialog and context menu: with trash available the item reads "Move to Trash" with the
  `Trash2Icon`, the dialog title "Move to Trash?" and body "NAME will be moved to Trash." plus
  "Items in Trash are removed automatically after N days." when retention is configured; the
  button reads "Move to Trash". Without trash the current permanent-delete copy stays.
- Sidebar Locations gets "Trash" (`Trash2` icon, `/trash`) after Shares, only when available.
- `/trash` page: heading "Trash", table with name, original folder, size, deleted-at (relative
  with absolute title), multi-select, toolbar actions Restore, Restore to… (reuses the existing
  move-to folder picker, single selection), Delete permanently (confirm dialog), Empty Trash
  (confirm dialog, states the count). Conflict on restore shows a toast naming the file and
  offering Restore to…. Empty state explains what Trash holds. Every action toasts
  success. Only shadcn components; descriptions under any settings field.
- Playwright: real SFTPGo fixture with the rule; delete → appears in Trash with original folder;
  restore returns it with tags intact when the index fixture is present (else assert same
  path only); restore conflict; delete permanently; empty; a user without the rule sees no
  Trash item and the permanent-delete copy.

## Chunks and order

1. `trash-core` (packages/core trash modules and port, packages/contracts trash schemas,
   routes and client, packages/testkit dump and container option, packages/sftpgo fake trash
   and contract suite). Gates: package lint/typecheck/coverage, sftpgo contract suite against
   the container, testkit integration.
2. `trash-api` after 1: config, storage factory, trash routes, fs delete/list changes, search
   filter, metadata `onTrashed`, dev seed and env, deploy docs, integration test.
3. `trash-web` after 1, in parallel with 2: queries, dialogs, sidebar, page, e2e spec (the e2e
   runs after 2 integrates).

Primary reviews auth and scoping in each, runs root gates and the browser pane, then records
the outcome in STATUS.md.
