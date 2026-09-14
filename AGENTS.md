# fdrive working agreements

- Keep reports short by omission, not compression: lead with the outcome and drop detail that
  does not change what the reader does next.
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
- Git naming follows Conventional Commits. Commit subjects and PR titles are
  `type(scope)?: summary` with a lowercase type (`feat`, `fix`, `chore`, `docs`, `refactor`,
  `test`, `perf`, `build`, `ci`), imperative summary, no trailing period; `!` or a
  `BREAKING CHANGE:` footer marks breaking changes. Branches you create are `type/short-kebab-slug`
  (`feat/share-page-expiry`, `fix/sftpgo-lease-renewal`). Worker worktrees prepared by
  `prepare-worktree.sh` keep their `claude/<chunk>` name; that is tooling, not a PR branch.
