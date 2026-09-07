# WORKING.md: how fdrive is built

This is the shared operating manual for Codex and Claude Code sessions working on fdrive. A fresh
session with no memory should be able to take "implement X, follow WORKING.md" and proceed the same
way every earlier session did. Read `PLAN.md` for what fdrive is and what is decided; read this file
for how work is done.

## 1. Roles

The primary session (the orchestrator) delegates production code, tooling, and tests. It may
edit workflow documentation and agent configuration itself. These duties apply only to the
primary agent; workers implement their assigned chunk directly and never delegate. The primary:

- breaks the request into chunks, writes each chunk's spec, and decides the order;
- owns every design decision on authentication, share proxying, the SFTPGo client's public
  interface, the API surface (contracts), and the database schema, and states those decisions in
  the chunk spec rather than leaving them to the agent;
- reviews every agent's diff before it reaches `main`, reading security-relevant code itself;
- runs the gates after every merge and looks at the running app in the browser pane;
- keeps `PLAN.md` and `docs/workflow/STATUS.md` current.

Subagents do implementation and test writing. Codex definitions live in `.codex/agents/`:
`implementer.toml` (production code and its unit tests) and `test-writer.toml` (tests only,
including colocated tests; never production source). They inherit the parent's model and
reasoning unless explicitly configured. Record any deliberate model override in the chunk spec.
`.codex/config.toml` caps workers at three; respect a lower runtime limit.

Claude Code retains equivalent definitions in `.claude/agents/`, with its own model selection.
Keep both sets of role instructions aligned when changing shared rules.

Start a fresh session after changing agent configuration. If a runtime cannot select the custom
role, read its file and include the role instructions in a generic worker's prompt. Never claim
that a named agent was loaded unless the runtime exposes it. All workers must be told their
absolute checkout, allowed paths, parent-only duties, and the ban on recursive delegation.

## 2. The chunk loop

1. **Spec.** Write a prompt that pins: the goal and the plan section it implements; the exact
   directories and files the agent may touch, and which files other agents are holding so it stays
   out; fixed interfaces, contracts, or routes when they are the orchestrator's decision; behaviour
   details that were verified, citing the doc or source; the tests required; the commands that must
   pass before the report; and the report format (files changed, final lines of each command,
   assumptions, anything left undone, `git branch --show-current`, `git rev-parse --show-toplevel`).
   Long specs are cheaper than vague ones. Every prompt says "never use git stash" and "never run
   git commands that change state".
2. **Isolation.** The primary creates a worktree before launching a writing worker, for example
   `git worktree add -b codex/<chunk> .worktrees/<chunk> HEAD`. Resolve its absolute path and put
   it in the prompt; all worker commands and edits must use that path. Codex subagents share the
   parent's directory by default; there is no automatic `isolation: "worktree"` in this workflow.
   Keep `.worktrees/` ignored by Git and Biome. Claude may use its native worktree isolation under
   `.claude/worktrees/`. Install dependencies separately in each checkout, never concurrently in
   one directory. Run up to three disjoint chunks in parallel. Queue overlapping paths until the
   first chunk integrates. A fresh worktree starts from committed HEAD; commit prerequisites when
   authorized or explicitly copy needed uncommitted changes and include them in the review scope.
3. **Review.** When the report arrives, run
   `ALLOWED="<regex>" tools/orchestration/review-chunk.sh <worktree>` to check scope and the stash.
   The script exits nonzero on violations. Read auth, scoping, anything touching user data, and
   whatever the report flagged as a judgement call. A truncated report is not a pass; inspect the worktree and
   run its gates yourself.
4. **Merge.** Run `ALLOWED="<regex>" tools/orchestration/merge-chunk.sh <worktree>
   "<conventional commit message>" <target-checkout>` on one shell line. The target must be an
   explicit clean checkout on the intended branch, normally `main`; do not assume the primary
   session itself is on `main`. The helper checks scope before staging, commits the chunk, and
   creates a merge commit. It preserves Git hooks and stops on errors. Set `CO_AUTHOR` only when
   an actual co-author trailer is required; there is no default attribution. If only the lockfile
   conflicts, regenerate it using pnpm. Conflicting manifests need the union of dependencies and
   scripts; do not discard either side. Assign code conflicts to one implementer in the target
   checkout as an explicit isolation exception: keep both intended changes, never commit, run the
   gates. The primary inspects, stages, and finishes the merge. If commits were not requested,
   review and apply the chunk diff to the target as uncommitted changes instead; retain its
   worktree until every change has been verified as transferred.
5. **Verify.** After every merge: `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage` (per-package
   gates through turbo), and when the chunk touched the API or the schema, the integration suites.
   When anything visible changed, restart the dev servers if needed and look at it in the browser
   pane; several real bugs (SSE never reaching the browser, `fetch` "Illegal invocation", the
   Indexer page stuck on Loading, compress failing only in dev) surfaced there and nowhere else.
