# Pinned by digest (digest recorded below) so a rebuild never
# silently picks up a new base image without a deliberate bump here.
FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-swe \
      ffmpeg \
      libglib2.0-0 \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e ".[dev]"

# Runs as a non-root user. The indexer only needs read access to the
# bind-mounted files folder and read-write access to its thumbnail and log
# volumes. deploy/compose.yaml starts the container as root with
# FDRIVE_RUN_AS_UID set, and docker-entrypoint.sh gives those volumes to that
# uid and drops to it before the indexer starts; any other start runs as the
# user below from the first instruction. `scripts/test-in-docker.sh` mounts the host's
# Docker socket for testcontainers; on a host where that socket is not
# world-writable, run that script with `docker run --user root` to keep
# using it, since this uid otherwise cannot reach the socket.
# The indexer must read every file in the files folder, including folders kept at
# mode 700, so it runs as the uid/gid that owns them: FDRIVE_RUN_AS_UID in
# deploy/compose.yaml, the same uid the API and OCR write as (1000 by default).
ARG INDEXER_UID=1000
ARG INDEXER_GID=1000
RUN addgroup --gid "${INDEXER_GID}" indexer && \
    adduser --uid "${INDEXER_UID}" --gid "${INDEXER_GID}" --no-create-home --disabled-password --gecos "" indexer && \
    chown -R indexer:indexer /app

ENV PYTHONUNBUFFERED=1

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fs http://localhost:8010/health || exit 1

COPY docker-entrypoint.sh /usr/local/bin/fdrive-entrypoint

USER indexer

ENTRYPOINT ["fdrive-entrypoint"]
CMD ["python", "-m", "fdrive_indexer.main"]
