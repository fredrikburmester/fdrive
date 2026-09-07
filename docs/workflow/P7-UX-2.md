# P7 UX pass 2 (requested 2026-09-07)

User feedback on the public share gallery, plus one file-listing removal and one investigation.
Frontend rules apply throughout: shadcn/ui components only (added with the CLI), Apple-like
design language, colours from `globals.css` tokens, every visible change checked at 390x844 and
1440x900.

Verbatim intent:

- Shared gallery: tiles load a thumbnail, not the full image; pressing a tile opens a **full page**
  lightbox that looks exactly like the logged-in image view (not a modal); drop the
  "Previews and download requests count toward this link's download limit." line; do not show the
  usage line at all when the link has no limit; "Download ZIP" becomes a classy down-arrow icon
  button like the logged-in UI, not a big blue button; preload the next/previous lightbox image.
- File list/grid: remove drag-to-select (marquee) entirely. (Shift-click on rows already works and
  is explicitly out of scope: the user confirmed it is not a bug.)
- Investigation: image search by content ("blue chair") with an image model.

## Orchestrator decisions

1. Gallery thumbnails need a **public** thumbnail route; there is none today, and each tile is
   currently a counted SFTPGo download. New route: `GET /api/v1/public/shares/:id/thumb`.
2. Thumbnails are served from the indexer's WebP cache, never through SFTPGo's share download, so
   **a thumbnail never consumes a download token**. Full-size images (the lightbox, the download
   button, the ZIP) stay counted, unchanged.
3. The existing rule stands: a download-limited link is never rendered as a gallery
   (`resolveEntriesPresentation`'s `downloadLimited`). Not in scope to revisit.
4. The public thumb route must verify the share password itself. SFTPGo only checks it when it
   actually serves bytes, and a thumbnail leaks the image. Verification is one SFTPGo share
   listing per (share, password), cached briefly, so a 200-tile grid costs one upstream call.
5. `shareUsage` keeps its current text for the owner's Shares table. The public page gets its own
   helper that returns `null` when the link has no limit.

## Chunk `share-thumbs` — packages/contracts, apps/api

Owned paths: `packages/contracts/src/**`, `apps/api/src/**`, `apps/api/test/**`.

1. **Contract.** Add `shareThumbUrl(id: string, path: string, size: ThumbSize): string` to
   `ApiClient`, next to `shareDownloadUrl`, building
   `${publicShareRoute(id)}/thumb?path=<path>&size=<size>`. Validate exactly like the other public
   share URL helpers. Unit test the built URL, including a path with spaces and non-ASCII.
2. **Shared serving tail.** The last half of `registerThumbRoutes`'s handler (root id by name,
   `fileByPath`, `thumbnail(sha256, size)`, `fileReader.stat`, stream the WebP with
   `Content-Type: image/webp`, `Cache-Control: private, no-store`, `ETag: "<sha256>"`) is identical
   for the authed and the public route. Extract it into one helper (e.g.
   `apps/api/src/thumbs/serve.ts`) used by both; do not copy it. The authed route's behaviour must
   not change (its tests stay green as written).
