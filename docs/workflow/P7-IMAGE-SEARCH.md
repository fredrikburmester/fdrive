# Investigation: searching images by content ("blue chair")

Asked 2026-09-07: can fdrive search images by what is in them, with an image model?

Short answer: yes, and cheaply, because most of the machinery already exists. The indexer already
generates a WebP thumbnail per image, Postgres already has pgvector with an HNSW cosine index, and
both the indexer and the API already talk to an embedding server over HTTP. Image search is one
more embedding table, one more sidecar, and one more search mode — not a new subsystem.

## What is already in place

- `idx.chunks.embedding vector(384)` with `chunks_embedding_hnsw_idx` (`vector_cosine_ops`),
  filled by the indexer from Tika-extracted text through the `embed` sidecar
  (`ghcr.io/huggingface/text-embeddings-inference`, `intfloat/multilingual-e5-small`,
  `passage:`/`query:` prefixes).
- The API embeds the query with the same model (`apps/api/src/search/embeddings.ts`) and blends
  vector hits with the `tsvector` index in `apps/api/src/search/service.ts`, then restricts every
  hit to the caller's *verified* index scopes and proves each one with a live read.
- The indexer already writes `256` and `1024` px WebP thumbnails keyed by `sha256`
  (`THUMBS_DIR`, `idx.thumbnails`), and the search panel already renders them.
- The `index` compose profile is the established home for optional AI sidecars (indexer, tika,
  embed, ocr), each with a `configured` / `unreachable` health subsystem and documented env keys
  in `apps/api/src/config-keys.ts`.

## Recommended approach — CLIP-style joint embeddings over the existing thumbnails

A CLIP/SigLIP model maps images and text into one vector space, so "blue chair" typed as text lands
near photos of blue chairs. This is exactly the requested capability and it is the cheapest path,
because the image to embed is the **thumbnail that already exists on disk** — no re-reading
originals over SFTP, no decoding full-resolution RAWs.

1. **Sidecar** `services/image-embed`, in the `index` profile, shaped like `services/ocr`
   (FastAPI, ruff/mypy strict, pytest ≥95 %). Two endpoints: `POST /embed/image` (bytes in,
   vector out, batched) and `POST /embed/text` (query string in, vector out), plus `/health`.
   Config: `IMAGE_EMBED_URL` for the indexer, `FDRIVE_IMAGE_EMBED_URL` for the API, both optional;
   absent means the feature is simply off, exactly like OCR today.
   *Why not reuse the existing TEI `embed` container:* TEI serves text-only e5; CLIP image towers
   are not part of that deployment, and the current image is already an emulated amd64 build on
   this arm64 Mac (`compose.dev.yaml` calls it "the first casualty of memory pressure"). A small
   dedicated service keeps the flaky part isolated.
2. **Model.** Start with `google/siglip-base-patch16-224` (768-dim) or `openai/clip-vit-base-patch32`
   (512-dim). Both run on CPU at roughly 30–100 ms per 256 px thumbnail. If multilingual queries
   matter as much as they did for e5, `jinaai/jina-clip-v2` (1024-dim, multilingual) is the
   heavier but better option. Pin the model id in config; the vector dimension is part of the
   schema, so changing models means a migration plus a rebuild pass.
3. **Schema.** `idx.image_embeddings(file_id bigint pk references idx.files on delete cascade,
   model text not null, embedding vector(768) not null, created_at timestamptz)` with an HNSW
   cosine index. Keyed by `file_id` rather than `sha256` so it drops with the file row, and
   carrying `model` so a model change is detectable rather than silently mixing spaces.
4. **Indexer pass.** After a thumbnail is written, POST it to the sidecar and store the vector.
   Reuse the existing `thumbnail_rebuild` job shape for a backfill/rebuild pass, and surface it on
   the System → Thumbnails (or a new System → Image search) page with the same
   configured/unreachable badge language the config-loudness work established.
5. **Query.** A new search mode: embed the query text through the sidecar's text tower, ANN search
   `image_embeddings`, then apply the *same* scope filter and live read check the text search
   already applies — image vectors must never widen what a caller can see. Blend with the existing
   results or expose it behind the existing type filter as "Images"; do not silently mix two
   similarity scales into one ranking.

**Cost.** 10 000 images ≈ 10–20 minutes of one-off CPU indexing and ~30 MB of vectors; incremental
after that. Query cost is one text embedding (~20 ms) plus an HNSW lookup. HNSW stays comfortable
well past a million images.

**Calibration.** CLIP cosine scores are not absolute — 0.28 can be a great match and 0.31 a poor
one, depending on the query. Rank and cut by top-k with a relative margin, never by a fixed
threshold, and always show thumbnails so a wrong hit is obvious at a glance.

## Alternative — caption the images and reuse the text index

Run a small vision-language model (Florence-2, Qwen2-VL, moondream) over each thumbnail, write the
caption as a chunk in `idx.chunks`, and get search for free: BM25 keyword matching, the existing e5
vectors, snippets, and an explainable result ("matched: *a blue armchair by a window*").

- Pros: no new query path, no new table, multilingual through the existing e5 model, and the user
  can see *why* something matched.
- Cons: 1–3 s per image on CPU (a GPU or an overnight pass for a large library), captions miss
  detail the model did not think worth mentioning, and it hallucinates occasionally.

These are complementary, not exclusive. The honest recommendation is CLIP first (it directly
answers "blue chair" and is cheap), captions later if explainability or keyword recall matters.

## Things to decide before building

- Which model and therefore which vector dimension, since it is baked into the schema.
- Whether image search is a separate mode or blended into the default results.
- Whether the sidecar is optional (like OCR) — it should be; a deployment without the `index`
  profile must degrade to "not configured", never to an error.
- Explicitly out of scope unless asked: face recognition or person clustering. That is a different
  privacy conversation from "find my photos of a blue chair".

## Rough shape of the work

Four chunks, in order: `image-embed-service` (the sidecar), `image-embed-db` (migration, repo,
indexer pass, rebuild job), `image-search-api` (contract, query path, scoping, health subsystem,
config keys), `image-search-web` (search UI mode, System page). None of them blocks the current
UX pass.
