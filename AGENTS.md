# fdrive working agreements

- Be extremely concise in reports; sacrifice grammar for concision.
- Read `WORKING.md` before work. Read the relevant sections of `PLAN.md` and
  `docs/workflow/STATUS.md` before planning implementation.
- Model selection and agent setup: `WORKING.md`.
- Repeatable procedures: `tools/orchestration/` helpers and `docs/workflow/COMMANDS.md`.
- The primary agent is the orchestrator: own specifications, architecture, review,
  integration, gates, and tracking. Delegate production code, tooling, and tests to
  subagents. The primary may edit workflow documentation and agent configuration.
- Launch all new workers through `tools/orchestration/worker.sh`, pinned to Gemini
  3.8 Flash high (`gemini-3.8-flash-high`). Never use native Codex subagents or silently fall
  back to GPT. If agy is unavailable or denied, report the blocker.
- Use role `implementer` for implementation and accompanying tests; `test-writer`
  for tests alone. The runner injects their `.codex/agents/*.toml` instructions;
  those files' legacy native model fields do not select the agy model.
- These orchestration duties apply only to the primary agent. Workers implement
  their assigned chunk directly; they must not delegate or run the parent loop.
- The primary creates a separate Git worktree per writing worker, with a
  `codex/` branch, and gives the runner its absolute checkout path. Use at most
  three simultaneous workers, including any earlier native workers still finishing.
  Do not interrupt or migrate existing workers merely because the launcher changed.
- Workers stay within assigned paths, never stash, and never run Git commands
  that change repository state. Only the primary commits, merges, or cleans up.
- Keep durable decisions in `PLAN.md` and operational handoffs in
  `docs/workflow/STATUS.md`. Do not automatically write personal agent memory.
- Use Node 24, pnpm, existing package scripts, and the quality gates in
  `WORKING.md`. Preserve unrelated user changes. Never commit secrets or outputs.
