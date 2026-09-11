# Working on fdrive

Read relevant [architecture](docs/ARCHITECTURE.md), [plans](docs/plans/README.md) and current
[STATUS](docs/workflow/STATUS.md) before implementation. Commands:
[COMMANDS](docs/workflow/COMMANDS.md); load only relevant
recipes. Recovery: [TROUBLESHOOTING.md](docs/workflow/TROUBLESHOOTING.md). Product lessons:
[PITFALLS.md](docs/workflow/PITFALLS.md).

## Approach and boundaries

- Choose the simplest effective workflow. Implement cohesive changes directly; delegate only
  independent work whose size justifies the handoff. Use the native Agent tool with the roles
  in `.claude/agents/`; no custom spawning framework.
- Act on established facts: do not re-read what STATUS already records, re-derive settled
  decisions, or survey options you will not take. When a task is ambiguous, state one
  assumption and continue; block only when a wrong guess would make the work useless.
- Roles: `implementer` (code plus tests) and `test-writer` (tests only). Both default to
  Opus. Fable subagents require explicit user approval for the specific scope; explain the
  cost and why Opus is insufficient. Never escalate automatically or through inheritance.
  The primary agent may itself run on Fable; that does not extend to workers.
- Delegated writes use prepared `claude/<chunk>` worktrees from `prepare-worktree.sh`,
  absolute paths, and disjoint file ownership. Give each worker the goal, acceptance
  criteria, required checks, checkout, and ownership in the prompt; workers do not inherit
  this conversation. Run independent workers in the background and in parallel.
  Workers preserve others' changes, stay in scope, never delegate, stash, or mutate Git state.
- Agree on shared interfaces before parallel work: state the settings/API shape and each
  worker's file ownership. Notify affected workers when either changes.
- Use a formal spec for substantial or cross-interface work. Resolve changes against
  the architecture references; record durable decisions in the relevant developer document.
- Review actual diffs, including new files and sensitive boundaries. Transfer reviewed worker
  deltas with `transfer-checkout.sh`; commit/merge only when requested. Verify in the target.
  Keep the worker copy until transfer and verification succeed; never discard unreviewed work.
- Maintain a short STATUS at meaningful handoffs: current work, ownership, evidence, blockers,
  and next steps. Move completed history to the linked archive; avoid duplicating tool logs.
- Preserve user changes, hooks, and quality gates. Never hand-edit lockfiles, commit secrets
  or generated outputs, publish Claude session links anywhere, or write auto-memory unasked.
  Connecting to live user SFTPGo requires the user's decision; attribution only when requested.
- The shared stash stack is unsafe across worktrees: prefer a temporary WIP commit; if a
  stash is unavoidable, push with a unique tag, apply by SHA, then drop it.
- A PreToolUse guard enforces the subset of these rules that is never safe: untagged or
  SHA-less stash operations, `git reset --hard`, `git clean -f`, `git push --force`,
  lockfile hand-edits, and session links. These are refused outright rather than prompted,
  so choose the alternative above from the start; the refusal names it if you forget.

## Verification

Use `verify.sh <checkout> <profile>`; runtime selection and checkout locking are automatic.
Use `run-in-checkout.sh <checkout> --lock -- <argv>` for custom installs/checks; unlocked mode
is for read-only commands and dev servers. Separate concurrent browser runs by checkout/ports.

| Change | Required checks |
| --- | --- |
| Application integration | `application` (lint, typecheck, coverage) |
| API/schema/storage | Also `integration` |
| Visible UI/flows | Also affected `browser` tests and real dev app verification |
| Python service | `python <service>`; indexer includes Docker inotify |
| Docs/agent config/orchestration | `workflow` |
| Worker package | `package <name>` plus applicable checks above |

Verify one complete path early. Before expanding across features, test one feature through
UI, API, worker, and observed result, where those layers apply.
Run one heavy Docker build or container test suite at a time across worktrees; lightweight
checks can run concurrently. Coordinate heavy checks through the primary agent.

During iteration, run focused checks. Run required target profiles after integration; repeat
only after relevant changes/failures. A skipped, interrupted, or failed check is not a pass.
Report compact helper summaries and remaining limitations; full logs stay on disk. Report
outcomes faithfully: failed output verbatim, skipped steps named, mocked versus real runtime
verification distinguished.

## Implementation

Follow existing architecture and configured lint/type/coverage rules; never weaken gates.
Test observable behavior and edge cases. Prefer small pure functions with injected dependencies.
Frontend: use shadcn/ui CLI primitives, `globals.css` tokens, quiet Apple-like design, lucide
icons, and one-line descriptions for settings fields. Restart dev after env/dependency changes.

## Reporting

Lead with the outcome. Keep reports short by omission: changed files, checks passed or failed
with log paths, remaining gaps, checkout and branch. No restated plans or closing offers.
