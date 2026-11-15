# SFTPGo leftovers

Audit of `main` at 64cb537b, 2026-11-14. fdrive grew on SFTPGo, WebDAV and S3, storage it did
not own, so many parts still check, guess, copy or abstract what the
[files folder](../STORAGE.md) now guarantees. Each numbered group below is one pull
request. Numbers are stable: a group is removed when it merges, leaving a gap. Delete this plan
when none are left.

## Outcome

One storage, one login per account, one Trash, one index root, and change delivery from the
[change journal](../INDEXER.md#the-change-journal). No code path, setting, table or test exists
only for a backend fdrive no longer has. The owner is the only production user, so no group
carries data migrations, compatibility shims or configuration aliases; a full reindex is
acceptable.

## Order

- Groups that add a migration run one at a time and need `pnpm test:integration`.
- 37 runs last. Since #214 Trash rows (`app.trash_items`) live in the database, so
  dropping the database is no longer harmless: the baseline must be skipped by databases
  already at the last squashed migration and run on new ones.

## Decisions

Recommended on 2026-11-14 and approved by the owner the same day.

1. Only the files folder matters; database contents are ephemeral (owner, 2026-11-14). No change
   needs production-database facts; a PR says what users redo after deploying.
2. The disabled `sftpgo`, `webdav` and `s3` provider rows and their logins are deleted, with
   those logins' tags, favorites, shares and chats, which no one can reach. Activity history has
   no foreign key to logins and stays.
3. Trash is always on, at `/.trash`, and fdrive enforces its retention (one setting, default 30
   days). Changed by the owner when the flat layout shipped: v0.7.0-rc.11's start-up step moved
   the items Trash's old layout held, keeping each one's path and deletion time.
4. Backups go to S3 only. Configuration ZIP attachments go.
5. Limited share links may preview and peek, counted once per open. Public uploads never replace
   a file; a clash gets a numbered name. Multi-item shares stay zip-only for now.
6. MCP tokens without an access level are revoked; the MCP move log goes.
7. Removed files are deleted from the index; a move over SMB the watcher cannot pair loses its
   tags instead of being guessed from its hash.
8. `Shared with me` is a reserved name at the top of each home.
9. The migration history is squashed last.

## Last

37. Squash the migrations into one baseline.
