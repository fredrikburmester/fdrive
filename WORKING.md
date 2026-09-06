# WORKING.md: how fdrive is built

This is the operating manual for a Claude Code session working on fdrive. A fresh session with no
memory of earlier work should be able to take "implement X, follow WORKING.md" and proceed the same
way every earlier session did. Read `PLAN.md` for what fdrive is and what is decided; read this file
for how work is done.

## 1. Roles

The session (the orchestrator) does not write production code or tests. It:

- breaks the request into chunks, writes each chunk's spec, and decides the order;
- owns every design decision on authentication, share proxying, the SFTPGo client's public
  interface, the API surface (contracts), and the database schema, and states those decisions in
  the chunk spec rather than leaving them to the agent;
- reviews every agent's diff before it reaches `main`, reading security-relevant code itself;
- runs the gates after every merge and looks at the running app in the browser pane;
- keeps `PLAN.md`, the memory files, and a per-session tracking note current.

Subagents do all implementation and all test writing. Two agent definitions exist in
`.claude/agents/`: `implementer` (production code plus its unit tests, runs the gates) and
`test-writer` (tests only, never edits `src/`). Both run on `model: sonnet`. Use a stronger model
only when a chunk genuinely needs it, and say why in the spec.

The agent registry loads at session start, so agent files added mid-session are not selectable
until the next session; in that case use `general-purpose` with `model: "sonnet"` and paste the
rules from the agent file into the prompt.

## 2. The chunk loop

1. **Spec.** Write a prompt that pins: the goal and the plan section it implements; the exact
   directories and files the agent may touch, and which files other agents are holding so it stays
   out; fixed interfaces, contracts, or routes when they are the orchestrator's decision; behaviour
   details that were verified, citing the doc or source; the tests required; the commands that must
   pass before the report; and the report format (files changed, final lines of each command,
   assumptions, anything left undone, `git branch --show-current`, `git rev-parse --show-toplevel`).
   Long specs are cheaper than vague ones. Every prompt says "never use git stash" and "never run
   git commands that change state".
2. **Isolation.** Launch with `isolation: "worktree"` so the agent works in its own checkout under
   `.claude/worktrees/` (excluded from git status via `.git/info/exclude` and from Biome via
   `biome.json`). Parallel `pnpm install` in one directory corrupts the lockfile; worktrees avoid
   it. Chunks that touch disjoint directories run in parallel, typically three to six at once. When
   two chunks need the same file, the second is queued until the first merges.
3. **Review.** When the report arrives, run
   `ALLOWED="<regex>" tools/orchestration/review-chunk.sh <worktree>` to check scope and the stash,
   then read the parts that matter: auth, scoping, anything touching user data, and whatever the
   report flagged as a judgement call. A truncated report is not a pass; inspect the worktree and
   run its gates yourself.
4. **Merge.** `tools/orchestration/merge-chunk.sh <worktree> "<conventional commit message>"`
   commits the chunk on its branch, merges into `main`, and regenerates the lockfile when it
   conflicts. Conflicting package manifests are resolved by taking the union of dependencies and
   scripts. Code conflicts between two parallel chunks go to an `implementer` on `main` with the
   instruction to keep both sides, never commit, and run every gate; the orchestrator then commits
   with `git commit --no-edit`.
5. **Verify.** After every merge: `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage` (per-package
   gates through turbo), and when the chunk touched the API or the schema, the integration suites.
   When anything visible changed, restart the dev servers if needed and look at it in the browser
   pane; several real bugs (SSE never reaching the browser, `fetch` "Illegal invocation", the
   Indexer page stuck on Loading, compress failing only in dev) surfaced there and nowhere else.
6. **Clean up.** `git worktree remove --force <path>` and delete its branch. Record the outcome.

## 3. Quality gates, the non-negotiables

- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; no `any`,
  no non-null assertions. Biome for lint and format; zero diagnostics on `main`.
- Per-package Vitest coverage thresholds enforced by `pnpm test:coverage`: functions 99 percent
  (core 100), lines 99, branches 95. Pure logic lives in small functions that take their
  dependencies as arguments; UI components are covered by Playwright and a few jsdom tests.
- Python services: ruff, mypy strict, pytest with `--cov-fail-under=95` and 100 percent on pure
  modules; inotify tests run in Docker.
- Container-backed integration suites for `db`, `sftpgo`, `testkit`, `api` (`pnpm test:integration`)
  and the Playwright suite on a real stack (`pnpm --filter @fdrive/web test:e2e`). Concurrent
  Playwright runs must set distinct `E2E_API_PORT` and `E2E_WEB_PORT`.
