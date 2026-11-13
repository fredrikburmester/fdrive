# Build context is this directory:
#   docker build -t fdrive-indexer services/indexer
#
# Both bases are pinned by digest, the same ones services/ml uses, so a rebuild never
# silently picks up a new base image.
FROM rust:1.99.0-trixie@sha256:81015672d6939b0265f09adf96d5de125482bb1330106076956b0518e74edc90 AS build

# MuPDF is compiled from source and linked statically; libheif and dav1d are linked from
# Debian.
RUN apt-get update && apt-get install -y --no-install-recommends \
      cmake clang libclang-dev pkg-config libheif-dev libdav1d-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# rust-toolchain.toml stays out: the base image is the pinned toolchain.
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked --bin fdrive-indexer

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS runtime

# tesseract reads text from images and scanned PDF pages, ffmpeg takes video frames;
# both run as separate programs. The libheif plugins decode HEIC (libde265) and AVIF
# (dav1d). curl: the health check below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-swe ffmpeg \
      libheif1 libheif-plugin-libde265 libheif-plugin-dav1d libdav1d7 \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The indexer must read every file in the files folder, including folders kept at mode
# 700, so it runs as the uid/gid that owns them: FDRIVE_RUN_AS_UID in deploy/compose.yaml,
# the same uid the API and OCR write as (1000 by default). The container starts as root;
# docker-entrypoint.sh hands the thumbnail and log volumes to that uid and drops to it
# before the indexer starts.
ARG INDEXER_UID=1000
ARG INDEXER_GID=1000
RUN groupadd --gid "${INDEXER_GID}" indexer \
    && useradd --uid "${INDEXER_UID}" --gid "${INDEXER_GID}" --no-create-home indexer

COPY --from=build /src/target/release/fdrive-indexer /usr/local/bin/fdrive-indexer
COPY docker-entrypoint.sh /usr/local/bin/fdrive-entrypoint

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fs http://localhost:8010/health || exit 1

USER indexer

ENTRYPOINT ["fdrive-entrypoint"]
CMD ["fdrive-indexer"]
