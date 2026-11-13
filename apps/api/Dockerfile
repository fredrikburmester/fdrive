# syntax=docker/dockerfile:1
#
# Build context is the repository root:
#   docker build -f apps/api/Dockerfile -t fdrive-api .
#
# Multi-stage build: install workspace deps for @fdrive/api and its workspace
# dependencies, compile every workspace dependency plus @fdrive/api with
# tsc, then deploy a production-only, standalone copy of the package (via
# `pnpm deploy`) into a slim, non-root runtime image.
#
# Workspace dependencies (currently @fdrive/contracts and @fdrive/core) are
# built here, not just @fdrive/api, because their package.json exports point
# at TypeScript source for zero-build local development (the
# "development"/"types" conditions), but plain `node` in the runtime image
# cannot execute TypeScript found under node_modules (Node refuses to strip
# types there). The "default" export condition therefore points at the
# compiled dist output, which must exist by the time `pnpm deploy` copies
# the package. `pnpm --filter @fdrive/api... build` builds @fdrive/api and
# every workspace package it depends on, in dependency order, so this stays
# correct as dependencies are added.

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build

RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

RUN pnpm install --frozen-lockfile --filter @fdrive/api...
RUN pnpm --filter @fdrive/api... build
RUN pnpm deploy --filter @fdrive/api --prod --legacy /out

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime

# setpriv lets docker-entrypoint.sh drop from root to FDRIVE_RUN_AS_UID.
RUN apk add --no-cache setpriv && addgroup -S fdrive && adduser -S fdrive -G fdrive

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=fdrive:fdrive /out ./

# `docker compose exec api node wait-ready.ts` waits for the enabled features.
COPY deploy/wait-ready.ts ./wait-ready.ts

# Kept in the image so a container restart cannot report a newer checkout's revision.
ARG FDRIVE_BUILD_REVISION=
RUN printf '%s' "$FDRIVE_BUILD_REVISION" > build-revision
LABEL org.opencontainers.image.revision=$FDRIVE_BUILD_REVISION

# The release it was built as (0.1.0 or main); `dev` or empty for any other build.
ARG FDRIVE_BUILD_VERSION=
RUN printf '%s' "$FDRIVE_BUILD_VERSION" > build-version
LABEL org.opencontainers.image.version=$FDRIVE_BUILD_VERSION

RUN mkdir -p /var/lib/fdrive/desktop /var/lib/fdrive/backups && chown fdrive:fdrive /var/lib/fdrive/desktop /var/lib/fdrive/backups

# deploy/compose.yaml starts the container as root with FDRIVE_RUN_AS_UID set:
# the entrypoint gives the state directories to that uid and drops to it
# before the API starts, so files it writes in the storage folder belong to
# the uid the indexer and OCR use. Any other start runs as this user.
COPY --chmod=0755 apps/api/docker-entrypoint.sh /usr/local/bin/fdrive-entrypoint
USER fdrive

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/v1/health || exit 1

ENTRYPOINT ["fdrive-entrypoint"]
CMD ["node", "dist/main.js"]