3. **Route.** `GET /api/v1/public/shares/:id/thumb?path=&size=256|1024`, registered inside
   `registerSharesRoutes` so it inherits the existing public-share rate limiter and response
   headers. Every failure answers exactly the same way: 404 `not_found`, no body detail, no
   distinction between "wrong password", "not indexed", "no thumbnail", "expired" or "no such
   share". Order of checks:
   1. `thumbsDir` configured, else 404.
   2. `path` parses as `SharePath`, `size` is one of `THUMB_SIZES`, else 404 (not 400: the route
      must not become an oracle).
   3. Load the share (reuse the service; add a method rather than reaching into the repo from the
      route). It must exist, have `scope === "read"`, have `unavailableReason === null` (expired or
      limit-reached is 404), and have exactly one entry in `paths` (an archive share has no
      per-file thumbnails).
   4. When `share.hasPassword`, verify the credential cookie's password against SFTPGo by listing
      the share root (the same call `/entries` already makes; it consumes no download token).
      Cache the boolean per share id + password for 60 s in a bounded (<= 256 entries) in-memory
      map so a full grid costs one upstream call; a wrong or missing password is 404. Put the
      cache in its own small module with its own unit tests (pure, injected clock).
   5. Resolve the virtual path: `share.paths[0]` when `path === "/"`, otherwise
      `share.paths[0] + path`. `SharePath` already rejects `..`, `.`, empty segments, backslashes
      and control characters; assert that with tests (`..%2F`, `/a/../b`, `//`, `\`, absolute
      Windows paths) rather than adding a second sanitiser.
   6. Resolve the owner: `repos.identities.get(row.identityId)`, then
      `resolver.verifiedIndexScopes(identity)` and `toFsPath(scopes, virtualPath)`, exactly like
      the authed route. 404 when unavailable or unresolvable.
   7. Serve through the shared tail from (2).
   No `createReadAuthorizer` probe here, and no SFTPGo download: the share itself is the
   authorization, and a live read probe would either cost a download token or need owner
   credentials. Say so in a comment on the route.
4. **Wiring.** `registerSharesRoutes` takes the new deps (`indexQueries`, `resolver`, `identities`,
   `thumbsDir`, optional `fileReader`); wire them in `composition.ts` from the same values
   `registerThumbRoutes` already receives.
5. **Tests** (`apps/api`, vitest, fakes — no containers): happy path returns the WebP bytes and
   headers; unknown share, write-scope share, archive share (2+ paths), expired share,
   limit-reached share, wrong password, missing password on a protected share, traversal paths,
   bad size, `thumbsDir` undefined, file not indexed, no thumbnail row, cached file missing from
   disk — every one a 404 with no distinguishing body. Password-verification cache: hit, expiry,
   eviction, and that a failed verification is not cached as success. Keep the package's coverage
   gate green.
6. **Docs.** One paragraph in `docs/INDEXER.md` (or the shares section of `README.md`, whichever
   already describes the thumb route) stating that public share thumbnails come from the index
   cache and are not counted as downloads.

## Chunk `files-selection` — apps/web (files listing only)

Owned paths: `apps/web/src/components/files/**`, `apps/web/src/lib/files/**`, `apps/web/e2e/**`.

1. Remove drag-to-select entirely: delete `components/files/use-marquee-selection.ts`,
   `lib/files/marquee.ts` and their tests, the `data-marquee-exclude` attribute, the
   `data-slot="marquee-rect"` overlay in `file-list.tsx` and `file-grid.tsx`, and any prop that
   exists only for it. Check every consumer first (`file-browser.tsx`, `virtual-listing.tsx`,
   `favorites-page.tsx`, `tag-page.tsx`, `recents-page.tsx`, `trash-page.tsx`, e2e specs): some of
   `marquee.ts` may be imported for non-marquee reasons, and `onChangeSelection` may still be used
   by other callers.
2. Keep "a plain click on empty listing space clears the selection". It currently rides on the
   marquee hook's container click listener. Reimplement it as a small pure predicate in
   `lib/files/background-click.ts` — "is this click target outside every `[data-path]` row/tile and
   outside the sticky header?" — used from a plain container `onClick`. Unlike the old
   `isMarqueeStartTarget`, a click **on** a row element itself (its padding) must count as a row
   click, not as background: clearing on it wipes the selection anchor and breaks the shift-click
   range the user relies on. Unit test the predicate.
3. Shift-click selection on rows/tiles is already correct and stays as it is. Do not touch
   `lib/files/selection.ts` or the checkbox's `onCheckedChange` semantics.
4. Tests: jsdom test that a drag across rows selects nothing and that a click on empty space still
   clears; a Playwright spec in `apps/web/e2e` that drags across two rows in list view and in grid
   view and asserts the selection is unchanged, and that shift-click on rows still selects a range
   (a regression guard for point 2).

## Chunk `share-gallery-ui` — apps/web (shares only), after `share-thumbs` merges

Owned paths: `apps/web/src/components/shares/**`, `apps/web/src/lib/shares/**`,
`apps/web/e2e/**` (share specs only).

1. **Thumbnail tiles.** Grid tiles use `client.shareThumbUrl(id, path, 256)`, keeping
   `loading="lazy"` and `decoding="async"`. On the tile image's `onError`, fall back to the full
   `shareDownloadUrl` for that tile only (per-tile state; a share whose files are not indexed, or a
   deployment with no index profile, must still show its images).
2. **Full-page lightbox.** Replace the `Dialog` with a full-page overlay: `fixed inset-0 z-50`,
   `bg-background`, `role="dialog" aria-modal="true"`, body scroll locked while open, focus moved
   into the overlay and restored on close. It must read as the logged-in
   `components/preview/preview-shell.tsx` view: the same `h-12` top bar (close/back on the left,
   file name, `n / total` counter with prev/next icon buttons centred, download on the right, all
   `Button variant="ghost" size="icon-sm"` with tooltips), and the image body rendered by the
   existing `components/preview/image-viewer.tsx` so the checkerboard and click-to-zoom behave
   identically. Reuse that component; do not restyle a second image element by hand. Escape closes,
   ArrowLeft/ArrowRight navigate (keep the existing capture-phase listener note only if it is still
   needed once Base UI's Dialog is gone — plain `window` listeners are fine for a non-Dialog
   overlay). The lightbox shows the full-size image (`shareDownloadUrl`), not the thumbnail.
3. **Preload.** When the open index changes, preload the neighbouring full-size images with
   `new Image()`. Put the index arithmetic in `lib/shares/gallery.ts` (e.g.
   `neighborIndexes(current, total)`, wrapping like `stepLightboxIndex`, empty for a single image)
   with unit tests; the component only consumes it.
4. **Copy.** Delete the "Previews and download requests count toward this link's download limit."
   paragraph from `public-share-page.tsx`.
5. **Usage line.** Add `publicShareUsage(share): string | null` to `lib/shares/status.ts`,
   returning `null` when `maxDownloads === 0` and `"<used> of <max> downloads"` (uploads for a
   write share) otherwise. The public page renders the span only when it is non-null. Leave
   `shareUsage` and the owner's Shares table alone.
6. **ZIP button.** `NativeShareDownload` gains an icon-only presentation (a new prop, default
   unchanged) rendering `Button variant="ghost" size="icon-sm"` with a `Download` icon, an
   `sr-only` label and a shadcn `Tooltip`, matching `TopBarAction` in `preview-shell.tsx`. Use it
   for the directory header's "Download ZIP" and for the lightbox's per-image download. The
   standalone `ZipDownloadCard` (a share whose whole point is the archive) keeps a labelled button.
7. **Tests:** jsdom for the tile falling back to the download URL on error, the lightbox opening
   full-page (no `role="dialog"` modal from Base UI, overlay covers the viewport), Escape/arrow
   handling, `publicShareUsage`, `neighborIndexes`. Playwright share specs: a gallery share's tiles
   request `/thumb`, a tile opens the full-page lightbox, arrows move between images, Escape
   returns to the grid, the limit sentence is gone, and the header ZIP control is an icon button
   with an accessible name.

## Investigation `image-search`

Written up separately in `docs/workflow/P7-IMAGE-SEARCH.md`; no code in this pass.

## Chunk `share-peek-api` — packages/contracts, apps/api (after `share-thumbs` merges)

Requested mid-pass: "peek inside zip file" on a shared link. The logged-in feature already exists
(`GET /api/v1/fs/archive-entries`, `apps/api/src/archive/peek.ts`, `ArchivePreview`); this chunk
gives a public share the same reading without extracting.

1. **Route.** `GET /api/v1/public/shares/:id/archive-entries?path=<share path>` in
   `registerSharesRoutes`, answering the existing `ArchiveEntriesResponse` contract unchanged.
   Contract addition: `shareArchiveEntries(id, path)` on `ApiClient`, next to `shareEntries`.
2. **Reuse.** Call `peekArchive` from `apps/api/src/archive/peek.ts`. It wants a `StorageProvider`;
   a public share offers `SftpgoPublicShareApi` (`list`, `download`, `downloadFile`, no
   `statFile`). Write a small adapter module with its own tests that exposes exactly the two
   methods `peekArchive` uses, backed by the share api:
   - `download(path, options)` maps to `api.download(path, options)`, or to `api.downloadFile(options)`
     when the share is a single file (`path === "/"`).
   - `statFile(path)` must not exist as an SFTPGo call, because the share api has none. Get the size
     from the zip tail read instead: issue the tail read as a **suffix range**
     (`rangeHeader: "bytes=-65536"`, which `DownloadOptions` already supports) and take the total
     size from `DownloadResult.contentRange` (`bytes <start>-<end>/<total>`). If the server ignores
     the range and answers `200`, fall back to reading the whole body only when `contentLength` is
     known and at most 32 MiB, else raise the unreadable-archive error. Parse `Content-Range` in a
     pure, tested function.
   - This means `peekArchive` needs to accept a storage-shaped port rather than the full
     `StorageProvider`. Narrow its option type to the methods it actually calls (`statFile`,
     `download`) — a structural narrowing, no behaviour change, existing tests stay green — or
     add a sibling entry point that takes the tail-and-size port. Pick the smaller diff and say
     which in the report.
3. **Authorization and limits.** Reuse `service.publicAccess(id, password, "read")` (expired and
   limit-reached already 403 there). Additional rules, all answering 403 `forbidden` with a plain
   message, never leaking whether the file exists:
   - a share with a download limit (`maxTokens > 0`) never peeks: every Range read is a real
     SFTPGo download that would consume the link's budget. Same reasoning as "a limited link is
     never a gallery".
   - `share.paths.length !== 1` (an archive-of-many share) does not peek.
   - `path` parses as `SharePath`; unsupported extensions and corrupt archives map to
     `bad_request` exactly as the authed route does.
4. **Tests** (fakes, no containers): zip peek through a directory share and through a single-file
   share; suffix-range size parsing including a `200` fallback and an over-large `200`; limited
   share rejected; multi-path share rejected; wrong password; unsupported extension; corrupt
   archive; entry bound and `truncated`. Keep `apps/api` and `packages/contracts` coverage green.

## Chunk `share-peek-web` — apps/web shares (after `share-gallery-ui` merges)

1. A `.zip`/`.tar`/`.tar.gz`/`.tar.zst` row in a shared directory listing gets a "Peek" action
   beside Download (hidden when the share has a download limit, since the API refuses it), and a
   single-file archive share shows it beside the download button.
2. It renders the archive's entries with the same component the logged-in preview uses
   (`components/preview/archive-preview.tsx`) if that component can take its data through props;
   if it is bound to the authed query, extract the presentational part and reuse it rather than
   writing a second table. Public entries never link anywhere: a shared archive's members are not
   individually downloadable.
3. Truncated listings show the same "first 5000 entries" notice as the logged-in view.
4. Tests: jsdom for the action's visibility rules (limited link, non-archive file) and the entries
   table, plus a Playwright share spec peeking a seeded zip.
