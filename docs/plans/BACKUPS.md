# Backup verification

Behavior, operator procedures and measured costs: [Installation backups](../BACKUPS.md).
Backups going to S3 only, without configuration ZIP attachments, is decision 4 and group 34 of
[SFTPGo leftovers](SFTPGO-LEFTOVERS.md).

Remaining before the feature is complete:

- Real AWS S3 has not been contacted, and Object Lock has run only against a local MinIO with
  versioning and default retention. A real Backblaze B2 bucket passed probe, upload with full
  readback, version IDs, byte verification and exact-version deletion through the browser, but
  has not been measured with large transfers.
- A real host cutover on a deployed installation, following the documented replacement and
  rollback procedure, has not been performed; only the CLI rehearsal has.
- Capture holds the exclusive checkpoint for its whole duration; writers give up after 30 s.
  Releasing the pause once sources are pinned is a follow-up if measured captures grow long.
- Legacy OCR mapping recovery (`packages/backup/src/ocr-mappings.ts`) queries once per original
  with a 1001-row candidate cap; large legacy inventories may need batching.
