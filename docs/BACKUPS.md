# Installation backups

System → Backups protects one installation, including every account. Only the setup owner,
using a browser session and having just confirmed their password, can manage or download
backups.
Other administrators and MCP/desktop bearer tokens do not grant backup access.

## Configure

The deployment Compose file starts a dedicated `backup` worker. Its persistent `fdrive-backups`
volume holds temporary encrypted download archives. The worker reads the OCR originals,
retained indexer logs and Office data mounts; it does not mount the files folder.
Those source mounts are read-only. The API and worker must use the same database and master
key and share the backup volume. Upgrade the API, worker and OCR service together.

For a native installation, set `FDRIVE_BACKUP_STATE_DIR` to a private persistent directory.
Run `node dist/main.js backup worker` alongside the API, or set `FDRIVE_BACKUP_WORKER=true`
to run the worker inside the API process. Only one worker holds the database worker lock.
`FDRIVE_BACKUP_SOURCES` is a JSON array of `{ "kind": "ocr" | "logs" | "office", "path": "/absolute/path" }`.
Keep the backup directory outside all source directories. Missing or unreadable recovery sources
appear as coverage gaps.

1. Open System → Backups and confirm your password.
2. Create and download a recovery key. Paste the saved key to prove it can decrypt a challenge.
   The private key is generated in the browser; scheduled backups use only its public recipient.
3. Optionally add an S3-compatible bucket (AWS S3, Backblaze B2). It is the only kind of
   destination: a backup on the installation's own disk is not a backup. Adding it tests
   create, read and delete permissions using a uniquely named probe. Use a private bucket and
   dedicated credentials, and keep those credentials outside fdrive too.
   A bucket with default Object Lock retention keeps the probe object; fdrive never asks for a
   retention bypass. The destination is saved and the kept object's name and deadline are shown
   on its card and recorded in the event log.
4. Choose a schedule and retention, then run a backup. A destination can inherit the installation
   policy or have its own hourly, daily or weekly policy and IANA timezone. Downtime produces
   one catch-up run; it does not replay every missed interval.

S3 supports a custom endpoint, region, bucket, prefix and path-style addressing, including
Backblaze B2's S3-compatible endpoints. Enter the endpoint and region belonging to your bucket;
the B2 preset is an editable example.

An earlier release could also copy backups into a folder in the owner's files, beneath
`<chosen folder>/.fdrive-backups/<installation ID>`. fdrive no longer writes there or hides
it: such a folder is an ordinary one that the owner sees, can download from, move or delete,
and that search indexes. Its archives restore with the release that made them.

Copies use one encrypted archive per snapshot. Each transfer is read back in full and checked
with SHA-256 before a completion marker is published. Multipart failures are aborted; retries
reuse the captured archive and check its checksum. `complete` means all selected destinations
verified and no reported source gaps. `partial` means a source gap or destination failure.
“Verify bytes” checks retained ciphertext; it is not a restore rehearsal.

Retention keeps the union of newest daily, weekly and monthly copies, always preserving pins
and the newest copy. A shared snapshot can be retained longer because another destination
needs it. S3 version IDs are recorded and deletions target those exact versions. Deleting a
backup removes every copy the destinations allow; a copy kept by Object Lock stays in the
catalog with its deadline, and the request answers with which copies remain and until when.
There is no governance-lock bypass.
Destination bindings with retained deliveries cannot be replaced or deleted; add a new
destination and retire the old copies deliberately. Manual policies stop new scheduled copies.

Unpinned browser-download spools expire after 24 hours. Remote copies follow retention. The
worker also removes, after the same 24 hours, spool files that no run references any more: a
partial capture, a completion marker, or an archive published moments before a crash whose run
already failed. Files of queued, active or pinned runs and unrecognised files are left alone.
Download-only copies must be saved elsewhere before that expiry. Rotating the recovery key
affects future snapshots: retain old keys for as long as their backups are retained.

### Health

System → Backups shows the worker's last heartbeat, the time since the last complete snapshot,
per-destination delivery state and errors, an overdue notice when a schedule is more than 15
minutes late, and a monthly restore-rehearsal reminder. Recovering one destination never hides
another destination's failure. “Estimate backup size” queues a scan that the worker runs under
the same repeatable-read view as a capture; it reports database bytes, recovery bytes, the
retained total implied by the retention policy and the upload-plus-readback traffic per run.
An estimate that cannot finish within ten minutes, or whose sources are unreachable, is
reported as failed rather than left pending. When a scheduled full capture fails on a recovery
source, the worker queues one separately labelled metadata-only fallback for that slot so the
newest configuration and history are still protected while coverage stays reported as partial.

## What is included

The explicit table registry is in `packages/backup/src/registry.ts`. A capture fails on an
unclassified application/index table, including tables introduced by a future migration.

- Accounts, identities, providers, local users (password hashes included) and the folders
  they share with each other, settings, tags, favorites, folder views, recents,
  AI chats (transcripts and references), share metadata (password hashes included, so links
  restore fully), activity, stable Office/native file IDs and Mac write receipts.
