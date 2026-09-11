# Current handoff

Updated: 2026-09-11. Unfinished product work: [plans](../plans/README.md).
Current implementation: [architecture](../ARCHITECTURE.md). Prior delivery evidence:
[history](STATUS-history.md). Historical branch/commit and in-progress labels are snapshots,
not current instructions.

## Documentation cleanup

- Added the storage-provider developer guide; removed five obsolete P10 briefs.
- Removed completed P2–P9/UX/onboarding briefs and the mixed root plan. Unfinished features,
  fixes/verification and deferred ideas now have separate documents under `docs/plans/`.
- Preserved current scope/Office/security contracts in developer references, moved dated
  handoffs to history and updated source-comment/document links.
- Cleanup passed the workflow gate and local link/anchor checks; independent backlog review
  confirmed remaining requirements survived. Existing application/test/pentest diffs were
  preserved exactly. The earlier provider guide also passed its TypeScript example typecheck.

## Existing checkout work

- Provider/auth isolation edits and tests, Playwright configuration, pentest findings and
  `PR-REVIEW-FINDINGS.md` predate this cleanup and remain uncommitted. The documentation
  cleanup was moved to `main` for the requested commit; no push requested.
- Detailed security followups: [pentest findings](SHANNON-PENTEST-FINDINGS.md).
- This cleanup changes documentation and source comments only. It does not claim new
  application, browser, performance or security verification.

- Previous local main history is retained on `codex/main-before-docs-cleanup`; main now
  starts from the merged PR #1. Its base tree matched the documentation checkout exactly.

## Established verification

- Phase 5 full strict performance passed, including search25k p95 195.82 ms (<300).
- Provider binding has integrated two-HTTP-server fixture coverage (SFTPGo fakes).
- Remaining feature/verification gaps are listed in plans; completed work and old worker
  assignments must not be restarted from historical briefs.
