# SFTPGo leftovers

Audit of `main` at 64cb537b, 2026-11-14. fdrive grew on SFTPGo, WebDAV and S3, storage it did
not own, so many parts still check, guess, copy or abstract what the
[files folder](../STORAGE.md) now guarantees. Each numbered group below is one pull
request. Numbers are stable: a group is removed when it merges, leaving a gap. Delete this plan
when none are left.

## Outcome

One storage, one login per account, one Trash, one index root, and change delivery from the
[change journal](CHANGE-JOURNAL.md). No code path, setting, table or test exists only for a
backend fdrive no longer has. The owner is the only production user, so no group carries data
migrations, compatibility shims or configuration aliases; a full reindex is acceptable.

## Order

- Groups that add a migration run one at a time and need `pnpm test:integration`.
- 37 last.

## Decisions

Recommended on 2026-11-14 and approved by the owner the same day.

1. Only the files folder matters; database contents are ephemeral (owner, 2026-11-14). No change
   needs production-database facts; a PR says what users redo after deploying.
2. The disabled `sftpgo`, `webdav` and `s3` provider rows and their logins are deleted, with
   those logins' tags, favorites, shares and chats, which no one can reach. Activity history has
   no foreign key to logins and stays.
3. Trash is always on, at `/.trash`, and fdrive enforces its retention (one setting, default 30
   days). Changed by the owner when the flat layout shipped: a start-up step moves the items
   Trash's old layout holds, keeping each one's path and deletion time (group 39).
4. Backups go to S3 only. Configuration ZIP attachments go.
5. Limited share links may preview and peek, counted once per open. Public uploads never replace
   a file; a clash gets a numbered name. Multi-item shares stay zip-only for now.
6. MCP tokens without an access level are revoked; the MCP move log goes.
7. Removed files are deleted from the index; a move over SMB the watcher cannot pair loses its
   tags instead of being guessed from its hash.
8. `Shared with me` is a reserved name at the top of each home.
9. The migration history is squashed last.

## Mac

All are server-only and keep shipped Mac builds working.

28. Optional: drop `/checks` now that the change feed exists, after measuring the hourly pass.
38. Drop `desktop_items.original_path` and the `trashName` handling with the start-up move of
    the Mac's old Trash (`settleTrashAtStart` in `trash/startup.ts`), once the owner's server
    has run it.

## Trash

39. Drop the start-up move of Trash's old layout once the owner's server has run it: the old
    layout's parser and walk (`apps/api/src/trash/old-layout.ts`), its step in
    `settleTrashAtStart`, and `.fdrive-move-v1` as a reserved name (`OLD_TRASH_LAYOUT` in
    `packages/core/src/reserved-paths.ts`, `RESERVED_FOLDERS` in the OCR service's `rules.py`,
    the indexer's `exclude_names` comment, and the docs that name it). Settling items a crash
    left on their way into Trash stays.

## Last

37. Squash the migrations into one baseline.
