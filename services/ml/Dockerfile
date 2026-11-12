# Build context is this directory:
#   docker build -t fdrive-ml services/ml
#
# Both bases are pinned by digest so a rebuild never silently picks up a new
# base image without a deliberate bump here. Debian 13, not 12: the prebuilt
# ONNX Runtime this links statically needs its newer glibc and libstdc++.
FROM rust:1.99.0-trixie@sha256:81015672d6939b0265f09adf96d5de125482bb1330106076956b0518e74edc90 AS build

# aws-lc (TLS for model downloads) builds its C sources with CMake.
RUN apt-get update && apt-get install -y --no-install-recommends cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# rust-toolchain.toml stays out: the base image is the pinned toolchain.
COPY Cargo.toml Cargo.lock build.rs ./
COPY extract ./extract
COPY src ./src
RUN cargo build --release --locked --bin fdrive-ml

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS runtime

# ca-certificates: model downloads verify the hub's certificate against the
# system store. curl: the health check below.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Needs no access to user files or the database: it only ever sees the bytes
# a request hands it, and writes nothing but downloaded model files.
RUN groupadd --system fdrive && useradd --system --gid fdrive --no-create-home fdrive \
    && mkdir -p /models && chown fdrive:fdrive /models

COPY --from=build /src/target/release/fdrive-ml /usr/local/bin/fdrive-ml

# The release it was built as (0.7.0 or main), which `/extract/version` and the
# first log line report; empty for any other build, which reports `dev`.
ARG FDRIVE_BUILD_VERSION=
ENV FDRIVE_BUILD_VERSION=$FDRIVE_BUILD_VERSION

USER fdrive
ENV FDRIVE_ML_MODELS_DIR=/models
EXPOSE 8080

# The process answers as soon as it is up; whether a model is loaded is each
# unit's own `/runtime`, which the API reads.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fs http://127.0.0.1:8080/health || exit 1

CMD ["fdrive-ml"]
