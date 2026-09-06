# syntax=docker/dockerfile:1
#
# Build context is the repository root:
#   docker build -f apps/api/Dockerfile -t fdrive-api .
#
# Multi-stage build: install workspace deps for @fdrive/api and its workspace
# dependencies, compile @fdrive/contracts and @fdrive/api with tsc, then
# deploy a production-only, standalone copy of the package (via
# `pnpm deploy`) into a slim, non-root runtime image.
#
# @fdrive/contracts is built here (not just @fdrive/api) because its
# package.json exports point at TypeScript source for zero-build local
# development (the "development"/"types" conditions), but plain `node` in
# the runtime image cannot execute TypeScript found under node_modules
# (Node refuses to strip types there). The "default" export condition
# therefore points at the compiled dist output, which must exist by the
# time `pnpm deploy` copies the package.

FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/config ./packages/config
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api

RUN pnpm install --frozen-lockfile --filter @fdrive/api...
RUN pnpm --filter @fdrive/contracts build
RUN pnpm --filter @fdrive/api build
RUN pnpm deploy --filter @fdrive/api --prod --legacy /out

FROM node:22-alpine AS runtime

RUN addgroup -S fdrive && adduser -S fdrive -G fdrive

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=fdrive:fdrive /out ./

USER fdrive

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/v1/health || exit 1

CMD ["node", "dist/main.js"]
