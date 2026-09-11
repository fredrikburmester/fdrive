# fdrive working agreements

- Be extremely concise in reports.
- Before implementation or delegation, read `WORKING.md`, relevant architecture docs,
  `docs/plans/README.md` and `docs/workflow/STATUS.md`. Load command recipes and troubleshooting only as needed.
- Use `tools/orchestration/` for setup and verification; keep their gates intact.
- Implement cohesive work directly. Delegate independent work when it improves speed or
  quality enough to justify its cost; use native subagent tools and configured roles.
- Preserve unrelated changes. Review and verify the integrated result before reporting done.
- Agent roles live in `.claude/agents/`; model policy and worker boundaries in `WORKING.md`.