- Retained index scan/move/event history, OCR rewrite history and processing failures.
- Pre-OCR originals and original-file mappings, retained logs and configured external source
  mounts.
- Effective deployment configuration, mount identities, migration hashes and database schema
  fingerprint. The source master key is inside the independently encrypted archive so
  destination secrets can be resealed on a replacement installation.

Indexes, extracted chunks, thumbnails, embeddings, sessions and WOPI locks are omitted. Original user files (the files folder, Trash included), unsaved external
editor state and device-only edits require their own backups. Uploads the Mac staged in the files
folder are transient and never backed up: the Mac sends an unfinished one again, and a restored
Mac write ends from what the files folder shows, like any interrupted one
([macOS](MACOS.md#write-configuration-and-recovery)).

Database rows are captured in a repeatable-read transaction, using PostgreSQL text values to
preserve bigint, bytea, JSON and timestamps exactly. Two advisory locks make the capture
consistent. Every mutating API request holds the snapshot gate (`SNAPSHOT_GATE`) shared, and
OCR holds the recovery files gate (`BACKUP_GATE`) shared while it writes, restores or deletes
kept originals. A capture takes both exclusively, so its snapshot sees no request or OCR write
half done, and lets go of the snapshot gate as soon as the snapshot exists: requests then go
on, and the snapshot does not see them. It keeps the recovery files gate until it has read
every recovery file, so OCR changes none of them meanwhile; OCR waits without giving up.
Local files reject symlinks, inode replacement and mutation during reading; log files capture
their checkpoint prefix while allowing append. Independently changing user files and external
writers are not a filesystem snapshot.

## Recovery

Use the same trusted fdrive release that made the backup, a **new empty database**, a new
32-byte base64 `FDRIVE_MASTER_KEY`, and a private persistent backup directory. Keep the old
installation stopped during cutover. The archive contains data, not executable migration SQL.
Restore compares the installed migration hashes and schema before importing anything.

The CLI is available in the API image and built API directory:

```sh
chmod 600 recovery-key.txt destination.json review.json
node dist/main.js backup inspect --file snapshot.fdrive.age --key-file recovery-key.txt
```

`inspect`, `list` and `fetch` do not require the application database, master key,
login or setup. Their key/destination files must be regular private files, at most 64 KiB.
Existing output files are never overwritten.

An offline S3 destination file contains `type: "s3"`, `endpoint`, `region`, `bucket`, `prefix`,
`pathStyle`, `accessKeyId` and `secretAccessKey`. Use the **full installation-specific prefix**
shown in System → Backups.

```sh
node dist/main.js backup list --destination-file destination.json
node dist/main.js backup fetch --destination-file destination.json \
  --snapshot SNAPSHOT_UUID --output downloaded.fdrive.age
node dist/main.js backup restore --file downloaded.fdrive.age --key-file recovery-key.txt \
  --snapshot SNAPSHOT_UUID --state-dir /private/persistent/backups
```

For browser recovery, set `FDRIVE_RESTORE_MODE=true` and a host-generated
`FDRIVE_SETUP_TOKEN` of at least 24 characters, then open `/restore`. The token expires one
hour after API startup. Upload the encrypted archive, provide the private recovery key,
inspect the inventory, and type its snapshot ID to stage the restore. In this mode the API
does not compose normal providers, auth, feature services, outboxes or backup workers. Deploy
the web and API behind HTTPS before submitting a recovery key remotely.

Both paths validate every archive entry and checksum before import. Paths from an archive
are never used as extraction paths. Destination secrets are resealed under the new master key.
All providers/features/schedules start disabled, browser sessions are absent, API tokens are
revoked and unfinished scans become interrupted history.
Captures enforce the same format limits as restore: 4 MiB per database row/header, 100,000 recovery files, 64 MiB manifest and 1 TiB uncompressed archive. Oversized captures fail before publication. Existing archive files are never replaced.

Restoring into a nonempty durable database is refused. A failed import rolls back rows and
removes only its own staging directory.

Run `backup environment` on the destination to obtain its environment fingerprint. Review
mounts, root names and Office/public URLs. Create a private review file:

```json
{
  "snapshotId": "SNAPSHOT_UUID",
  "environmentFingerprint": "SHA256_FROM_BACKUP_ENVIRONMENT",
  "providers": [{ "id": "ORIGINAL_PROVIDER_UUID", "baseUrl": "local" }],
  "ownerIdentityId": "ORIGINAL_OWNER_IDENTITY_UUID",
  "password": "OWNER_PASSWORD",
  "oldDeploymentStopped": true,
  "pathBindingsReviewed": true
}
```

`password` is the owner's fdrive password, checked against their restored user.
`pathBindingsReviewed` is the operator's statement that the annotation review below was done.
Resume refuses a review file without both flags set to `true`.

### Annotation review before resume

Tags, favourites, folder views and recents are bound to an identity and a path. A snapshot
cannot prove that a path still names the same file: a files folder that kept changing may have
deleted, replaced or reused it. While the restore is paused every provider is disabled, so
restored annotations are inactive. Before setting `pathBindingsReviewed`:

1. List what was restored per identity, read-only:

   ```sql
   select i.id, i.external_username, p.base_url,
          (select count(*) from app.file_tags t where t.identity_id = i.id) as tags,
          (select count(*) from app.favorites f where f.identity_id = i.id) as favorites,
          (select count(*) from app.folder_views v where v.identity_id = i.id) as folder_views,
          (select count(*) from app.recents r where r.identity_id = i.id) as recents
   from app.identities i join app.providers p on p.id = i.provider_id;
   ```

2. Compare the annotated paths (`select path from app.file_tags where identity_id = ...`, and
   the same for the other three tables) with the current files folder on the host. A freshly
   rebuilt index must not be used to infer continuity.
3. Delete rows whose path is gone or was reused, or leave the provider disabled until the
   owner decides. Keep the archive: it remains the evidence for any row you remove.
4. Only then set `pathBindingsReviewed: true`. A checked flag alone does not make an ambiguous
   association correct.

### Replacement and rollback

Restore never swaps a live database from inside the API. A replacement is a host procedure,
rehearsed by `apps/api/src/backups/recovery.test.ts` (“rehearses a host cutover and rollback”):

1. Drain editors and native clients, make a final backup, and stop the old API, worker and OCR
   services. Keep the old database, master key and backup directory unchanged: they are the
   rollback target.
2. Stage the restore into a **new** database, a new master key and a new backup directory with
   `backup restore`, using the same fdrive release. The old pair is not touched.
3. Run `backup environment` on the new pair, complete the annotation review, then
   `backup resume` with the review file. Start the API against the new pair with
   `FDRIVE_RESTORE_MODE=false`, re-enable reviewed features and schedules, confirm a recovery key,
   and reconnect clients.
4. Roll back by stopping the new pair and starting the old services against the old database,
   master key and backup directory. Nothing in the staged restore wrote to them. Both
   installations share the same installation ID and backup prefix, so never run them at once.

### Isolated rehearsal

`backup rehearse` takes the same arguments as `backup restore` but restores into a distinct
installation identity that can never resume the source installation's ownership, contacts no
provider, and prints a JSON report. Run it monthly against an empty database on a host without
access to production storage, review the result, then upload the report under
System → Backups → Restore rehearsal. Uploading records your review; it is not an automatic
restore-success claim, and routine “Verify bytes” checks cannot decrypt anything without your
private recovery key.

### Measured costs

Local observations from `packages/backup/test/integration/benchmark.test.ts` on a developer Mac
with loopback containers; not performance promises.

| Fixture | Encrypted archive | Capture | Request pause | OCR pause | Peak RSS (capture / restore) | Fresh restore |
| --- | --- | --- | --- | --- | --- | --- |
| Empty installation | 5 KiB | 0.09 s | 0.008 s | 0.08 s | 238 / 239 MiB | 0.05 s |
| 60,000 history rows + 64 MiB recovery file | 65 MiB | 2.9 s | 0.003 s | 2.9 s | 364 / 496 MiB | 15.4 s |

Request pause is the longest any mutating request waited while requests ran back to back
through the capture; 472 of them finished while the large capture was reading. OCR pause is
how long a recovery file writer waited. Index regeneration after restore is separate and
depends on file volume.

Limitations these numbers expose:

- A capture starts once the requests and OCR writes already running have finished, and gives up
  after 30 seconds; requests that arrive meanwhile wait with it. After that, requests wait only
  for the snapshot.
- OCR's writes to kept originals wait for the whole capture and do not give up, so large
  recovery collections hold OCR back for as long as they take to read. Schedule backups at
  quiet hours.
- Restore memory grows with history volume (471 MiB for this fixture). Size the recovery host
  accordingly.
- A real Backblaze B2 bucket has been exercised for probe, delivery with readback, byte
  verification and exact-version deletion, but not measured for large transfers. Real AWS S3
  has not been contacted; MinIO qualification does not stand in for it.

```sh
node dist/main.js backup resume --review-file review.json
```

Resume checks the original owner's password against their restored user and checks the listed
provider bindings.
Restart the API with `FDRIVE_RESTORE_MODE=false`. Review and re-enable features and schedules
in System; confirm a recovery key before scheduling again. Reconnect native/MCP clients.

OCR, Office and log recovery bytes remain in the private `restore-UUID` quarantine. Its
`recovery-manifest.json` maps `blobs-N` files to original kinds, paths and source mount IDs; the
database's `backup.recovery.v1` setting retains the source environment.
Reconcile those bytes against the current files folder before applying them. Subsequent backups
also preserve this quarantine. fdrive never applies quarantined bytes automatically.
