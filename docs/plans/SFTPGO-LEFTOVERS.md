# SFTPGo leftovers

Audit of `main` at 64cb537b, 2026-11-14. fdrive grew on SFTPGo, WebDAV and S3, storage it did
not own, so many parts still check, guess, copy or abstract what [local storage](LOCAL-STORAGE.md)
now guarantees. Each numbered group below is one pull request. Remove a group when it merges;
delete this plan when none are left.

## Outcome

One storage, one login per account, one Trash, one index root, and change delivery from the
[change journal](CHANGE-JOURNAL.md). No code path, setting, table or test exists only for a
backend fdrive no longer has. The owner is the only production user, so no group carries data
migrations, compatibility shims or configuration aliases; a full reindex is acceptable.

## Order

- Groups that add a migration run one at a time and need `pnpm test:integration`, which needs a
  pullable S3 test image first.
- 11–15 run strictly in order: they share `apps/api/src/auth/service.ts`, `composition.ts` and the
  contracts.
- 16 before 17, 26, 31 and 32. 22 before 29. 16 and 23 before 18. 36 and 37 last.

## Decisions

Recommended on 2026-11-14. Confirm each before the group that depends on it.

1. Before 11–13 and 36, read from the production database: provider rows with their login
   counts, accounts with more than one login, API tokens without an access level, the `setup.%`
   and `trash.configuration.%` settings keys; and from its environment `FDRIVE_INDEX_ROOTS`,
   `FDRIVE_ADMIN_USERS` and `FDRIVE_OFFICE_EDIT_RULES`.
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
9. The migration history is squashed last, with one manual step on the production database.
10. The Mac cleanup release (27) waits until a Mac release is due anyway.

## Wave 0: independent fixes

1. **Hide fdrive's own folders everywhere.** The indexer walks `/.fdrive-desktop`
   (`services/indexer/src/config.rs` `SKIP_DIRS`), so search can return the Mac's staged uploads,
   `previous` copies and Trash. OCR skips `.Trash` but not `.trash`, `.fdrive-move-v1` or
   `.fdrive-desktop` (`services/ocr/src/fdrive_ocr/runner.py`), so it rewrites PDFs there. MCP
   and AI index tools drop Trash after the SQL limit (`mcp/scope-context.ts` `virtualPathFor`),
   so pages are short and totals wrong. Eight separate reserved-path checks (shares, MCP, AI,
   search, grants, listing, desktop, backups) disagree; one helper in core replaces them.
2. **Stop the Trash from rotting.** Restore and purge remove only the leaf
   (`packages/core/src/trash/recycle-folder-trash.ts`), so layout folders pile up until the
   10,000-visit listing truncates and Empty Trash fails. Empty Trash re-walks per page and keeps
   guards for a provider that does not remove items; MCP restore scans 10,000 entries for one
   id. The Trash page claims items are "removed automatically", which fdrive never does.
3. **Let storage refuse taken targets.** Callers stat before every move, copy, upload and
   archive write (`fs/mutations.ts`, `archive/new-file-storage.ts`, `archive/extract.ts`,
   `fs/archive-routes.ts`, `mcp/file-tools.ts`) because SFTPGo overwrote on move. The pre-check
   makes case-only renames fail on case-insensitive disks. The overwrite defaults disagree
   between the port doc, `move` and `copy`. Local `moveEntry` with `overwrite: false` checks then
   renames. Compress builds the archive in a temp file and uploads it again, through a second zip
   writer.
4. **Office: version from the file stamp, lock per file.** CheckFileInfo, open and save download
   and hash the whole document (`office/streams.ts` `contentVersion`); every save is copied to a
   temp file first; one `office-write:<providerId>` lock serializes every save in the
   installation (`packages/db/src/repos/office-write-scope.ts`).
5. **Indexer: drop dead writes and restart walks.** `idx.events` is written and pruned, never
   read (keep the notification). The indexer writes `idx.moves` rows nothing reads. Every start
   walks the whole library (`runner.rs` `next_scan: Instant::now()`), though the journal now
   covers restarts.
