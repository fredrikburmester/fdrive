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
#
# `node:24-alpine` is pinned by digest (see deploy/README.md's pins table)
# so a rebuild never silently picks up a new base image without a
# deliberate bump of the digest in both FROM lines below.

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS base
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
# Same "baked at build time, not re-read by `next start`" rule applies to
# the Content-Security-Policy's `frame-src` (see next.config.ts's
# buildContentSecurityPolicy): verified empirically that setting this as a
# plain runtime `-e`/compose `environment:` value has no effect once the
# image is built. Empty by default (no office origin allowed); an office
# overlay (compose.office.yaml, compose.office.collabora.yaml) must pass
# --build-arg FDRIVE_OFFICE_PUBLIC_URL=... matching its own
# FDRIVE_OFFICE_PUBLIC_URL for the office editor iframe to load under the
# CSP.
ARG FDRIVE_OFFICE_PUBLIC_URL=
ENV FDRIVE_OFFICE_PUBLIC_URL=$FDRIVE_OFFICE_PUBLIC_URL
COPY . .
RUN pnpm install --filter @fdrive/web... --frozen-lockfile
RUN pnpm --filter @fdrive/web... run build

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime
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
# Alpine ships neither curl nor wget; Node's own fetch (stable since Node 18)
# hits /login (public, no auth or setup gate) rather than / (which redirects
# signed-out visitors, see e2e/smoke.spec.ts) so a plain 200 means the app is
# actually serving pages, not just that the process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
