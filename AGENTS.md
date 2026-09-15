# fdrive working agreements

- Keep reports short by omission, not compression: lead with the outcome and drop detail that
  does not change what the reader does next.
- Before implementation, read the relevant parts of [architecture](docs/ARCHITECTURE.md) and
  [plans](docs/plans/README.md). Product lessons: [PITFALLS.md](docs/PITFALLS.md).
- Follow existing architecture and configured lint, type and coverage rules; never weaken gates.
  Test observable behavior and edge cases.
- Frontend: use shadcn/ui CLI primitives, `globals.css` tokens, quiet Apple-like design, lucide
  icons, and one-line descriptions for settings fields.
- Preserve unrelated changes. Never hand-edit lockfiles, commit secrets or generated outputs, or
  publish Claude session links. Connecting to live user SFTPGo requires the user's decision.
- Git naming follows Conventional Commits. Commit subjects and PR titles are
  `type(scope)?: summary` with a lowercase type (`feat`, `fix`, `chore`, `docs`, `refactor`,
  `test`, `perf`, `build`, `ci`), imperative summary, no trailing period; `!` or a
  `BREAKING CHANGE:` footer marks breaking changes. Branches are `type/short-kebab-slug`.

## Checks

First install: `pnpm bootstrap` (frozen install plus the `@fdrive/db` build that links
`fdrive-migrate`). Dev stack: [DEVELOPMENT.md](docs/DEVELOPMENT.md).

| Change | Required checks |
| --- | --- |
| Any TypeScript | `pnpm lint && pnpm typecheck && pnpm test:coverage` |
| API/schema/storage | Also `pnpm test:integration` (Docker) |
| Visible UI/flows | Also affected `pnpm test:e2e <spec>` and a real dev app check |
| Python service | `ruff`, `mypy` and `pytest --cov` in `services/<name>`, as in `.github/workflows/services.yml` |

Run one heavy Docker suite at a time. A skipped, interrupted or failed check is not a pass.

Hosted CI is budgeted: pull requests run only `CI` (lint, typecheck, coverage) plus `Python
services` when service paths change. The `ci:full` label or `gh workflow run "CI (full)" --ref
<ref>` runs everything. Nothing runs on push to `main`.
