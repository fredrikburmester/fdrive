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
- 14 and 15 run in order: they share `apps/api/src/auth/service.ts`, `composition.ts` and the
  contracts.
- 16 before 17, 18, 26 and 31. 36 and 37 last.

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

## Wave 1: one user, one storage

14. **Two queries per request.** About 11 queries run before a signed-in handler and `/auth/me`
    adds a few more (the setup gate asks whether setup is open on every request). About 25 call
    sites fetch the login again; each scope resolution re-reads grants and Trash. Every index result gets a
    live storage probe: search probes about 145 candidates before cutting to its limit, and each
    thumbnail tile costs about 8 queries and is sent `no-store`.
15. **One files index root.** `FDRIVE_INDEX_ROOTS` and `INDEX_ROOTS` map several roots with
    separate API and indexer paths; the API guesses the root name and journals nothing until the
    indexer creates the root row; three System pages have root pickers; indexer routes take a
    root. Two scope resolvers become one. The `idx.schema_version` waits become a compose
    dependency on a healthy API. Six ML URLs become `FDRIVE_ML_URL`.

## Wave 2: Trash, metadata and the journal

16. **One installation-wide Trash, as an explicit operation.** Settings are per provider row with
    an old-data repair (`trash/settings.ts`). Trash intercepts deletes in a
    wrapper, keeps its settings in a WeakMap lost when storage is re-wrapped, and passes the leaf
    out through AsyncLocalStorage (`activity/trash.ts`); the Trash path is built in nine places.
    Tags, favorites and folder views stay at a trashed item's path, so a new file there inherits
    them. A grantee deleting in a writable shared folder may send the owner's file to the
    grantee's Trash (unverified). Retention per decision 3. Office's save path (#162) and
    personal activity's path locks each keep a database pool of their own; they never wait on
    each other, and sharing one would let slow Office saves hold up Trash moves.
17. **Flat Trash layout.** The `p/<segment>` path encoding, made for WebDAV, becomes one folder
    per item plus a row.
18. **Live updates and metadata from the journal.** Every fdrive change returns through the
    indexer's `idx_events`; `events/indexer-listener.ts` handles it once per login, sends the
    actor a second live update and moves metadata a second time. With indexing off, grantees get
    no live updates and metadata ignores SMB moves. Activity observations and Office follow the
    journal.
19. **One file-operations service.** MCP's activity proxy and its copy of metadata following
    (`composition.ts` `onMutation`) merge with the fs and Trash routes' recorders.
20. **Delete removed files from the index.** Tombstones are never purged and every scan loads
    them, for a sha256 relink guess.

## Mac

All are server-only and keep shipped Mac builds working.

26. Finder's Trash becomes fdrive's Trash.
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

## Shares, Office, backups

31. **Shares.** One module instead of the access-object layers; one range implementation; drop
    `has_password` and rename `views`.
33. **Office.** Key Office files by owner path; no provider in settings or edit rules; pick
    editors from fdrive's users.
34. **Backups.** S3 only; this also removes the guard that lists every moved, deleted or zipped
    folder (`backups/reserved-storage.ts`).

## Last

36. Collapse the schema: provider columns and rows, `identities.provider_id`,
    `office_files.provider_id`. Keep the provider row's UUID, which the Mac app compares as
    `providerId`.
37. Squash the migrations into one baseline.