- Frontend: only shadcn/ui components added with the shadcn CLI, no hand-rolled primitives, no
  other component library; Apple-like design language; colours only from the tokens in
  `globals.css`. Every settings field carries a one-line description.
- Never publish the Claude session link anywhere. Commits end with the co-author trailer the
  harness specifies.

## 4. Environment

- Node 24 LTS. On this Mac the nvm default is still 22, so every shell that runs pnpm starts with
  `unset -f node npm npx pnpm; export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH`. Docker
  Desktop must be running.
- Dev stack: `pnpm dev:env` starts a seeded SFTPGo (`127.0.0.1:58080`, users `dev/dev`,
  `alice/alice-password`, `bob/bob-password`, `carol/carol-password`, admin
  `admin/admin-dev-password`), Postgres (`55432`), and with the `index` profile the indexer
  (`58010`), embeddings (`58081`), Tika, and OCR (`58011`). It also upserts `apps/api/.env.dev`.
  See `docs/DEVELOPMENT.md`.
- Dev servers come from `.claude/launch.json`: `api` on 3001 and `web` on an auto-assigned port
  (3000 is taken on this machine). Start them with the browser pane's preview tool. A merge that
  adds a dependency kills the API watcher mid-install; restart it afterwards. The pane may drop the
  web server after a while because `/` redirects and its readiness probe never passes; restart it.
- Nothing in development touches the user's live SFTPGo. Pointing fdrive at it is a config change
  (`SFTPGO_URL` or the setup page), not a code change, and is the user's call.

## 5. Tracking

- `PLAN.md`: scope, architecture, decisions, phases with "done when" criteria. Amend it whenever
  the user decides something; the plan is the contract.
- A per-session tracking note in the scratchpad (`phase<N>-wave<M>.md`): merged chunks, running
  chunks with what they touch, queued chunks with their spec fragments and why they wait, expected
  conflicts. Update it on every launch and merge; it is what survives context compaction.
- Memory (`~/.claude/projects/<project>/memory/`): user decisions that are not derivable from the
  code, and a status file with the current phase and open items. Update both when state changes.
- Git: one commit per chunk plus merge commits, conventional messages, so `git log --oneline` is
  the timeline. Never commit `.claude/worktrees`, env files, or Playwright output.
- The user follows along in the browser pane; announce what merged and what it looks like.

## 6. Pitfalls learned the hard way

- Agents sometimes stash, edit outside their scope, or report gates they did not run; the review
  step exists for that. Scope-check with the review script and read the gate lines.
- Two parallel chunks editing one shared file (`composition.ts`, `config.ts`, `client.ts`,
  `app-sidebar.tsx`) always conflict; serialize them or plan for the conflict-resolution agent.
- e2e-only assumptions hide dev-only failures: the e2e stack has fakes that differ from the dev
  wiring (lazy SFTPGo client, host-run API). Click through the pane after merging anything that
  touches jobs, SSE, or the connection store.
- Turbopack cannot resolve `./x.js` specifiers to `.ts` sources; workspace packages use `.ts`
  import specifiers with `rewriteRelativeImportExtensions`. Production images build workspace
  packages first (`pnpm --filter <app>... run build`).
- Next bakes `API_INTERNAL_URL` into the build; the compose proxy owns `/api`, and the web image is
  built with the compose value.
- Never run `pnpm test:coverage` (or any turbo task) while a Playwright run is active in the same
  checkout: the e2e harness creates `apps/web-e2e-shadow-<ports>/`, which turbo rejects as a
  duplicate workspace. Run them one after the other.
- Sidebar Favorites, Recents, and Tags sections render nothing until they have content; do not
  read their absence in a fresh dev database as a bug.
- Real SFTPGo v2.7.5 drops the TCP connection on `GET /api/v2/user/dirs` for a path that is a
  file (the in-memory fake answers 400). Never call `list` on a path of unknown kind; `statFile`
  first, list only after it reports `bad_request`.
- Zod 4's `z.iso.datetime()` rejects `+00:00` offsets unless `{ offset: true }`; Python emits
  offsets.
- Base UI: `DropdownMenuLabel` must sit inside a group; never nest a `ToggleGroup` in a menu; pass
  `nativeButton={false}` when a `Button` renders a link; React events bubble through portals, so
  listen on the DOM node when a container must ignore its portalled children.

## 7. Starting a new session

1. Read `PLAN.md` §13 for the current phase, then this file, then the memory status file.
2. `git log --oneline | head -30` and `git worktree list` to see what landed and what was left.
3. `pnpm dev:env`, start the `api` and `web` dev servers, open the pane, log in as `dev`.
4. Break the request into chunks, write specs, launch in worktrees, review, merge, verify, record.