6. **Clean up.** After verifying that the complete chunk is integrated, remove a clean worktree
   with `git worktree remove <path>` and delete its merged branch. Do not force-remove unreviewed
   work. For a diff transferred without commits, verify tracked and untracked files before
   removing the disposable checkout. Record the outcome and remaining work.

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
- Never publish private agent session links. Use a co-author trailer only when the active
  harness or user specifies one; never attribute Codex work to Claude.

## 4. Environment

- Node 24, as pinned by `.node-version` and `.nvmrc`. Check `node --version` in each worker
  shell; activate Node 24 with your version manager when needed. On this Mac the installed
  binary is `$HOME/.nvm/versions/node/v24.20.0/bin/node`; avoid the older shell default. Docker
  Desktop must be running for container-backed work.
- Dev stack: `pnpm dev:env` starts a seeded SFTPGo (`127.0.0.1:58080`, users `dev/dev`,
  `alice/alice-password`, `bob/bob-password`, `carol/carol-password`, admin
  `admin/admin-dev-password`), Postgres (`55432`), and with the `index` profile the indexer
  (`58010`), embeddings (`58081`), Tika, and OCR (`58011`). It also upserts `apps/api/.env.dev`.
  See `docs/DEVELOPMENT.md`.
- Start dev servers in separate persistent terminals: `pnpm --filter @fdrive/api dev` and
  `pnpm --filter @fdrive/web dev --port 3002`. API uses 3001; choose another free web port if
  3002 is occupied. Open the actual printed web URL in Codex's browser and log in as `dev`.
  `pnpm dev:env` prepares the local env files; restart servers after env or dependency changes.
  `.claude/launch.json` remains an optional Claude launcher, not a Codex configuration file.
- Nothing in development touches the user's live SFTPGo. Pointing fdrive at it is a config change
  (`SFTPGO_URL` or the setup page), not a code change, and is the user's call.

## 5. Tracking

- `PLAN.md`: scope, architecture, decisions, phases with "done when" criteria. Amend it whenever
  the user decides something; the plan is the contract.
- `docs/workflow/STATUS.md`: current work, merged chunks, running workers and owned paths,
  queued specs and dependencies, expected conflicts, and validation results. Update on each
  launch and integration; the file is the shared handoff across sessions and tools. Keep active
  notes outside a merge target while integrating if necessary, then reconcile them afterward.
- Keep durable user decisions in `PLAN.md`, not hidden personal memory. Do not automatically
  update `~/.claude/` or `~/.codex/` memory. Personal memory writes require an explicit user request.
- Git: when committing is requested, one conventional commit per chunk plus merge commits, so
  `git log --oneline` is the timeline. Never commit `.worktrees/`, `.claude/worktrees/`, env files,
  or Playwright output. Do not commit or merge unrelated user changes.
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
- Sidebar Favorites, Recents, and Tags sections always render once their query resolves (a muted
  one-line placeholder replaces the list while empty); only a still-loading query renders nothing.
  A fresh dev database shows all three sections with their empty-state copy, not their absence.
- Real SFTPGo v2.7.5 drops the TCP connection on `GET /api/v2/user/dirs` for a path that is a
  file (the in-memory fake answers 400). Never call `list` on a path of unknown kind; `statFile`
  first, list only after it reports `bad_request`.
- Zod 4's `z.iso.datetime()` rejects `+00:00` offsets unless `{ offset: true }`; Python emits
  offsets.
- Base UI: `DropdownMenuLabel` must sit inside a group; never nest a `ToggleGroup` in a menu; pass
  `nativeButton={false}` when a `Button` renders a link; React events bubble through portals, so
  listen on the DOM node when a container must ignore its portalled children.
- Base UI Select: use `null` for an empty controlled value, not `undefined`; switching from
  undefined to a root name causes an uncontrolled-to-controlled warning. Give sentinel values
  explicit `SelectValue` display text so users see "All roots" instead of `__all__`.

## 7. Starting a new session

1. Read `PLAN.md` §13 for the current phase, then this file and `docs/workflow/STATUS.md`.
2. `git log --oneline | head -30` and `git worktree list` to see what landed and what was left.
3. For application work, run `pnpm dev:env`, start the `api` and `web` servers, open the browser,
   and log in as `dev`. Documentation or orchestration-only changes do not need a dev stack.
4. Break the request into chunks, write specs, launch in worktrees, review, merge, verify, record.

## 8. Codex configuration checks

- Root `AGENTS.md` is the automatic entry point; `WORKING.md` holds shared detail.
- Custom agents are standalone `.codex/agents/*.toml` files with `name`, `description`, and
  `developer_instructions`. Claude frontmatter and tool names are not Codex settings.
- Configuration changes require a fresh session to verify discovery. Ask it to summarize the
  active project instructions and available roles before starting the first chunk.
- For orchestration-only changes, run `bash tools/orchestration/test-orchestration.sh`, shell
  syntax checks, TOML parsing, and `pnpm lint`. Full application gates remain required after
  application merges; do not run Docker or browser tests for documentation-only changes.
- Official references: [instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
  and [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).
