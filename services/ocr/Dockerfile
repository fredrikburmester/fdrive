# Base image ships ocrmypdf itself in an isolated venv at /app/.venv (built with
# uv, no pip inside it) and runs as a non-root "app" user (uid 1000, the same uid
# the dev stack's SFTPGo runs as, so bind-mounted roots stay writable). We add
# Swedish and English tesseract data, then install this package into its own
# venv rather than trying to inject pip into the base image's venv.
FROM jbarlow83/ocrmypdf:latest

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr-swe tesseract-ocr-eng \
      python3-venv \
      curl \
    && rm -rf /var/lib/apt/lists/*

RUN /usr/bin/python3 -m venv /opt/ocr-venv

WORKDIR /app-src

COPY pyproject.toml ./
COPY src ./src
RUN /opt/ocr-venv/bin/pip install --no-cache-dir -e ".[dev]"

# Owned by "app" (not root) so the non-root runtime user can write
# `.pytest_cache` / `.coverage` here when `scripts/test-in-docker.sh` runs the
# suite inside this image.
RUN chown -R app:app /app-src

ENV PATH="/opt/ocr-venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1

EXPOSE 8011

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fs http://localhost:8011/health || exit 1

USER app

ENTRYPOINT []
CMD ["python3", "-m", "fdrive_ocr.main"]
