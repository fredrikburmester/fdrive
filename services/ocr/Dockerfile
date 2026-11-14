# Base image ships ocrmypdf itself in an isolated venv at /app/.venv (built with
# uv, no pip inside it) and runs as a non-root "app" user (uid 1000, the default
# owner of the files folder, so bind-mounted roots stay writable). We add
# Swedish and English tesseract data and poppler's `pdftotext`, which finds the
# PDFs that already have text without starting ocrmypdf, then install this
# package into its own venv rather than trying to inject pip into the base
# image's venv.
#
# Pinned to ocrmypdf 17.11.0 by tag and digest below, so a rebuild never silently
# picks up a new ocrmypdf release or base image without a deliberate bump here.
FROM jbarlow83/ocrmypdf:v17.11.0@sha256:c6bcc39ae87cccdbf243d62dba39032a3aacd8a1463365170db3604139aba977

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr-swe tesseract-ocr-eng \
      poppler-utils \
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

COPY docker-entrypoint.sh /usr/local/bin/fdrive-entrypoint

# deploy/compose.yaml starts the container as root with FDRIVE_RUN_AS_UID
# set, and the entrypoint gives the state directory to that uid and drops to
# it before the worker starts. Any other start runs as this user throughout.
USER app

# Replaces the base image's `ocrmypdf` entrypoint.
ENTRYPOINT ["fdrive-entrypoint"]
CMD ["python3", "-m", "fdrive_ocr.main"]
