"""Pure request validation and bounds checking for both embed endpoints. No
I/O, no model: takes already-decoded request pieces (a list of image byte
strings, or a JSON-decoded text request body) and raises `RequestError` for
`server.py` to translate into an HTTP response.

Bounds are fixed by the HTTP contract in
`docs/workflow/P7-IMAGE-SEARCH-BUILD.md`: at most 32 images or 64 texts per
request, an image part at most 8 MiB, a text at most 512 characters. All
bound violations are 413; a missing or malformed request body is 400.
"""

from __future__ import annotations

MAX_IMAGES = 32
MAX_TEXTS = 64
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TEXT_CHARS = 512


class RequestError(Exception):
    """Carries the HTTP status code `server.py` should respond with."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def validate_images(images: list[bytes]) -> None:
    if not images:
        raise RequestError(400, "at least one image is required")
    if len(images) > MAX_IMAGES:
        raise RequestError(413, f"at most {MAX_IMAGES} images per request")
    for image in images:
        if len(image) > MAX_IMAGE_BYTES:
            raise RequestError(413, f"an image part exceeds {MAX_IMAGE_BYTES} bytes")


def parse_text_inputs(body: object) -> list[str]:
    """Extracts and shape-checks the `inputs` field of a JSON-decoded body:
    `{"inputs": ["blue chair", ...]}`."""
    if not isinstance(body, dict):
        raise RequestError(400, "request body must be a JSON object")
    inputs = body.get("inputs")
    if not isinstance(inputs, list) or not all(isinstance(item, str) for item in inputs):
        raise RequestError(400, "'inputs' must be a list of strings")
    return inputs


def validate_texts(texts: list[str]) -> None:
    if not texts:
        raise RequestError(400, "at least one text is required")
    if len(texts) > MAX_TEXTS:
        raise RequestError(413, f"at most {MAX_TEXTS} texts per request")
    for text in texts:
        if len(text) > MAX_TEXT_CHARS:
            raise RequestError(413, f"a text exceeds {MAX_TEXT_CHARS} characters")
