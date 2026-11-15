# Backup verification

Behavior, operator procedures and measured costs: [Installation backups](../BACKUPS.md).

Remaining before the feature is complete:

- Real AWS S3 has not been contacted, and Object Lock has run only against a local MinIO with
  versioning and default retention. A real Backblaze B2 bucket passed probe, upload with full
  readback, version IDs, byte verification and exact-version deletion through the browser, but
  has not been measured with large transfers.
- A real host cutover on a deployed installation, following the documented replacement and
  rollback procedure, has not been performed; only the CLI rehearsal has.
- OCR's writes to kept originals wait for a whole capture (requests wait only for its database
  snapshot). OCR waits without giving up; if large OCR collections make captures long enough to
  matter, read the originals after an inventory taken under the gate, and make OCR's deletes
  alone wait.
- Legacy OCR mapping recovery (`packages/backup/src/ocr-mappings.ts`) queries once per original
  with a 1001-row candidate cap; large legacy inventories may need batching.