6. **OCR: find PDFs through the index.** OCR walks the whole folder nightly and keys its done
   log by path, size and modification time. API writes do not take OCR's per-path lock, so a
   rewrite can replace an upload that lands during its copy.
7. **Delete dead tooling and shims.** The public URL's fallback to Office's `appUrl`, after a
   check of the production database.
8. **Web: drop gates on capabilities that are always on.** `zip`, `setModifiedAt`, `atomicMove`,
   `shares`, `office` and `shareWithPeople` are always true: the one-by-one download plan, the
   slow-move warning, the upload-time note, "Shares aren't available for this login" and the
   capability props through six components go (`apps/web/src/lib/identity/capabilities.ts`). The
   search scope reasons the server no longer sends go too.
9. **Docs.** Delete `STOCK-SFTPGO-WRITES.md` and the shipped `SYSTEM-ACTIVITY.md` plan; rewrite
   the Backups, macOS writes and Local storage plans to what remains; the activity plans cite SFTP
   tests that do not exist; drop the upgrade notes in `deploy/README.md`, the TEI section in
   `deploy/REFERENCE.md`, "linked logins" in `MCP.md` and the SFTPGo rule in `AGENTS.md`.
10. **Rate-limit password change.** `POST /auth/password` checks the current password without the
    login limiter (`local/routes.ts`, `local/service.ts`). Folds into 12.

## Wave 1: one user, one storage

11. **One login per account.** Account linking, unlinking, switching and metadata transfer
    (`packages/db/src/repos/identity-links.ts`, `apps/api/src/accounts`); the `x-identity-id`
    header and `?identity=`; per-tab login pinning and account-switch checks across the web's
    query modules; the login stored per upload; `/office/[identity]`; account-wide favorites,
    the "All locations" history filter, login pickers for tokens and Mac pairing; re-checks that
    a login has not moved accounts; nullable `sessions.active_identity_id` and
    `api_tokens.identity_id`; the Logins card, link and unlink dialogs and the sidebar switcher.
12. **Check passwords locally and drop stored passwords.** Sign-in goes through the provider
    module's `authenticate` with metadata-driven fields and a one-time-code field
    (`accounts/credentials.ts`). `app.credentials` keeps reversible copies of every password,
    compared at sign-in, and the master key travels in backup archives. Setup is a two-step
    resumable claim. Backups re-authenticate every login on restore, read Mac recovery by signing
    in as each user, and unlock with a provider credential map. Logins are created at first
    sign-in with a case-sensitive lookup. The web form becomes plain username and password.
13. **One storage, no provider modules.** `ProviderModule`, the registry and `ProviderService`
    for one row (base URL, config, probe, `fetch`, a pinned storage factory); per-login
    `ProviderCapabilities` become two installation flags on `/me`; one-value Trash and share
    strategies; `available` flags and "no files folder" states; `FDRIVE_STORAGE_ROOT` becomes
    required; administrators come from `accounts.is_admin` only; `GET /providers`,
    `/admin/providers` and the `/about` provider list go, the storage name becomes a setting;
    errors that cannot happen (`reauth_required` from storage, `upstream_unavailable`,
    `rate_limited`) and the always-configured `trash` health entry go.
14. **Two queries per request.** About 11 queries run before a signed-in handler and `/auth/me`
    adds 7 (the setup gate lists providers on every request). About 25 call sites fetch the login
    again; each scope resolution re-reads provider, grants and Trash. Every index result gets a
    live storage probe: search probes about 145 candidates before cutting to its limit, and each
    thumbnail tile costs about 8 queries and is sent `no-store`.
15. **One files index root.** `FDRIVE_INDEX_ROOTS` and `INDEX_ROOTS` map several roots with
    separate API and indexer paths; the API guesses the root name and journals nothing until the
    indexer creates the root row; three System pages have root pickers; indexer routes take a
    root. Two scope resolvers become one. The `idx.schema_version` waits become a compose
    dependency on a healthy API. Six ML URLs become `FDRIVE_ML_URL`.

