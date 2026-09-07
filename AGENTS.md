# fdrive working agreements

- Be extremely concise in reports; sacrifice grammar for concision.
- Read `WORKING.md` before work. Read the relevant sections of `PLAN.md` and
  `docs/workflow/STATUS.md` before planning implementation.
- The primary agent is the orchestrator: own specifications, architecture, review,
  integration, gates, and tracking. Delegate production code, tooling, and tests to
  subagents. The primary may edit workflow documentation and agent configuration.
- Use `implementer` for implementation and accompanying tests; use `test-writer` for
  tests alone. Their Codex definitions are in `.codex/agents/*.toml`. If the current
  runtime cannot select custom roles, read the definition and include its
  `developer_instructions` in a generic subagent's prompt.
- These orchestration duties apply only to the primary agent. Workers implement
  their assigned chunk directly; they must not delegate or run the parent loop.
- The primary creates a separate Git worktree per writing worker, with a
  `codex/` branch, and gives the worker its absolute checkout path. Subagents
  otherwise share the parent's directory; spawning does not provide isolation.
  Use at most three simultaneous workers, further limited by runtime availability.
- Workers stay within assigned paths, never stash, and never run Git commands
  that change repository state. Only the primary commits, merges, or cleans up.
- Keep durable decisions in `PLAN.md` and operational handoffs in
  `docs/workflow/STATUS.md`. Do not automatically write personal agent memory.
- Use Node 24, pnpm, existing package scripts, and the quality gates in
  `WORKING.md`. Preserve unrelated user changes. Never commit secrets or outputs.
