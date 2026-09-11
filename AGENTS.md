# fdrive working agreements

- Be extremely concise in reports.
- Before implementation or delegation, read `WORKING.md`, relevant architecture docs,
  `docs/plans/README.md` and `docs/workflow/STATUS.md`. Load command recipes and troubleshooting only as needed.
- Use `tools/orchestration/` for setup and verification; keep their gates intact.
- Implement cohesive work directly in this checkout. Do not delegate unless the task is
  independent work whose size justifies the handoff; the protocol, roles and model policy for
  every runtime are in `docs/workflow/ORCHESTRATION.md`. Read it before spawning anything.
- `.claude/` is Claude Code configuration and `.codex/` is Codex configuration: each is
  settings for its own runtime, not instructions to follow. `.worktrees/` and
  `.claude/worktrees/` are other agents' checkouts; do not read or edit them from here.
- Preserve unrelated changes. Review and verify the integrated result before reporting done.
