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
- 36 and 37 last.

## Decisions

Recommended on 2026-11-14 and approved by the owner the same day.

1. Only the files folder matters; database contents are ephemeral (owner, 2026-11-14). No change
   needs production-database facts; a PR says what users redo after deploying.
2. The disabled `sftpgo`, `webdav` and `s3` provider rows and their logins are deleted, with
   those logins' tags, favorites, shares and chats, which no one can reach. Activity history has
   no foreign key to logins and stays.
3. Trash is always on, at `/.trash`, and fdrive enforces its retention (one setting, default 30
   days). Before the flat layout (17) ships, the owner restores what they want and empties Trash
   instead of a migration moving old items.
4. Backups go to S3 only. Configuration ZIP attachments go.
5. Limited share links may preview and peek, counted once per open. Public uploads never replace
   a file; a clash gets a numbered name. Multi-item shares stay zip-only for now.
6. MCP tokens without an access level are revoked; the MCP move log goes.
7. Removed files are deleted from the index; a move over SMB the watcher cannot pair loses its
   tags instead of being guessed from its hash.
8. `Shared with me` is a reserved name at the top of each home.
9. The migration history is squashed last.

## Wave 2: Trash, metadata and the journal

17. **Flat Trash layout.** The `p/<segment>` path encoding, made for WebDAV, becomes one folder
    per item plus a row. The Mac's Trash (`desktop/writes.ts`) finds an item's leaf and original
    path with the layout's parser too.
19. **One file-operations service.** MCP's activity proxy and its copy of metadata following
    (`composition.ts` `onMutation`) merge with the fs and Trash routes' recorders.

## Mac

All are server-only and keep shipped Mac builds working.

28. Optional: drop `/checks` now that the change feed exists, after measuring the hourly pass.

## Storage contract

29. Make the optional port members required and delete the fallbacks; drop `contentType`, which
    is always null (MCP reports `mime: null`); non-null modification times and lengths; writes
    return the new entry; one conformance suite with no options.
30. Open files instead of HTTP-shaped downloads: peek parses `Content-Range` with a regex,
    extract copies the zip to a temp folder, shares have a second range implementation. The perf
    harness measured downloads through the API at 84% of direct throughput against its 90%
    budget, on a heavily loaded machine; rerun `pnpm perf:strict` on a quiet one before acting
    on that.

## Shares

31. **Shares.** One module instead of the access-object layers; one range implementation; drop
    `has_password` and rename `views`.

## Last

36. Collapse the schema: provider columns and rows, `identities.provider_id`. Keep the provider
    row's UUID, which the Mac app compares as `providerId`. `desktop_items.original_path` goes
    with the start-up move of the Mac's old Trash (`adoptOldTrash` in `desktop/retention.ts`)
    once the owner's server has run it.
37. Squash the migrations into one baseline.
