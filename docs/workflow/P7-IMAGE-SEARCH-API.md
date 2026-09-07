# Chunk `image-search-api` (spec, 2026-09-07)

Implements the `image-search-api` chunk of `docs/workflow/P7-IMAGE-SEARCH-BUILD.md`. Prerequisites
`image-embed-service` (b4ce6f7) and `image-embed-db` (0e82be9) are merged.

Owned paths: `packages/contracts/src/**`, `apps/api/src/**`, `deploy/compose.yaml` (generated block
only, through `pnpm env:example`), `deploy/.env.example` (generated only). Do not touch `apps/web`,
`packages/db`, `services/**`. A sibling worker (`share-peek-api`) edits `packages/contracts/src/routes.ts`,
`packages/contracts/src/client.ts`, `apps/api/src/shares/**`, `apps/api/src/archive/**`: keep your
additions to `routes.ts`/`client.ts` grouped so the merge is a plain union.

## Orchestrator decisions

1. **Separate endpoint, not a section.** `GET /api/v1/search/images?q=&limit=` returning
   `ImageSearchResponse`. Reason: image search costs one sidecar round trip plus a vector query per
   keystroke, has no snippets/folders, is a distinct mode in the panel, and must not slow or degrade
   text search. The text response is unchanged.
2. **Contract** (`packages/contracts/src/search.ts`):
   - `ImageSearchHit = { path, name, ext, mime, size, modifiedAt, score }` (same field types as
     `SearchHit`, no snippets, always a file, thumbnail assumed present because the row came from an
     embedded thumbnail).
   - `ImageSearchResponse = { query, hits: ImageSearchHit[], unavailable: boolean,
     partial?: boolean, tookMs }`. `unavailable` is true when the caller has no verified index scope
     **or** image search is not configured **or** the sidecar did not return an embedding (a text-
     embed failure is not "degraded", there is no keyword fallback for images).
   - `ImageSearchQuery = { q: min(1), limit?: string }`; same `parseSearchLimit` clamp.
   - `SearchStatusResponse` gains `images: boolean` (configured).
   - `ApiClient.searchImages(query, opts?: { limit?: number })`.
3. **Ranking rule.** Fetch `IMAGE_FANOUT_LIMIT = 60` rows from `indexQueries.searchImages(prefixes,
   vector, model, 60)`, then a pure, tested `selectImageHits(rows, limit)`: keep rows in order, drop
   any row whose `score < best * IMAGE_SCORE_RATIO` (`0.6`) when `best > 0`; when `best <= 0`
   keep only the top `limit`. Never an absolute cosine threshold. `partial: true` when the fanout was
   exhausted (60 rows) or a live-read check was `unavailable`.
4. **Same scope and live-read rules as text search.** Verified scopes from
   `resolver.verifiedIndexScopes`, `rootIdsByName` mapping, `roundTripVirtualPath`, the trash-path
   exclusion, then `authorizer.authorize({path, kind:"file"})` per candidate. Copy the pattern from
   `apps/api/src/search/service.ts`; factor shared bits into a helper module only if it stays
   behaviour-identical for text search (existing tests must stay green).
5. **Model binding.** The API asks the sidecar `GET /health` for `{status, model, dim}` and only
   searches when `status === "ok"` and `dim === 1024` (`IMAGE_EMBED_DIM` constant); it passes the
   sidecar's `model` id to `searchImages` so rows from another model are ignored. Cache the health
   result 15 s via `createCachedProbe` style (or reuse it) so it is not fetched on every keystroke.
6. **Sidecar client** `apps/api/src/search/image-embed-client.ts`: `POST {base}/embed/text`
   `{ inputs: [q] }` -> `{ model, dim, embeddings: [[...]] }`, 5 s timeout, `null` on any failure;
   `health()` -> parsed `{ status, model, dim, device }` or `null`. Pure `parse*` functions tested.
   Truncate `q` to 512 chars before sending (sidecar bound).
7. **Config.** `FDRIVE_IMAGE_EMBED_URL` in `config.ts` (`fdriveImageEmbedUrl: string | undefined`,
   same preprocess as `FDRIVE_EMBED_URL`) and `config-keys.ts` (description: "Base URL of the
   SigLIP image-embedding sidecar. Unset disables image search.", example
   `http://image-embed:8012`, subsystem `imageSearch`).
