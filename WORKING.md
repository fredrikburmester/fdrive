# Working on fdrive

Read this, the relevant [PLAN.md](PLAN.md) sections, and the latest
[STATUS.md](docs/workflow/STATUS.md) handoff before implementation.
[COMMANDS.md](docs/workflow/COMMANDS.md) holds setup, worktree, test, dev-server, and integration
recipes. Use the tested helpers in `tools/orchestration/`; implementation lessons live in
[PITFALLS.md](docs/workflow/PITFALLS.md).

## Models and roles

| Work | Model | Reasoning |
| --- | --- | --- |
| Implementation and accompanying tests (`implementer`) | Gemini 3.8 Flash (`gemini-3.8-flash-high`) | `high` |
| Tests only (`test-writer`) | Gemini 3.8 Flash (`gemini-3.8-flash-high`) | `high` |

Codex remains the orchestrator. All new workers run through `tools/orchestration/worker.sh`
using the installed Antigravity CLI (`agy`), never native Codex subagent tools. Select an
available Gemini model explicitly when overriding the user-selected pin in
`tools/orchestration/agy-worker-defaults.json`; record model and effort in the spec. There is
no GPT fallback. The runner injects role `developer_instructions` from `.codex/agents/`;
legacy native model fields there are ignored by this workflow. Existing workers may finish
unchanged. Do not start replacements while they still own their paths.

- **Primary:** owns specs, architecture, review, integration, gates, and tracking. Delegate
  production code, tooling, and tests; edit workflow docs and agent configuration directly.
- **Workers:** `implementer` for code plus tests, `test-writer` for tests only. Work directly
  in the assigned absolute checkout and file scope. Never delegate, stash, or mutate Git state.
  Report necessary out-of-scope changes to the primary.
- Run the agy runner's explicit `setup --checkout ABS` once per prepared worktree, then use
  `start`, `status`, `followup`, and `stop` commands. Pass the complete
  spec, an explicit model, and the absolute checkout. Follow-ups use the stored conversation
  ID, never the most recent conversation. If startup or permissions fail, report it.
- One worktree per writing worker, `codex/` branches, at most three workers including earlier
  native workers. Parallelize disjoint paths; queue overlaps. Preserve others' changes.

## Workflow

1. **Specify:** goal, plan reference, absolute checkout, owned paths, fixed interfaces,
   acceptance criteria, tests, and verification profile. The primary pins decisions about
   auth, storage interfaces, API contracts, share scoping, and schema.
2. **Prepare:** use `prepare-worktree.sh` before launching a writing worker. It starts at
   committed HEAD; explicitly copy any needed uncommitted specs/prerequisites and record
   that baseline. Workers must never assume the parent's changes exist in their checkout.
3. **Review:** scope-check with `review-chunk.sh`, inspect tracked and new files, and read
   security-sensitive changes yourself. Missing/truncated gate output is not a pass.
   Runner `needs_review` means only that agy returned a valid successful result. Check the
   saved stderr/events for denied tools, inspect the actual diff, and independently verify
   required tests. `needs_attention`, `failed`, `timed_out`, and `supervisor_lost` are not passes.
4. **Integrate:** use `merge-chunk.sh` only when commits are requested, with a finished worker
   and explicit clean target on the intended branch. Otherwise transfer the reviewed diff
   and new files as uncommitted changes, preserving target edits. Keep the worker checkout
   until its complete transfer is verified.
5. **Verify:** run the required profiles in the target after each integration. For visible
   changes, also exercise the real dev app; restart after env/dependency changes. Browser
   tests alone can miss dev wiring failures.
6. **Record and clean up:** update STATUS with results, validation, ownership, and remaining
   work. Remove only fully integrated worktrees; never force-remove unreviewed changes.

Worker prompts must state: never delegate, never use `git stash`, never run Git mutations,
use only the assigned checkout/paths, and preserve other workers' changes. Reports include
changed files, commands and final summary lines, assumptions, unfinished work, branch, and
checkout root. Be extremely concise.

## Verification policy

Run profiles through `verify.sh`; it selects the pinned runtime, locks the checkout, and
stops on the first failed gate. See COMMANDS for exact invocations and prerequisites.

| Change | Profiles / checks |
| --- | --- |
| Application integration | `application`: lint, typecheck, coverage |
| API/schema/storage integration | Also `integration` |
| Visible UI/flows | Also affected `browser` tests and real dev app verification |
| Python service | `python <service>`; indexer includes Docker inotify tests |
| Docs/agent config/orchestration | `workflow`; no application stack needed |
| Worker package scope | `package <name>` plus applicable integration/browser/service checks |

Setup and verification share an exclusive checkout lock. Use `run-in-checkout.sh --lock`
(as shown in COMMANDS) for custom installs/tests. Unlocked runs are for dev servers and
read-only commands. Raw commands bypass this protection: never overlap installs or run
Turbo during Playwright in one checkout. Concurrent browser runs use separate checkouts
and distinct free ports.

## Code and tracking rules

- Node 24 and the exact pnpm version in `package.json`. Helpers select installed runtimes;
  setup installs frozen dependencies and builds the declared migration binary without
  running migrations. Never hand-edit the lockfile or bypass hooks.
- Strict TypeScript, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; no `any` or
  non-null assertions. Zero Biome diagnostics. Small pure functions with injected dependencies.
- Preserve coverage gates: TypeScript functions/lines 99%, branches 95%, core functions 100%;
  Python at least 95%, pure modules 100%. Test behavior and edge cases; never lower gates to pass.
- Frontend primitives come from shadcn/ui via its CLI. Use `globals.css` color tokens,
  Apple-like design, and a one-line description for every settings field.
- PLAN holds durable scope/architecture decisions; STATUS holds operational handoffs.
  Update on launch/integration; keep handoff edits outside a clean merge target until integrated.
- Never commit secrets, env files, worktrees, or test output. Never publish private agent
  session links. Use attribution only when explicitly required. Personal memory writes need
  an explicit user request. Connecting to the user's live SFTPGo is the user's decision.
