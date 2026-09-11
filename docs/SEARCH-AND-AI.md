# Search, thumbnails and AI

Search combines filenames, document content and available visual image matches in one
query. File type is a filter; there is no separate Images mode switch. Text and image
services report their availability independently.

## Enable and manage

Administrators enable optional processing during onboarding or under System > Features.
Open each feature's page for its settings and status. The bundled runtime starts selected
services and downloads models when needed; allow initialization to finish on first use.
See [deployment](../deploy/README.md) for the current stack and network configuration.

- Indexer: scan status, include/exclude rules, reindex and clear operations.
- Search: text embedding and search readiness.
- Image search: visual embedding status and rebuild/clear controls.
- Thumbnails: generation, rebuild and cache clearing.
- OCR: separate search extraction and PDF conversion choices; conversion scheduling and
  original-file behavior are documented in [OCR](OCR.md).

These selections are persisted in the application. Feature activation does not require
editing Compose profiles or environment variables. Mounted storage and deployment resource
configuration remain operator responsibilities.

## Behavior and limits

The configured local services extract document text and build search vectors and thumbnail
previews. SigLIP visual search embeds generated thumbnails and text queries in the same
vector space. This is distinct from the planned perceptual similar-image comparison.

Index-backed results require verified mappings to mounted storage and live read permission.
Remote or unmapped storage can still be browsed, but does not automatically gain search or
thumbnails. For account-wide queries, text may span linked identities while visual results
remain scoped to the active identity.

Rule changes take effect through the service settings cycle; they do not remove originals
or necessarily purge previously cached results. A rule-preview UI remains in the
[roadmap](plans/ROADMAP.md). Partial text-result messaging is tracked in
[followups](plans/FOLLOWUPS.md).

## Developer references

- [Indexer](INDEXER.md) and [OCR](OCR.md): settings, processing and internal endpoints.
- [Image embedding service](../services/image-embed/README.md): model, bounded HTTP contract
  and model-free unit-test setup.
- [Scoping](SCOPING.md): mapping and authorization requirements for every consumer.