8. **Subsystem.** Add `imageSearch` to `SUBSYSTEMS` in `config-keys.ts` and to `HealthSubsystemName`
   in `packages/contracts/src/health.ts` (the sync test exists). `subsystemsStatus`: `not_configured`
   with `missing: ["FDRIVE_IMAGE_EMBED_URL"]`. Reachability in `composition.ts`'s `probeSubsystems`:
   `health()` non-null and `status === "ok"` (a still-`loading` sidecar is `unreachable` for now, say
   so in a comment). Startup summary line comes for free.
9. **System routes** (admin only, `apps/api/src/system/routes.ts`, `ROUTES.system.*`):
   - `GET /api/v1/system/image-search` -> `SystemImageSearchResponse = { configured, healthy,
     model?: string, dim?: number, embedded: number, embeddedModel: string | null,
     rebuild?: IndexerThumbnailRebuildJob, clear?: IndexerClearJob }`. `embedded`/`embeddedModel`
     from `indexQueries.imageEmbeddingStats()`; jobs from the indexer stats.
   - `POST /api/v1/system/image-search/rebuild` body `{ force?: boolean }` -> proxies the indexer's
     `POST /image-embeddings/rebuild` (202 `{started, total}`, 409 when running) exactly like
     `thumbnailsRebuild`, response `IndexerThumbnailsRebuildResponse`.
   - `POST /api/v1/system/image-search/clear` -> indexer `POST /image-embeddings/clear`, like
     `thumbnailsClear`.
   - `IndexerClient` gains `imageEmbeddingsRebuild({force?})`, `clearImageEmbeddings()`, and
     `IndexerStatsRaw` gains `image_embeddings: int` (default 0 if absent), optional
     `image_embedding_rebuild`, `image_embedding_clear`; map to `imageEmbeddings`,
     `imageEmbeddingRebuild`, `imageEmbeddingClear` on `IndexerStats` and through
     `SystemIndexerResponse`'s stats contract (optional fields, additive).
   - `ApiClient`: `systemImageSearch()`, `systemImageSearchRebuild(opts?)`, `systemImageSearchClear()`.
10. **MCP.** No image tool this chunk.
11. **Deploy.** Run `pnpm env:example` to regenerate the generated blocks; the compose `api`
    environment passes `FDRIVE_IMAGE_EMBED_URL: ${FDRIVE_IMAGE_EMBED_URL:-}` through the generated
    block only. Do not hand-edit env files; if the generator needs a fixed compose value for the
    `index` profile, add `FDRIVE_IMAGE_EMBED_URL: http://image-embed:8012` to the fixed block in
    `deploy/compose.yaml` **and** to the generator's fixed-key list so its diff test passes. Also
    add the `image-embed` service to `deploy/compose.yaml` under the `index` profile mirroring
    `deploy/compose.dev.yaml` (published port not needed in prod; `/models` named volume, 6g).
12. Never call `list` on an unknown path; only the authorizer touches storage.

## Tests

Vitest for: contract schemas (`search.test.ts`, `system.test.ts`, `health.test.ts`, `client.test.ts`,
`routes.test.ts`), `image-embed-client` parse + fetch paths (fake fetch: ok, non-2xx, timeout, bad
shape, loading health), `selectImageHits` (positive best, non-positive best, empty, ratio edge),
the image search service (fake `IndexQueries` incl. `searchImages`/`imageEmbeddingStats`, fake
authorizer: allowed/denied/unavailable, trash exclusion, out-of-scope root, fanout `partial`,
not configured, sidecar down, dim mismatch, stale model id passed through), routes (400 empty q,
limit clamp, `unavailable` when no scope), system routes (get/rebuild 202/409/clear, non-admin 403),
config-keys sync tests, `probeSubsystems` reachability. Keep `apps/api` and `packages/contracts`
coverage gates green (functions 99, lines 99, branches 95).

## Commands before the report

In the worktree: `pnpm biome check --write .`, `pnpm typecheck`, `pnpm --filter @fdrive/contracts
test:coverage`, `pnpm --filter @fdrive/api test:coverage`, `pnpm test:deploy:coverage`, `pnpm env:example` then `git status --short` to show generated files.
