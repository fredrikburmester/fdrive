# Working on fdrive

Read relevant [PLAN.md](PLAN.md) decisions and current [STATUS.md](docs/workflow/STATUS.md)
before implementation. Commands: [COMMANDS.md](docs/workflow/COMMANDS.md); load only relevant
recipes. Recovery: [TROUBLESHOOTING.md](docs/workflow/TROUBLESHOOTING.md). Product lessons:
[PITFALLS.md](docs/workflow/PITFALLS.md).

## Approach and boundaries

- Choose the simplest effective workflow. Implement cohesive changes directly; delegate
  independent work when beneficial. Use native subagent tools, no custom spawning framework.
- Model defaults are configured in `.codex/`. Astra subagents require explicit user approval
  for the specific scope and `low` reasoning only. Explain the risk and why Terra is
  insufficient; never escalate automatically or bypass this through inheritance.
- For delegated writes, use `implementer` (code/tests) or `test-writer` (tests only), separate
  prepared `codex/` worktrees, absolute paths, and disjoint ownership. Respect runtime limits.
  Workers preserve others' changes, stay in scope, never delegate, stash, or mutate Git state.
- State goal, acceptance criteria, and required checks; use a formal spec for substantial or
  cross-interface work. Resolve architecture against PLAN; record durable decisions there.
- Review actual diffs, including new files and sensitive boundaries. Transfer reviewed worker
  deltas with `transfer-checkout.sh`; commit/merge only when requested. Verify in the target.
  Keep the worker copy until transfer and verification succeed; never discard unreviewed work.
- Maintain a short STATUS at meaningful handoffs: current work, ownership, evidence, blockers,
  and next steps. Move completed history to the linked archive; avoid duplicating tool logs.
- Preserve user changes, hooks, and quality gates. Never hand-edit lockfiles, commit secrets
  or generated outputs, publish private agent session links, or write personal memory unasked.
  Connecting to live user SFTPGo requires the user's decision; attribution only when requested.

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

During iteration, run focused checks. Run required target profiles after integration; repeat
only after relevant changes/failures. A skipped, interrupted, or failed check is not a pass.
Report compact helper summaries and remaining limitations; full logs stay on disk.

## Implementation

Follow existing architecture and configured lint/type/coverage rules; never weaken gates.
Test observable behavior and edge cases. Prefer small pure functions with injected dependencies.
Frontend: use shadcn/ui CLI primitives, `globals.css` tokens, quiet Apple-like design, lucide
icons, and one-line descriptions for settings fields. Restart dev after env/dependency changes.
