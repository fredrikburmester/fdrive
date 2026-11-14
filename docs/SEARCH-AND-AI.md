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

Results are ordered by what the query most likely meant, then by age. A file whose name is
the query comes first, then one whose name holds every query word, then one whose name and
folders hold them between them; all of these rank above a file found by its content alone.
Words match from their start, ignoring case, punctuation and how accents are encoded, so a
name macOS stored with decomposed accents matches the same word typed normally.

A name typed with a typo is found too: a word of five to eight letters may hold one typo, and
a longer word two (a letter changed, added, dropped, or two neighbours swapped), so "Microlär"
finds "Mikrolärande". An a typed for an ä counts as one typo. These matches come from the
indexer's name index and rank below every name spelled as typed, however new, but above a file
found by its content alone. While the indexer cannot answer, names are found only as typed.
Every score is then weighted by modification time: full weight today, falling toward 40% with a half-life
of 180 days. A recent file therefore beats an older one that matched about as well, and an
old file still surfaces when it matches clearly better. The constants live in
[ranking.ts](../packages/core/src/search/ranking.ts).

The Folders section lists up to five folders whose own name holds every query word, empty
ones included, ranked the same way: by how the name matches, then by the folder's
modification time. A folder whose name matches only with a typo comes after every other. The indexer records every folder it walks in `idx.folders`, so a folder
made a moment ago in fdrive is found at once, as is one made over SMB once the watcher sees
it. Your own home folder, and the folder a "This folder only" search starts in, are never
listed, and a type filter hides the section, since folders have no type.

Index-backed results cover the files folder, including folders other users share with you,
and require live read permission. fdrive's own folders (`isReservedPath` in `@fdrive/core`: the
login's Trash folder, fdrive's Trash layout `.fdrive-move-v1` wherever it lies, the Mac app's
`/.fdrive-desktop` and `.fdrive-backups`) are left out by every search, image search, MCP and
AI index query, mapped through the login's index scopes, before the query's row limit, so they
never crowd out live files or count in a total. For account-wide queries, text may span linked
identities while visual results remain scoped to the active identity.

PDF conversion rewrites the file in place, so System > Searchable PDFs keeps the file each
rewrite replaced. **Kept originals** there lists them with what each one would overwrite, and
restores, downloads or deletes one. A restore puts the exact pre-OCR bytes back and stops the
next pass from converting that file again; overwriting a file that changed after conversion,
or recreating one that was deleted, each require a separate confirmation. Turning off
*Keep originals* saves disk space and makes every later rewrite permanent; *Keep originals
for* deletes kept copies after a set number of days, and keeps them forever at zero.

Rule changes take effect through the service settings cycle; they do not remove originals
or necessarily purge previously cached results. A rule-preview UI remains in the
[roadmap](plans/ROADMAP.md). Partial text-result messaging is tracked in
[followups](plans/FOLLOWUPS.md).

## Developer references

- [Indexer](INDEXER.md) and [OCR](OCR.md): settings, processing and internal endpoints.
- [ML server](../services/ml/README.md): the text and image embedding models, document
  extraction, the bounded HTTP contract and the model-free unit-test setup.
- [Scoping](SCOPING.md): mapping and authorization requirements for every consumer.
- [AI organize](AI.md): the language-model feature, which reads index excerpts but runs no
  local model.
