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

FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate
WORKDIR /repo

FROM base AS build
# Next.js bakes the rewrites() destination into the build at `next build`
# time; `next start` does not re-read this variable at runtime. The default
# (http://api:3001) matches the compose service name so the image works
# out of the box, but any deployment that changes the api's reachable
# address must pass --build-arg API_INTERNAL_URL=... to get a correct build.
ARG API_INTERNAL_URL=http://api:3001
ENV API_INTERNAL_URL=$API_INTERNAL_URL
COPY . .
RUN pnpm install --filter @fdrive/web... --frozen-lockfile
RUN pnpm --filter @fdrive/web... run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# Not read by `next start` (see the build stage comment above), but kept so
# server components and any code that reads process.env.API_INTERNAL_URL
# directly see the same value the build was baked with.
ARG API_INTERNAL_URL=http://api:3001
ENV API_INTERNAL_URL=$API_INTERNAL_URL
WORKDIR /app
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
