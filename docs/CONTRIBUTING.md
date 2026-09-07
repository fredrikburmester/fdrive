# Contributing to fdrive

Thank you for helping improve fdrive!

---

## Repository Layout

fdrive is a Turborepo monorepo with `pnpm` workspaces:

- **`apps/`**: Deployable applications:
  - `apps/web`: Next.js 16 UI with React 19, Tailwind CSS 4, and shadcn/ui components.
  - `apps/api`: Hono REST, SSE, WOPI, and MCP API on Node 24.
- **`packages/`**: Shared TypeScript packages:
  - `packages/core`: Pure domain logic and ports (zero I/O, 100% testable).
  - `packages/contracts`: Zod schemas and typed API client.
  - `packages/sftpgo`: SFTPGo REST client and in-memory test fake.
  - `packages/db`: Drizzle schemas, migrations, and database repositories.
  - `packages/config`: Shared Vitest and TypeScript configurations.
- **`services/`**: Python companion services:
  - `services/indexer`: Inotify watcher, text chunking, and thumbnail generator.
  - `services/image-embed`: Fast Starlette sidecar for SigLIP image embeddings.
  - `services/ocr`: Nightly OCRmyPDF background runner.
- **`deploy/`**: Docker Compose configurations, Caddy proxy files, and deployment scripts.

---

## Code Quality Standards

Every pull request must pass the automated quality gates:

1. **TypeScript Strict**: Clean type checking (`pnpm typecheck`) with no `any` and `noUncheckedIndexedAccess`.
2. **Biome Lint & Format**: Zero warnings on `pnpm lint`.
3. **High Unit Test Coverage**: Every package enforces high test coverage thresholds via `pnpm test:coverage` (99% functions and lines in core).
4. **Integration Tests**: Critical storage, auth, and database flows are covered by container integration tests (`pnpm test:integration`).
5. **UI Consistency**: Every UI component comes from shadcn/ui primitives (`src/components/ui/`) adhering to the clean, minimalist design language.

---

## Submitting Changes

1. Fork the repository and create a feature branch.
2. Run quality checks locally:
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test:coverage
   ```
3. Open a pull request with a concise description of your changes and why they were made.
