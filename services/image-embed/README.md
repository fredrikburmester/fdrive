# fdrive-image-embed

A small FastAPI-shaped (Starlette) sidecar that turns images and text into
SigLIP 2 embeddings for image search. See
[`docs/workflow/P7-IMAGE-SEARCH.md`](../../docs/workflow/P7-IMAGE-SEARCH.md)
and
[`docs/workflow/P7-IMAGE-SEARCH-BUILD.md`](../../docs/workflow/P7-IMAGE-SEARCH-BUILD.md)
for why it exists, its fixed HTTP contract, and how the indexer and API use
it. Modelled on `services/ocr` for structure, packaging, and test
configuration; this service is its sibling, not a new pattern.

## Quick local setup (tests only, no model)

The test venv never installs torch, transformers, or pillow (the `runtime`
extra) and never imports them: the model lives behind a small `Embedder`
protocol, with a fake standing in for it in every test.

```sh
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/ruff check .
.venv/bin/mypy src
.venv/bin/pytest -q --cov=fdrive_image_embed --cov-report=term-missing --cov-fail-under=95
```

## Running it for real

Installing the `runtime` extra pulls in CPU-only torch wheels the same way
the `Dockerfile` does:

```sh
.venv/bin/pip install --extra-index-url https://download.pytorch.org/whl/cpu -e ".[runtime]"
.venv/bin/python -m fdrive_image_embed.main
```

The model downloads (and is cached under `HF_HOME`, default `/models`) the
first time it loads. `GET /health` answers immediately with
`{"status": "loading", ...}` and flips to `{"status": "ok", ...}` once the
weights are resident; embed requests before that return 503.

## Config (env, all optional)

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMAGE_EMBED_MODEL` | `google/siglip2-large-patch16-256` | Hugging Face model id. |
| `IMAGE_EMBED_PORT` | `8012` | Port the internal HTTP API binds to. |
| `IMAGE_EMBED_BATCH_SIZE` | `8` | How many images or texts go through the model per inference call. |
| `IMAGE_EMBED_DEVICE` | `auto` | `cpu`, `cuda`, or `auto` (probes `torch.cuda.is_available()`). |
| `IMAGE_EMBED_THREADS` | unset | `torch.set_num_threads`; unset leaves torch's own default. |
| `HF_HOME` | `/models` | Hugging Face cache directory (mount a volume here). |

## HTTP API

Bound to `0.0.0.0:${IMAGE_EMBED_PORT}`. Not authenticated: reachable only
from other containers on the compose network.

| Endpoint | Method | Body | Returns |
| --- | --- | --- | --- |
| `/health` | GET | - | `{"status": "ok" \| "loading", "model": "<hf id>", "dim": <int\|null>, "device": "cpu" \| "cuda"}`. Never 503. |
| `/embed/image` | POST | `multipart/form-data`, one or more parts named `images` | `{"model": "<hf id>", "dim": 1024, "embeddings": [[float, ...], ...]}` in request order, each vector L2-normalized. |
| `/embed/text` | POST | JSON `{"inputs": ["blue chair", ...]}` | Same response shape as `/embed/image`. |

Bounds, all rejected with 413: more than 32 images or 64 texts per request,
an image part over 8 MiB, a text over 512 characters. A missing or
malformed request body is 400; so is an undecodable image. Any embed request
before the model has loaded is 503 with a plain-text body.

## Testing

Every pure module (`config.py`, `device.py`, `validation.py`, `batching.py`,
`normalize.py`, `shapes.py`) is covered at 100%. `server.py` and `main.py`
are exercised through Starlette's `TestClient` and direct calls against
`tests/conftest.py`'s `FakeEmbedder`, which never touches torch. The real
model backend (`siglip.py`) is excluded from coverage (`# pragma: no cover`):
exercising it for real means loading actual weights, which this suite
deliberately never does. A real model load and the Docker image build are
verified separately, outside this package's gates.
