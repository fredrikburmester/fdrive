# P7 image search — build spec (requested 2026-09-07)

Implements `docs/workflow/P7-IMAGE-SEARCH.md`'s recommended approach. The user chose the model:
**`google/siglip2-large-patch16-256`** — 1024-dimensional, multilingual, quality over speed, and the
one-off CPU backfill cost is accepted (PLAN.md decision 16).

Four chunks. `image-embed-service` and `image-embed-db` are disjoint and run in parallel;
`image-search-api` needs both; `image-search-web` needs the API.

## Orchestrator decisions

1. **What gets embedded is the thumbnail, not the original.** The indexer already writes a 256 px
   WebP per image (`app.thumbnails`, `content_key` = the file's sha256). SigLIP 2 at
   patch16-256 takes 256x256 input, so the 256 px thumbnail is exactly the model's input size and
   costs one small local read. Originals are never re-fetched over SFTP for this.
2. **Vectors are keyed by content, not by file.** `app.image_embeddings.content_key` is the same
   sha256 `app.thumbnails` uses, so two copies of one photo are embedded once, and the table sits
   beside `app.thumbnails` under the same ownership (drizzle owns the migration, the Python indexer
   writes the rows) rather than in `idx`.
3. **The dimension is 1024** (`vision_config.hidden_size` and `text_config.hidden_size` of
   `google/siglip2-large-patch16-256`, both 1024). It is baked into the column type, so the sidecar
   reports its true dimension on `/health` and every writer refuses to write when it disagrees —
   loudly, in the style of the config-loudness pass, never silently truncating or padding.
4. **The sidecar normalizes.** Every returned vector is L2-normalized, so cosine distance in
   pgvector is a dot product and no caller ever has to remember to normalize.
5. **Optional, like OCR.** No `IMAGE_EMBED_URL` (indexer) or `FDRIVE_IMAGE_EMBED_URL` (API) means
   the feature reports `not_configured`; it never errors and never blocks indexing.
6. **A model change is data, not a silent reinterpretation.** Each row stores the `model` id. Rows
   written by a different model are ignored by search and replaced by the rebuild pass.

## Chunk `image-embed-service` — services/image-embed, deploy/compose.dev.yaml

Owned paths: `services/image-embed/**`, `deploy/compose.dev.yaml`, `docs/INDEXER.md`.

Model `services/ocr` for structure, packaging, lint and test configuration; this service is its
sibling, not a new pattern.

1. **HTTP contract** (fixed by the orchestrator; the other chunks are written against it):
   - `GET /health` -> `{"status": "ok" | "loading", "model": "<hf id>", "dim": <int|null>,
     "device": "cpu" | "cuda"}`. `dim` is `null` while `status` is `loading`. Never 503 — the
     status field carries the state, matching how the other sidecars report health.
   - `POST /embed/image`, `multipart/form-data`, one or more parts named `images`, binary image
     bytes. -> `{"model": "<hf id>", "dim": 1024, "embeddings": [[float, ...], ...]}` in request
     order, each vector L2-normalized.
   - `POST /embed/text`, JSON `{"inputs": ["blue chair", ...]}` -> the same response shape.
   - Bounds, all rejected with 413: more than 32 images or 64 texts per request, an image part over
     8 MiB, a text over 512 characters. Undecodable image bytes are 400. Any request before the
     model has loaded is 503 with a plain message.
2. **Config** (env, all optional with the defaults shown): `IMAGE_EMBED_MODEL`
   (`google/siglip2-large-patch16-256`), `IMAGE_EMBED_PORT` (`8012`), `IMAGE_EMBED_BATCH_SIZE`
   (`8`), `IMAGE_EMBED_DEVICE` (`auto`), `IMAGE_EMBED_THREADS` (unset = torch default),
   `HF_HOME` (`/models`).
3. **Loading.** Load the model on a background thread at startup so the process answers `/health`
   immediately with `loading`; flip to `ok` when the weights are resident. Run inference under
   `torch.inference_mode()`. CPU-only torch wheels in the Dockerfile — do not pull the CUDA build.
4. **Testability.** No test may download a model or import torch at collection time. Put the model
   behind a small `Embedder` protocol (`embed_images(list[bytes]) -> list[list[float]]`,
   `embed_texts(list[str]) -> list[list[float]]`, `dim`, `model_id`) with a fake in tests. The pure
   modules — config parsing, request validation and bounds, batching, L2 normalization, the health
   payload — must be at 100 % coverage; the package gate is `--cov-fail-under=95`, ruff clean and
   mypy strict, exactly as `services/ocr`.
5. **Dev compose.** Add an `image-embed` service to `deploy/compose.dev.yaml` under the existing
   `index` profile: build from `../services/image-embed`, publish
   `${FDRIVE_DEV_IMAGE_EMBED_PORT:-58012}:8012`, mount a named volume at `/models` for the weight
   cache, `mem_limit: 6g`, and a healthcheck hitting `/health`. Do not touch `deploy/compose.yaml`
   or `deploy/.env.example` — the API chunk owns those.
6. **Report the real dimension** the loaded model produces. If it is not 1024, say so prominently
   in the report: the database migration in the parallel chunk hard-codes 1024 and must be fixed
   before either merges.

## Chunk `image-embed-db` — packages/db, services/indexer

Owned paths: `packages/db/**`, `services/indexer/**`.

1. **Migration and schema.** New drizzle migration plus `packages/db/src/schema/app.ts` entry,
   modelled on `app.thumbnails`:

   ```sql
   CREATE TABLE "app"."image_embeddings" (
     "content_key" text PRIMARY KEY,
     "model" text NOT NULL,
     "embedding" vector(1024) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX "image_embeddings_hnsw_idx"
     ON "app"."image_embeddings" USING hnsw ("embedding" vector_cosine_ops);
   ```

2. **Query.** Add to `packages/db/src/repos/index-queries.ts`, beside the existing chunk vector
   search and using the same `formatVectorLiteral` and `scopeCondition` helpers:
   `searchImages(scopePrefixes, vector, model, limit)` -> ranked `{ rootId, path, size,
   modifiedAt, score }` joined `app.image_embeddings` to `idx.files` on
   `files.sha256 = image_embeddings.content_key`, filtered to `model = $model` and to the caller's
   scope prefixes, ordered by cosine distance. An empty scope list matches nothing, as everywhere
   else. Also `imageEmbeddingStats()` -> `{ total, model }` for the System page.
   The API chunk consumes both; do not add API routes here.
3. **Indexer pass.** In `services/indexer`, after a thumbnail is written for a file, and only when
   `IMAGE_EMBED_URL` is configured: POST the **256 px** thumbnail bytes to `/embed/image` (batched
   at `IMAGE_EMBED_BATCH_SIZE`) and upsert the vector under the file's sha256 and the sidecar's
   reported model id. Skip files that already have a row for the configured model. Follow
   `extract.py`'s `_embed`/`embed_health` shape for the HTTP client and
   `thumbs.py`/`thumb_rebuild.py` for where the work hangs off the scan.
4. **Dimension guard.** Before writing any batch, compare the sidecar's `/health` `dim` with the
   column width (a module constant, 1024). On a mismatch: log an error naming both numbers, skip
   embedding for the rest of the run, and never write. Same for a `status` other than `ok`.
5. **Rebuild and clear jobs.** Mirror the thumbnail passes: `POST /image-embeddings/rebuild`
   (optionally `{"force": true}` to re-embed rows written by another model) and
   `POST /image-embeddings/clear`, with progress in `GET /stats` as `image_embedding_rebuild` and
   `image_embedding_clear`, shaped like `thumbnail_rebuild` / `thumbnail_clear` so the existing
   API and web job plumbing can pick them up unchanged in the next chunk. Add the embedded count
   to the indexer's `/stats` alongside `thumbnails`.
6. **Tests.** pytest for every pure piece (batching, the dimension and model guards, request and
   response parsing, the rebuild pass's candidate selection) at 100 %, package gate
   `--cov-fail-under=95`, ruff and mypy strict. A `packages/db` integration test for the migration,
   the HNSW index and `searchImages`' scope filtering, in the existing container-backed style.
   No test may reach a real sidecar; inject a fake HTTP client.

## Chunk `image-search-api` — packages/contracts, apps/api, deploy (queued)

Contract for a `kind: "image"` search mode or an `images` section on the existing search response
(pick one and state why), the query-embedding call to the sidecar, the same verified-scope
restriction and live read check text search already applies, `FDRIVE_IMAGE_EMBED_URL` in
`config-keys.ts`, an `imageSearch` health subsystem, the rebuild/clear job routes, and the
regenerated `deploy/.env.example` and compose passthrough. Ranking rule: top-k with a relative
margin, never an absolute cosine threshold.

## Chunk `image-search-web` — apps/web (queued)

Search panel mode with thumbnail results, and a System page for the sidecar and its rebuild/clear
jobs, matching the Thumbnails page.
