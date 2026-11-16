# Remaining features

These features are not delivered. Trash, image search and settings persistence already exist;
this backlog describes only what is missing.

## File snapshots and version history

Implement explicit file snapshots, optionally captured for fdrive writes. This is history
created by fdrive, not a complete record of writes made by external clients.

- Use bounded copies/streams and identity-bound metadata; snapshots follow renames. Pin the
  storage layout and write/lock contract before implementation.
- Require current original-file read authorization to expose history. Do not reuse the old
  application-owned Trash design; Trash stays separate. Stored snapshot bytes must not bypass
  history authorization through browse/search/share/Office paths.
- Restore first creates a safety snapshot of the current file, rejects conflicting Office
  writes and replaces bytes only once the complete restore source is available. Publish normal
  file-update events after restore.
- Make cross-system operations resumable or compensatable across failures/restarts. Retention
  deletion requires an explicit setting or action.
- Complete when create/list/restore, rename continuity, failure recovery and cross-identity
  isolation pass real-storage integration and browser checks.

## Perceptual similar-image comparison

Delivered SigLIP image search matches a text query to pictures. This feature instead finds
visually similar files using versioned perceptual hashes, independent of the embedding model.

- Compute bounded raster-image hashes with EXIF orientation normalization and stored dimensions.
  Keep exact SHA-256 duplicates separate. Document the Hamming-distance threshold.
- Use bounded scoped candidate lookup and mapping round trips. No per-request
  unbounded all-pairs scan, remote image fetching or automatic deletion.
- Provide comparison/reveal UI using existing explicit file actions. Explain false positives.
- Complete with transformed/cropped/unrelated fixtures, permission isolation, browser comparison
  checks and candidate-lookup measurements on the performance fixture.

## Index-rule previews and explanation

Include/exclude glob editing and persisted settings already exist. Finish the administrator
experience around their interpretation and effects.

- Preview supported rules against selected configured-root paths without revealing another
  identity's content. Match the actual indexer/OCR rule semantics, including prefix/glob behavior.
- Explain when changes take effect and when reindex/purge is needed; changing a rule must not
  imply that existing cached rows disappeared or that original files were removed.
- Complete with rule-engine parity tests, authorization checks and browser preview verification.
