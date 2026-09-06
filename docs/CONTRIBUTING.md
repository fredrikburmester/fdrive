# Contributing

## Package layout

The repository is a pnpm workspace managed with Turborepo. Applications live under `apps/*`
(the Next.js web UI and the Hono API). Shared TypeScript libraries live under `packages/*`
(domain logic, contracts, the SFTPGo client, the database layer, and shared config such as
`packages/config`). Python services live under `services/*`. Compose files and deployment notes
live under `deploy/`. See [PLAN.md](../PLAN.md) section 11 for the full layout and the reasoning
behind it.

A new package under `apps/*` or `packages/*` should not require editing anything at the repository
root: it picks up TypeScript settings by extending `tsconfig.base.json`, picks up lint and format
rules from the root `biome.json`, and picks up its Vitest project by matching the
`apps/*/vitest.config.ts` or `packages/*/vitest.config.ts` glob in the root `vitest.config.ts`.

## The coverage rule

Every function gets a unit test. Coverage is enforced per package through that package's own
`vitest.config.ts`, built on the shared preset in `packages/config`
(`@fdrive/config/vitest.preset`). The default thresholds are functions 99%, lines 99%, branches
95%, and statements 99%; a package may raise (or, with justification, lower) any of these by
passing an override to `definePackageConfig`. A pull request that drops a package below its gate
does not merge.

## Running tests

- `pnpm test` runs every package's unit tests once, via Vitest's project mode.
- `pnpm test:coverage` runs `turbo run test:coverage`, which invokes each package's own
  `test:coverage` script directly. This matters because Vitest's project mode does not enforce
  per-project coverage thresholds from the root config, so the gates only actually apply when
  each package's `vitest.config.ts` runs on its own through Turborepo.
- `pnpm test:integration` runs the Docker-backed integration tests through Turborepo.

Docker-backed tests (SFTPGo, Postgres, and embedding containers via testcontainers) live under
each package's `test/integration/` directory and are excluded from the regular unit test run so
that `pnpm test` and `pnpm test:coverage` never require Docker. CI runs them as a separate job,
after the lint, typecheck, and unit test job passes.

`apps/web`'s `pnpm test:e2e` (Playwright) is safe to run more than once on the same machine at
the same time, e.g. two agents in separate worktrees, or a developer running it next to a CI-like
job: `E2E_API_PORT` and `E2E_WEB_PORT` pin the API and web ports when set, otherwise
`global-setup.ts` binds a free ephemeral port for each; the shared state file (storage state,
process ids) always lives under a fresh `fs.mkdtemp` directory per run, never a fixed path. The
production web build needed one more fix beyond ports: `next.config.ts` bakes `API_INTERNAL_URL`
into `.next/routes-manifest.json` at build time (it is the `/api/*` rewrite destination), so two
runs with different API ports cannot share one `apps/web/.next` directory without one silently
serving the other's requests to the wrong API port. Rather than serialize builds behind a lock
file and accept that only the build that runs last is actually correct, `support/environment.ts`
builds each run in its own `apps/web-e2e-<ports>` "shadow" directory (a sibling of `apps/web`
populated with symlinks back to it, so `next build`'s output never collides), removed again once
the run finishes.
