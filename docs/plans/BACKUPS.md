# Backup verification

Implementation is in `codex/backups`, worktree `/private/tmp/fdrive-backups`, uncommitted.
Behavior, operator procedures and measured costs: [Installation backups](../BACKUPS.md).
The original design and acceptance criteria this work is checked against are recorded in
that document's sections and in the archived plan in the main checkout's history.

Implemented and locally qualified: durable registry, encrypted snapshots and opaque ZIP
attachments, local downloads, S3/B2-compatible and pinned-fileserver destinations (MinIO,
Apache WebDAV and SFTPGo, including large streamed transfers and fileserver-only recovery),
schedules, retention and pins, worker heartbeat, size estimates, metadata-only fallback,
retention-kept probes, spool sweeps, isolated rehearsal, CLI cutover and rollback rehearsal,
and the browser owner flow including the health panel.

Remaining before the feature is complete:

- Real Backblaze B2 passed through the browser UI on 2026-09-14 against the owner's test
  bucket `fdrive-local-test` (`s3.us-west-004.backblazeb2.com`, virtual-host addressing):
  probe, upload with full readback, B2 file version IDs recorded for archive and marker,
  byte verification, and exact-version deletion. Real AWS S3 and B2 Object Lock remain
  untested; a local MinIO with versioning and default Object Lock retention covered those
  paths through the same UI.
- Hosted CI has not run on this branch (Actions is disabled for cost). Run `CI (full)` by
  dispatch before merge.
- A real host cutover on a deployed installation, following the documented replacement and
  rollback procedure, has not been performed; only the CLI rehearsal has.
- Capture holds the exclusive checkpoint for its whole duration; writers give up after 30 s.
  Releasing the pause once sources are pinned is a follow-up if measured captures grow long.
- Legacy OCR mapping recovery queries per original with a 1001-row candidate cap; large legacy
  inventories may need batching.
