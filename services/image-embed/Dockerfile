# Plain python:3.12-slim base: unlike services/ocr this service has no
# non-Python system tool to inherit a base image from. Installs this
# package's `runtime` extra (torch, transformers, pillow) into its own venv,
# with torch pulled from PyTorch's CPU-only wheel index
# (`--extra-index-url`, not `--index-url`, so transformers/pillow still
# resolve from PyPI) so the image never pulls the much larger CUDA build.
#
# `HF_HOME` (default /models, see Config) is where transformers caches
# downloaded model weights; mount a named volume there in compose so a
# container restart does not re-download them.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 1000 --create-home app

WORKDIR /app-src

COPY pyproject.toml ./
COPY src ./src

RUN python3 -m venv /opt/image-embed-venv \
    && /opt/image-embed-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/image-embed-venv/bin/pip install --no-cache-dir \
         --extra-index-url https://download.pytorch.org/whl/cpu \
         -e ".[runtime]"

RUN mkdir -p /models \
    && chown -R app:app /app-src /models

ENV PATH="/opt/image-embed-venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models

EXPOSE 8012

# /health always returns 200 (status carries "loading" vs "ok"), so this
# passes as soon as the process is up, well before the model is resident.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fs http://localhost:8012/health || exit 1

USER app

ENTRYPOINT []
CMD ["python3", "-m", "fdrive_image_embed.main"]
