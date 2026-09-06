# fdrive

fdrive is a self-hosted file drive that sits in front of an existing SFTPGo server. It gives you
browsing, transfer, search, tagging, and in-browser document editing over ONLYOFFICE, without ever
touching SFTPGo's own database. The web UI, the API, and the background indexer are separate
deployables that share a small set of TypeScript packages for the domain model, contracts, and the
SFTPGo client, so the storage layer stays swappable and the user-facing surface stays typed end to
end.

See [PLAN.md](./PLAN.md) for the full architecture, domain model, phased delivery plan, and the
decisions behind them. Prerequisites for local development are Node 24, pnpm, and Docker (used for
the SFTPGo, Postgres, and embedding containers that the integration tests and compose stack need).

## Scripts

Run these from the repository root:

- `pnpm lint` - check formatting, import order, and lint rules with Biome.
- `pnpm lint:fix` - apply Biome's automatic fixes.
- `pnpm typecheck` - type-check every package via Turborepo.
- `pnpm test` - run unit tests once.
- `pnpm test:coverage` - run unit tests with coverage, enforcing each package's thresholds.
- `pnpm test:integration` - run the Docker-backed integration tests via Turborepo.
- `pnpm build` - build every app and package via Turborepo.
- `pnpm dev` - run every app and package in watch mode, in parallel.
