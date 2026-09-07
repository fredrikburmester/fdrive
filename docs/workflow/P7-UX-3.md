# P7 UX pass 3 (user feedback, 2026-09-07 afternoon)

Three items from the user, verified against the code before chunking:

1. "The upload toast is not scrollable; uploading more than ten files hides the rest." The floating
   panel is `components/activity/activity-panel.tsx`, a fixed `w-80` Card. Its list sits in
   `<ScrollArea className="max-h-72">`, but the Base UI ScrollArea root's `max-h` does not bound the
   viewport (`size-full`), so the list grows past the screen and nothing scrolls on desktop.
2. "Is it possible to see the size of a folder?" SFTPGo has no folder-size API, but the index
   (`idx.files.size`) already knows every indexed file. Decision: folder size comes from the index,
   is labelled as such, and is unavailable outside indexed scopes. Never walk SFTPGo recursively.
3. "The grid view still doesn't show thumbnails." `components/files/file-grid.tsx` renders only
   `FileIcon`; nothing in the logged-in listing requests `apiClient.thumbUrl`. The search panel and
   the public gallery already do (`search-panel.tsx` line 80: request the 256 thumb, fall back to
   the icon on error).

## Chunk `grid-thumbs` (apps/web)

Owned paths: `apps/web/src/components/files/**`, `apps/web/src/components/activity/**`,
`apps/web/src/lib/files/**`, `apps/web/e2e/browse.spec.ts` or a new `grid-thumbs.spec.ts`.

1. **Grid tiles show thumbnails.** For a `file` entry whose extension is an image type the indexer
   thumbnails (reuse the predicate the search panel or `lib/preview/kind.ts` uses for `image`;
   put a pure `wantsGridThumbnail(entry)` in `lib/files/`), render
   `<img src={apiClient.thumbUrl(entry.path, 256)} loading="lazy" decoding="async">` in the tile's
   icon slot, object-cover inside the same footprint as the icon, rounded, hairline ring; on
   `onError` fall back to `FileIcon` for good (per-tile state keyed by path, reset when the path
   changes). Folders and non-image files keep the icon. Keep `GRID_TILE_WIDTH/HEIGHT` unchanged
   so the virtualizer math and skeleton stay valid. Only visible (virtualized) tiles mount, so the
   request count is bounded by the viewport.
2. **Activity panel scrolls.** Bound the list on desktop: give the panel a `max-h-[70vh]` and make
   the list region the scrolling element (either pass the max height to the ScrollArea viewport by
   extending `components/ui/scroll-area.tsx` with a `viewportClassName` prop, or replace that
   ScrollArea with a `max-h-72 overflow-y-auto` div; pick the smaller diff and say which). Header,
   progress bar and the collapse control stay visible while the list scrolls. Mobile keeps its
   existing `max-h-[50vh]`.
3. **Tests.** jsdom: a grid with an image entry renders the thumb `img` with the expected URL, an
   error swaps to the icon, a folder never gets an `img`; the activity panel with 30 uploads has a
   bounded scrolling list (assert the class or computed style on the scrolling element). Playwright:
   in grid view an image file's tile shows an `img` whose request answered 200 (the e2e stack has
   thumbnails via the fake indexer fixture; if the fixture has none, seed one the way
   `search.spec.ts` or the share gallery spec does). `@fdrive/web` coverage gate stays green.

## Chunk `folder-size` (packages/contracts, packages/db, apps/api, apps/web inspector)

Owned paths: `packages/contracts/src/{fs,routes,client,index}.ts` (+tests),
`packages/db/src/repos/index-queries.ts` (+tests, +integration test),
`apps/api/src/fs/**` (a new `folder-size.ts` module and route registration only),
`apps/api/src/composition.ts` (route deps wiring only), `apps/web/src/components/inspector/**`,
`apps/web/src/lib/inspector/**` or wherever `describeEntry` lives, `apps/web/src/lib/api/**` only if
a query hook file is needed.

1. **DB.** `IndexQueries.subtreeSize(scopePrefixes, rootId, relativePrefix)` ->
   `{ bytes: number, files: number }` over live rows (`deleted_at IS NULL`) whose `root_id` matches
   and whose `path` equals `relativePrefix` or starts with `relativePrefix + "/"` (root of the root
   is the empty prefix, matching everything), **intersected with `scopeCondition(scopePrefixes)`**
   so a caller never sums outside their verified scope. Bigints come back as numbers via
   `Number(...)`; guard `Number.MAX_SAFE_INTEGER` with a test.
2. **API.** `GET /api/v1/fs/folder-size?path=<virtual dir path>` ->
   `FolderSizeResponse = { path, bytes, files, indexed: boolean }`. Resolution mirrors the thumb
   route exactly: `normalizePath`, identity, `resolver.verifiedIndexScopes`, `toFsPath(scopes, path)`
   to `{rootName, fsPath}`, `rootIdsByName`, then a live-read check
   `authorizer.authorize({ path, kind: "dir" })` **before** any index query. Any of those failing
   answers 200 `{ indexed: false, bytes: 0, files: 0 }` for a not-indexed or out-of-scope folder,
   and 403/404 exactly as `fs/list` does for a folder the caller cannot read. The relative prefix
   passed to the DB is derived from `fsPath` minus the scope's `fsPrefix` the same way the existing
   `toScopeClauses` helper does; add a pure, tested function for that and do not duplicate the
   prefix math in two places. Trash path excluded like search (`trashPath` dep).
3. **Web.** In the Inspector's single-entry body, when `entry.kind === "dir"`, a lazy TanStack query
   (`staleTime` 30 s) for the folder size; rows: "Size" -> `formatBytes(bytes)` and "Files" ->
   count, with a muted one-line note "From the index" while indexed, or the row value "Not indexed"
   when `indexed: false`. No spinner jank: show "Calculating" text in the value cell while loading.
   Multi-selection summary is unchanged (it sums only files, as today).
4. **Tests.** DB unit + container integration for the prefix and scope intersection (a scope narrower
   than the requested folder must not leak sizes from outside it), API route tests with fakes
   (indexed, not indexed, out of scope, denied live read, trash path, MAX_SAFE_INTEGER), contracts
   tests, Inspector jsdom tests for the three states. All package coverage gates green.
