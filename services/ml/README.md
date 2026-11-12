# fdrive-ml

One Rust server for fdrive's model inference and document text extraction. It replaces three
services and their runtime controllers, and keeps each one's HTTP contract under its own path
prefix, so a caller only changes its base URL.

| Unit | Prefix | Replaces | Owner-facing features that turn it on |
| --- | --- | --- | --- |
| Text embeddings | `/text` | text-embeddings-inference (`embed`) | `semanticSearch` |
| Image embeddings | `/image` | `services/image-embed` | `imageSearch` |
| Document extraction | `/extract` | Apache Tika (`tika`) | `textSearch`, `searchOcr`, `semanticSearch` |

The server has no database access and no file mounts. It sees only the bytes a request hands it
and writes nothing but downloaded model files, so a hostile document or image it parses cannot
reach anyone's storage.

## HTTP contract

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Process liveness: `{"status":"ok"}` whatever the units are doing. |
| `GET /runtime` | Every unit's status in one object, keyed by unit name. |
| `GET /<unit>/runtime` | The status document the API polls: `status` (`off`, `preparing`, `ready`, `failed`), `revision`, `features`, `attempts`, `child`, `error`. |
| `POST /text/embed` | TEI's `/embed`: `{ inputs, truncate?, normalize? }` to a JSON array of 384-value vectors. At most 32 inputs. |
| `GET /text/health`, `GET /text/info` | 200 once the model is loaded; `info` carries `model_id` and `max_input_length`. |
| `POST /image/embed/image` | Multipart `images` file parts (at most 32, 8 MiB each) to `{ model, dim, embeddings }`, unit length. |
| `POST /image/embed/text` | `{ inputs }` (at most 64 texts of 512 characters) to the same shape. |
| `GET /image/health` | `{ status: "ok" \| "loading", model, dim, device }`; 503 while the unit is off. |
| `PUT /extract/tika` | Raw document bytes to `text/plain`. 422 for a document it cannot read, which the indexer records as unsupported. |
| `GET /extract/version` | 200 while extraction is on. |

A unit that is off, loading or failed answers its work endpoints with 503.

## Feature gating

The server polls the API's `GET /api/v1/internal/features` with `FDRIVE_WORKER_TOKEN` and keeps a
unit loaded only while a current document enables one of its features. Disabling a feature drops
the model and frees its memory. The rules are fail-closed: a rejected document stops every unit
after `FDRIVE_RUNTIME_STALE_SECONDS`, an unreachable endpoint after the longer
`FDRIVE_RUNTIME_UNREACHABLE_SECONDS`. A model that fails to load is retried three times, then
every five minutes, and immediately when the owner saves settings.

## Models

Models are downloaded on first use into `FDRIVE_ML_MODELS_DIR` and run on ONNX Runtime (CPU).
Each file is pinned to a repository revision and a SHA-256 in [`src/hub.rs`](src/hub.rs); a file
that does not match is refused. To run without internet access, place the files in the same
layout (`<models dir>/<owner>--<repo>/<revision>/<path>`).

| Unit | Model | Download |
| --- | --- | --- |
| Text | `intfloat/multilingual-e5-small` | about 490 MB |
| Image | `google/siglip2-large-patch16-256`, ONNX export from `onnx-community`: 8-bit vision tower, full-precision text tower | about 2.6 GB |

An existing index needs no re-embedding:

- The text unit produces the vectors TEI produced.
- The image unit's text tower is the one the Python service ran. Queries are lowercased first,
  which that service did not do and the model expects.
- The image unit's vision tower is the 8-bit quantized file. It embeds an image about 2.5 times
  faster than the full-precision tower for one to two points of first-hit rate. Its vectors are
  not the Python service's, but they rank correctly in an index that also holds those, so the
  reported model id is unchanged. Images are resized with a byte-exact port of Pillow's bilinear
  filter and embedded one at a time, so quantization is the only difference from a stored
  vector and a vector never depends on the rest of a request.

Quantized arithmetic is not bit-identical across CPU families: the same image embedded on ARM
and on x86 gave vectors with a cosine of 0.98. Measurements are in the
[plan](../../docs/plans/ML-SERVER.md).

## Document formats

Extraction lives in the [`extract`](extract) crate: a pure, synchronous function from bytes to
text with bounds on decompressed size and output length. Its README-level facts (formats read,
formats refused) are in [`extract/src/lib.rs`](extract/src/lib.rs).

## Config (env, all optional)

| Variable | Default | Meaning |
| --- | --- | --- |
| `FDRIVE_ML_PORT` | `8080` | Port the HTTP API binds to. |
| `FDRIVE_ML_MODELS_DIR` | `/models` | Where model files are kept (mount a volume here). |
| `FDRIVE_ML_THREADS` | `4` | CPU threads shared by every model together, and the number of documents parsed at once. |
| `FDRIVE_ML_MAX_DOCUMENT_MB` | `64` | Largest document `PUT /extract/tika` accepts. Keep it at or above the indexer's `TEXT_MAX_MB`. |
| `HF_ENDPOINT` | `https://huggingface.co` | Hub or mirror the model files come from. |
| `FDRIVE_WORKER_TOKEN` | unset | Credential for the feature document. Without it every unit fails closed. |
| `FDRIVE_FEATURES_URL` | `http://api:3001/api/v1/internal/features` | Where the feature document is read. |
| `FDRIVE_RUNTIME_POLL_SECONDS` | `3` | How often the feature document is polled. |
| `FDRIVE_RUNTIME_STALE_SECONDS` | `9` | How long a rejected document is tolerated. |
| `FDRIVE_RUNTIME_UNREACHABLE_SECONDS` | `60` | How long an unreachable endpoint is tolerated. |
| `FDRIVE_ML_STATIC_UNITS` | unset | Development only: a comma list of `text`, `image`, `extract` that stay on with no feature document. |

## Development

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo llvm-cov --workspace --locked --fail-under-lines 95 --ignore-filename-regex '(src/onnx/|src/main\.rs)'
```

The unit tests never load model weights: the models sit behind the `TextEmbedder` and
`ImageEmbedder` traits, with fakes standing in for them. `src/onnx/` and `src/main.rs` are the
only code they do not reach. After changing a model pin, ONNX Runtime or a tokenizer, run the
real-model probes, which download the models:

```sh
cargo test --release --test models -- --ignored
```

Run it locally with every unit on:

```sh
FDRIVE_ML_STATIC_UNITS=text,image,extract FDRIVE_ML_MODELS_DIR=target/models cargo run --release
```