## Wave 2: Trash, metadata and the journal

16. **One installation-wide Trash, as an explicit operation.** Settings are per provider row with
    a strategy and an old-data repair (`trash/settings.ts`). Trash intercepts deletes in a
    wrapper, keeps its settings in a WeakMap lost when storage is re-wrapped, and passes the leaf
    out through AsyncLocalStorage (`activity/trash.ts`); the Trash path is built in nine places.
    Tags, favorites and folder views stay at a trashed item's path, so a new file there inherits
    them. A grantee deleting in a writable shared folder may send the owner's file to the
    grantee's Trash (unverified). Retention per decision 3.
17. **Flat Trash layout.** The `p/<segment>` path encoding, made for WebDAV, becomes one folder
    per item plus a row.
18. **Live updates and metadata from the journal.** Every fdrive change returns through the
    indexer's `idx_events`; `events/indexer-listener.ts` handles it once per login, sends the
    actor a second live update and moves metadata a second time. With indexing off, grantees get
    no live updates and metadata ignores SMB moves. Activity's per-listing "refresh comparison"
    goes; activity observations and Office follow the journal.
19. **One file-operations service.** MCP's activity proxy and its copy of metadata following
    (`composition.ts` `onMutation`) merge with the fs and Trash routes' recorders.
20. **Delete removed files from the index.** Tombstones are never purged and every scan loads
    them, for a sha256 relink guess.
21. **Reuse the API's file stamp in the indexer.** The watcher re-reads every uploaded or renamed
    file.

## Mac

All but 27 are server-only and keep shipped Mac builds working.

22. Remove the write lease, publish size cap and copy-based folder moves from `desktop/writes.ts`;
    stat directly instead of listing every ancestor (`desktop/files.ts` `entry`).
23. Apply metadata inline after Mac writes and drop `app.desktop_effects` and the five `revision`
    columns that serve it.
24. Detect conflicts from the file stamp; drop the publish lock and its pool, `previous` copies,
    30-day retention, the 64 GiB reservation and re-hashing on renames.
25. Stage uploads inside the files folder so a commit can always tell whether it happened; drop
    `FDRIVE_DESKTOP_STATE_DIR`, the `uncertain` state and the unused admin recovery endpoints.
26. Finder's Trash becomes fdrive's Trash.
27. Mac release: drop commit progress polling, `follow` and the 24-hour commit timeout. Check
    whether cancelling a stuck commit deletes the Mac's own copy (unverified).
28. Optional: drop `/checks` now that the change feed exists, after measuring the hourly pass.

## Storage contract

29. Make the optional port members required and delete the fallbacks; drop `contentType`, which
    is always null (MCP reports `mime: null`); non-null modification times and lengths; writes
    return the new entry; one conformance suite with no options.
30. Open files instead of HTTP-shaped downloads: peek parses `Content-Range` with a regex,
    extract copies the zip to a temp folder, shares have a second range implementation.

## Shares, activity, Office, backups, MCP

31. **Shares.** One module instead of the access-object layers; no strategy lookup per public
    request; one range implementation; drop `has_password` and rename `views`.
32. **Activity.** Drop `provider_version`, `trashStrategy: "sftpgo_rule"`, the `provider` bridge
    namespace and the per-login provider snapshot.
33. **Office.** Key Office files by owner path; no provider in settings or edit rules; pick
    editors from fdrive's users.
34. **Backups.** S3 only; this also removes the guard that lists every moved, deleted or zipped
    folder (`backups/reserved-storage.ts`).
35. **MCP.** Remove tokens without an access level, `FDRIVE_MCP_WRITES` and the indexer's
    path-based `/extract`; serve `recent_moves` from activity.

## Last

36. Collapse the schema: provider columns and rows, `app.credentials`, `identities.provider_id`,
    required `sessions` and token logins, `office_files.provider_id`. Keep the provider row's
    UUID, which the Mac app compares as `providerId`.
37. Squash the migrations into one baseline.
