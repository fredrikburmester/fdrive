"""Internal HTTP API: `/health` and the two embed endpoints. Built on
Starlette, matching the indexer's and OCR service's `server.py`. Not
authenticated: reachable only from other containers on the compose network.

Holds the loaded `Embedder` behind a `ModelHolder` so `/health` can answer
immediately while a background thread in `main.py` loads the model, and so
`/embed/image` and `/embed/text` can report 503 until it is ready.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from anyio import CapacityLimiter, to_thread
from starlette.applications import Starlette
from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response
from starlette.routing import Route

from .embedder import Embedder, ImageDecodeError
from .normalize import l2_normalize
from .shapes import shape_embed_response, shape_health
from .validation import RequestError, parse_text_inputs, validate_images, validate_texts

MODEL_NOT_LOADED_MESSAGE = "model is not loaded yet"


class ModelHolder:
    """Thread-safe slot for the `Embedder` once the background loader thread
    finishes. `None` means "still loading"."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._embedder: Embedder | None = None

    def get(self) -> Embedder | None:
        with self._lock:
            return self._embedder

    def set(self, embedder: Embedder) -> None:
        with self._lock:
            self._embedder = embedder


@dataclass
class ServerState:
    model_id: str
    device: str
    holder: ModelHolder
    inference_limiter: CapacityLimiter = field(default_factory=lambda: CapacityLimiter(1))


async def health(request: Request) -> JSONResponse:
    """Never 503: the `status` field carries "loading" vs "ok" instead."""
    state: ServerState = request.app.state.server_state
    embedder = state.holder.get()
    if embedder is None:
        return JSONResponse(shape_health(False, state.model_id, None, state.device))
    return JSONResponse(shape_health(True, embedder.model_id, embedder.dim, state.device))


async def embed_image(request: Request) -> Response:
    state: ServerState = request.app.state.server_state
    embedder = state.holder.get()
    if embedder is None:
        return PlainTextResponse(MODEL_NOT_LOADED_MESSAGE, status_code=503)

    form = await request.form()
    images: list[bytes] = []
    for value in form.getlist("images"):
        if not isinstance(value, UploadFile):
            return JSONResponse({"error": "'images' parts must be file uploads"}, status_code=400)
        images.append(await value.read())

    try:
        validate_images(images)
        raw_vectors = await to_thread.run_sync(embedder.embed_images, images, limiter=state.inference_limiter)
        vectors = l2_normalize(raw_vectors)
    except RequestError as e:
        return JSONResponse({"error": e.message}, status_code=e.status_code)
    except ImageDecodeError as e:
        return JSONResponse({"error": f"undecodable image: {e}"}, status_code=400)

    return JSONResponse(shape_embed_response(embedder.model_id, embedder.dim, vectors))


async def embed_text(request: Request) -> Response:
    state: ServerState = request.app.state.server_state
    embedder = state.holder.get()
    if embedder is None:
        return PlainTextResponse(MODEL_NOT_LOADED_MESSAGE, status_code=503)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "request body must be JSON"}, status_code=400)

    try:
        texts = parse_text_inputs(body)
        validate_texts(texts)
        raw_vectors = await to_thread.run_sync(embedder.embed_texts, texts, limiter=state.inference_limiter)
        vectors = l2_normalize(raw_vectors)
    except RequestError as e:
        return JSONResponse({"error": e.message}, status_code=e.status_code)

    return JSONResponse(shape_embed_response(embedder.model_id, embedder.dim, vectors))


def create_app(state: ServerState) -> Starlette:
    app = Starlette(
        routes=[
            Route("/health", health, methods=["GET"]),
            Route("/embed/image", embed_image, methods=["POST"]),
            Route("/embed/text", embed_text, methods=["POST"]),
        ]
    )
    app.state.server_state = state
    return app
