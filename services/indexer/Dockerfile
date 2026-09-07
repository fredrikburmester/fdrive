# Pinned by digest (see deploy/README.md's pins table) so a rebuild never
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

# Runs as a non-root user in production (see deploy/compose.yaml's `index`
# profile: the indexer only needs read access to the bind-mounted SFTPGo
# root and read-write access to the named `fdrive-thumbs` volume, which a
# one-shot `thumbs-init` service chowns to this uid before the indexer
# starts, the same pattern deploy/compose.dev.yaml's `sftpgo-seed` uses for
# SFTPGo's own data volume). `scripts/test-in-docker.sh` mounts the host's
# Docker socket for testcontainers; on a host where that socket is not
# world-writable, run that script with `docker run --user root` to keep
# using it, since this uid otherwise cannot reach the socket.
RUN addgroup --gid 1001 indexer && \
    adduser --uid 1001 --gid 1001 --no-create-home --disabled-password --gecos "" indexer && \
    chown -R indexer:indexer /app

ENV PYTHONUNBUFFERED=1

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fs http://localhost:8010/health || exit 1

USER indexer

CMD ["python", "-m", "fdrive_indexer.main"]
