# Build context is the monorepo root:
#   docker build -f apps/web/Dockerfile -t fdrive-web:dev .
#
# @fdrive/web depends on @fdrive/contracts and @fdrive/core, whose
# package.json exports point at TypeScript source for zero-build local
# development (the "development"/"types" conditions). Production `next
# build` resolves the "default" condition instead, which points at the
# compiled dist output, so those workspace packages must be built before
# `next build` runs. `pnpm --filter @fdrive/web... run build` runs the
# "build" script (when present) for @fdrive/web and every workspace
# package it depends on, in topological (dependency-first) order, without
# needing turbo installed.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --filter @fdrive/web... --frozen-lockfile
RUN pnpm --filter @fdrive/web... run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
