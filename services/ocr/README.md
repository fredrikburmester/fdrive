# fdrive-ocr

See [`docs/OCR.md`](../../docs/OCR.md) at the repository root for what this
service does, its settings, its internal HTTP API, and how to test it.

Quick local setup:

```sh
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
```

Full suite inside the service's own Docker image (the only place the real
`ocrmypdf` and its Swedish/English tesseract data are installed):

```sh
scripts/test-in-docker.sh
```
