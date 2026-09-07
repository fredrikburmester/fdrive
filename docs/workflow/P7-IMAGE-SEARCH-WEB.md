# Chunk `image-search-web` (spec, 2026-09-07)

Implements the last chunk of `docs/workflow/P7-IMAGE-SEARCH-BUILD.md` against the merged API
(`73910fa`, spec `docs/workflow/P7-IMAGE-SEARCH-API.md`). Owned paths: `apps/web/**` only.

API surface to consume (read `packages/contracts/src/{search,system,routes,client}.ts`):
`apiClient.searchImages(q, { limit? })` -> `ImageSearchResponse { query, hits: ImageSearchHit[],
unavailable, partial?, tookMs }`; `apiClient.searchStatus()` now carries `images?: boolean`;
`apiClient.systemImageSearch()` -> `SystemImageSearchResponse { configured, healthy, model?, dim?,
embedded, embeddedModel, rebuild?, clear? }`; `systemImageSearchRebuild({ force? })` (202 or 409
conflict while a pass runs); `systemImageSearchClear()`. Thumbnails for a hit come from
`apiClient.thumbUrl(hit.path, 256)`; every hit was embedded from a thumbnail, so one exists.

## Decisions

1. **Search panel mode.** The existing search panel gains an "Images" toggle next to the filter
   chips (a shadcn `Toggle` or a chip in the same row, whichever the chip row already uses), shown
   only when `searchStatus().images === true`. While on, the panel runs `searchImages` (same
   debounce as text search, `useImageSearchResults` in `lib/search/queries.ts` with its own key)
   instead of text search, ignores the text-only filters (type/folder/date chips hidden while on,
   their state preserved), and renders a thumbnail grid: square tiles (`thumbUrl(path, 256)`,
   object-cover, rounded, hairline ring, name under the tile, one line truncated), keyboard and
   Enter behaviour identical to a file hit today (open or reveal). Empty state text: "No matching
   images". `unavailable: true` shows "Image search is not available" in the muted style the text
   panel uses for its unavailable state; `partial` shows the same "some results omitted" hint the
   text panel already has. The mode is remembered per session in `sessionStorage` behind a
   try/catch.
2. **System page.** New route `/system/image-search` rendered by
   `components/system/image-search-page.tsx`, modelled line by line on `thumbnails-page.tsx`:
   status badge (Not configured with the variable name `FDRIVE_IMAGE_EMBED_URL`, Unreachable, or
   Healthy with model and dimension), a stat card with the embedded count and the model that wrote
   the rows (flag with a warning badge when `embeddedModel` differs from the sidecar's `model`),
   a Rebuild button with a "Replace rows from other models" switch (`force`) and one-line
   description, a Clear button behind the same confirm dialog pattern Thumbnails uses, progress via
   `maintenance-progress.tsx` from `rebuild` / `clear`, polling while a pass runs the way
   Thumbnails polls. Sidebar: add "Image search" with the lucide `Images` icon after "Thumbnails"
   in `SYSTEM_NAV_ITEMS`. Every settings field carries a one-line description (WORKING.md rule).
3. **No new primitives.** Only existing `components/ui/*`; add a missing one with the shadcn CLI.
   Copy follows PLAN.md decision 14: no ellipsis in action labels.

## Tests

jsdom: `useImageSearchResults` (key, enabled only with a query and the mode on), the mode toggle
hidden without `images`, the grid renders tiles with the right thumb URLs, unavailable and partial
states, Enter opens the selected hit; the System page in all three status states, rebuild with and
without force, the 409 conflict message, clear confirm. Update every existing search fixture that
constructs `SearchStatusResponse` only if the typecheck demands it (the field is optional).
Playwright: extend `search.spec.ts` or add `image-search.spec.ts` only if the e2e fake indexer can
answer the sidecar; otherwise say so and rely on jsdom plus the primary's live check.
`@fdrive/web` coverage gate green: `pnpm biome check --write .`, `pnpm --filter @fdrive/web
typecheck`, `pnpm --filter @fdrive/web test:coverage`, `git status --short`.
