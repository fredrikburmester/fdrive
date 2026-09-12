# fdrive-image-embed

A small FastAPI-shaped (Starlette) sidecar that turns images and text into
SigLIP 2 embeddings for image search. The HTTP contract below is implemented by this
service; [search](../../docs/SEARCH-AND-AI.md) describes how it fits into the application.

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

## Runtime compatibility

The runtime extra pins the tested Torch, Transformers, Pillow, Tokenizers and
Safetensors versions. On 2026-09-12 the cached default model passed real CPU image
and text inference on this set, producing 1024 finite nonzero values per vector.
Dependency updates must repeat both inference probes; unit tests use a fake model.

Transformers 5.16.1 can warn that BOS/EOS IDs 49406/49407 exceed a 32,000-token
vocabulary while constructing its default configuration. The loaded default
model actually has 256,000 tokens, so both IDs are in range. This reproduces the
[upstream configuration warning](https://github.com/huggingface/transformers/issues/47612).
Do not rewrite tokenizer IDs or suppress warnings globally to hide it. A warning
from a different model or dependency version needs its own configuration check.

## HTTP API

Bound to `0.0.0.0:${IMAGE_EMBED_PORT}`. Not authenticated: reachable only
from other containers on the compose network.

| Endpoint | Method | Body | Returns |
| --- | --- | --- | --- |
| `/health` | GET | - | `{"status": "ok" \| "loading", "model": "<hf id>", "dim": <int\|null>, "device": "cpu" \| "cuda"}`. Never 503. |
| `/embed/image` | POST | `multipart/form-data`, one or more parts named `images` | `{"model": "<hf id>", "dim": 1024, "embeddings": [[float, ...], ...]}` in request order, each vector L2-normalized. |
| `/embed/text` | POST | JSON `{"inputs": ["blue chair", ...]}` | Same response shape as `/embed/image`. |

Bounds, all rejected with 413: more than 32 images or 64 texts per request,
an image part over 8 MiB, a text over 512 characters. A missing or malformed
request body is 400; so is an undecodable image or one over 16,777,216 decoded
pixels. The pixel bound is checked from the image header before RGB conversion.
Any embed request before the model has loaded is 503 with a plain-text body.

## Testing

Every pure module (`config.py`, `device.py`, `validation.py`, `image_decode.py`,
`batching.py`, `normalize.py`, `shapes.py`) is covered at 100%. `server.py` and `main.py`
are exercised through Starlette's `TestClient` and direct calls against
`tests/conftest.py`'s `FakeEmbedder`, which never touches torch. The real
model backend (`siglip.py`) is excluded from coverage (`# pragma: no cover`):
exercising it for real means loading actual weights, which this suite
deliberately never does. A real model load and the Docker image build are
verified separately, outside this package's gates.
