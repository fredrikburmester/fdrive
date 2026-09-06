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
