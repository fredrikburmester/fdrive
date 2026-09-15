# fdrive working agreements

- Keep reports short by omission, not compression: lead with the outcome and drop detail that
  does not change what the reader does next.
- Before implementation, read `WORKING.md`, relevant architecture docs,
  `docs/plans/README.md` and `docs/workflow/STATUS.md`. Load command recipes and troubleshooting only as needed.
- Use `tools/orchestration/` for setup and verification; keep their gates intact.
- Subagents, worktrees and model choice are left to the runtime's own harness; this repo
  defines no roles or handoff protocol for them.
- `.claude/` is Claude Code configuration and `.codex/` is Codex configuration: each is
  settings for its own runtime, not instructions to follow. `.worktrees/` and
  `.claude/worktrees/` are other agents' checkouts; do not read or edit them from here.
- Preserve unrelated changes. Review and verify the integrated result before reporting done.
- Git naming follows Conventional Commits. Commit subjects and PR titles are
  `type(scope)?: summary` with a lowercase type (`feat`, `fix`, `chore`, `docs`, `refactor`,
  `test`, `perf`, `build`, `ci`), imperative summary, no trailing period; `!` or a
  `BREAKING CHANGE:` footer marks breaking changes. Branches you create are `type/short-kebab-slug`
  (`feat/share-page-expiry`, `fix/sftpgo-lease-renewal`). Worktrees a harness creates may keep
  the name it gives them; that is tooling, not a PR branch.
