# P7 archive peek (requested 2026-09-07)

Preview the contents of an archive without extracting it. Read-only; extraction stays a job.

## API (apps/api, packages/contracts)

- `GET /api/v1/fs/archive-entries?path=<virtual path>` on `authed`, contract
  `ArchiveEntriesResponse = { format: "zip" | "tar" | "tar.gz" | "tar.zst"; entries: Array<{ path:
  string; kind: "file" | "dir"; size: number; modifiedAt: string | null }>; truncated: boolean }`.
  Entries are bounded at 5000 and sorted by path; `truncated` when the bound is hit.
- ZIP: never download the whole file. Read the end of the archive with `storage.download(path,
  { range })` (SFTPGo supports Range): fetch the last 64 KiB to find the end-of-central-directory
  record (and ZIP64 locator when present), then Range-fetch exactly the central directory and
  parse entry headers from that buffer (`yauzl.fromBuffer` on a synthesized buffer is not
  possible, so parse the central directory records directly: a small pure parser with tests,
  handling UTF-8 flag, ZIP64 sizes, directory entries by trailing slash, and skipping names with
  `..` or absolute paths, which are reported with `kind: "file"` but never used as paths).
- tar, tar.gz, tar.zst: stream through the existing archive tooling in `apps/api/src/archive`
  (`extract.ts` already parses these), stopping the read after 5000 entries or after
  `FDRIVE_ARCHIVE_PEEK_MAX_BYTES` (default 512 MiB) of compressed input, setting `truncated`.
  Never write to disk.
- Errors: unsupported extension 400 `bad_request`; corrupt archive 422 mapped to `bad_request`
  with message "not a readable archive"; storage errors as everywhere else. Route tests with
  the fake server using real archive bytes produced by `yazl`/`tar-stream` in the test.
- Scope: this is a read of the user's own file through `principal.storage`, so SFTPGo
  authorizes it; no index involvement.

## Web (apps/web)

- Preview kind `archive` renders an `ArchivePreview`: header with the archive name and size, a
  table of entries (name with folder path, size, modified) with directory rows grouped by their
  folder, a search box filtering entries client-side, a note when `truncated`, and the existing
  Download button plus "Extract here" and "Extract to" actions reusing the current extract
  job flow. Loading skeleton and a friendly error state ("This archive cannot be read").
- Query in `lib/files/queries.ts` or a new `lib/archive/queries.ts`, keyed by path, invalidated
  on fs events for that path.
- Tests: pure parser 100 percent, route tests, web unit tests for grouping and filtering,
  Playwright: open a zip and a tar.gz created through the app's own Compress job, see their
  entries, filter, extract from the preview.
