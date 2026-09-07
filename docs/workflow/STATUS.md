# Workflow handoff

Updated: 2026-09-07. Owner: primary agent.

## Current state

- Main remains at `1fe7388`; changes are uncommitted. Existing Codex migration
  edits preserved, with P2-CLEAR-JOBS added in this session.
- P2-CLEAR-JOBS complete. Spec: `docs/workflow/P2-CLEAR-JOBS.md`. Product decisions
  and next phases: `PLAN.md`. No personal memory written.
- Three named implementers worked in separate `codex/p2-clear-{api,indexer,web}`
  worktrees under `/Users/fredrikburmester/Documents/GitHub/fdrive-web/.worktrees`.
  Parent reviewed scope, data boundaries and every production diff, transferred
  without commits, and byte-verified all tracked/untracked changes and prerequisites.
- P2 workers finished and their temporary worktrees removed after transfer verification.
- User subsequently authorized autonomous completion of remaining phases. Active
  goal: finish Phase 3 verification, Phase 4 office, Phase 5 accounts/shares/performance, then Phase 6 recovery/extensions.
  Phase 6 scheduled by the latest all-phases instruction; P6-DESIGN.md records the bounded recovery/image/rules/WebDAV scope. Configurable embeddings remain explicitly deferred.
- Phase 3 real SFTP rename verified, foundations reviewed and transferred without
  commits. Proof helpers/discovery cache and atomic database office locks integrated.
- Office registry reviewed and integrated, including 66,000-file rename/replay
  regression. Avoids per-file SQL parameters and unbounded row materialization.
- Office deployment reviewed/integrated including root helper gates and env
  placeholders. Full lint/typecheck/coverage/integration passed. Dev services
  recreated from main with preserved keys/JWT; deploy worktree can be removed.
- P4 host, contracts and UI reviewed/integrated. Root lint/typecheck/coverage and
  container integrations passed. Office save concurrency uses one transaction and
  pre-resolved SFTP credentials; oversized bodies stage privately before overwrite.
- No active workers since the 2026-09-07 morning handover (see the last section). The
  office e2e, performance and provider-binding deltas are transferred to main. Shares API and directory foundation
  reviewed/transferred; root lint/typecheck/coverage and all four container suites
  passed. Repeated DB teardown race fixed by awaiting actual socket end events. Specs match chunk names.
- Shares DB, atomic auth DB and account API reviewed/transferred. Root lint,
  typecheck, coverage and all container integrations passed after each transfer.
  Accounts real integration covers login/link races, session/token invalidation,
  metadata transfer and same-path cross-identity download authorization.
- Completed P4 host/web/transaction and identity DB worktrees removed after verified
  transfer. Completed shares/auth/accounts API cleanup dispatched after byte checks.
- SECURITY FIX: real read-only coeditor previously typed changes that Alice's save persisted.
  Earlier explicit-edit-intent design invalid. Preserve failing readonly.spec.ts.
  SFTPGo user API/webclient/WebDAV cannot report effective overwrite; r+ and upload
  probes unsafe. Preserving credential-only mode: explicit operator policy, default
  deny, bound provider UUID/username/path; no automatic permission inference. Exact
  spec P4-EDIT-ADMISSION.md implemented. Actual readonly coediting regression passes: edit403, view allowed, reader marker never persisted through Alice save.
  Admission/core/composition and deployment policy early-transferred23files. Archive cancellation cleanup repaired and transferred2files; root lint/typecheck/coverage and all four container integration suites passed.
- Real DOCX acceptance: two writers' markers persisted; actual editor rename/save
  copy verified in SFTPGo. Main pane created OfficeRenamed.docx/OfficeSavedCopy.docx
  with test text. Filename routing now decodes Next params exactly once, verified
  spaces, Unicode and literal %20. Three-file early transfer recorded separately.
- Integrated existing browser suite74/74 passed after account API. Real XLSX
  two-writer bytes/UUID passed too. Collabora ODT opens with ASCII filename; special
  filename regression traced to upstream image locale bug. Pinned upgrade26.04.3.2.1
  opens those names; Collabora real edit/save/SFTP bytes/reopen plus filenames4/4 passed.
- Queued P5-SCOPES.md and P5-PROVIDER-BINDING.md close trusted mapping and credential
  destination gaps once Office releases composition. P5-PERFORMANCE.md active in
  isolated checkout; real TEI/PG25k hybrid search and production browser10k included.
- Dev API restarted with existing .env.dev and private ignored
  .env.office.onlyoffice.dev; watcher session93732, port3001. Private dev env grants only seeded dev user on provider04bb0ded-55f9-446b-baaf-207beacef70b; production remains default deny. Web3002 hot-reloaded.
  Dev office services healthy58090/58091, callback reachability verified. Browser
  signed in as dev; created only test file Office smoke 2026-09-07.docx for acceptance.
- No personal memory written. No commits. Copied prerequisite/transferred-delta
  hashes in /tmp/fdrive-phase-baselines/*.json. Reuse named agents; total-agent limit.

## Delivered

- Background scoped index clear and global thumbnail-cache clear. Admin-only API,
  strict request validation, shared admission with rebuilds, progress and errors.
- Bounded index batches with extraction/embedding path locks. Originals, metadata,
  cache and event history survive index clearing. Cache cleanup rejects unsafe
  paths and symlinks, includes recognized orphan previews, retains failed rows.
- Thumbnail controls consolidated on Thumbnails: scoped rebuild, force, clear,
  progress. Indexer owns clear-index and reindex; settings descriptions added.
- Browser review also fixed generic busy feedback, raw `__all__` labels and the
  Reindex selector's uncontrolled-to-controlled warning. Regression tests added.
- Normal scans/on-demand generation can repopulate cleared data; UI explains this.

## Validation

- P3/P4 foundations integrated gate: lint707 files, typecheck all packages/tools,
  coverage8/8 packages; integration4/4 suites (221 tests: db165, SFTPGo46,
  testkit6, API4). Real SFTP rename propagated metadata in2.39s in isolated fixture.
- WOPI proof tests include all eight official Microsoft vectors, rotation matrix,
  strict discovery XML/action parsing and bounded cache. New protocol modules100%.
  API998 tests, 99.42% lines, 96.20% branches, 99.68% functions.
- DB170 unit tests; new pure lock module100%; two-pool lock contention/rollback
  integration passed. withFileLock holds advisory transaction through async save.
- Registry integrated gates allgreen: lint, typecheck,8/8 coverage, container
  integration229 tests (DB173, SFTPGo46, testkit6, API4).
  DB176 unit tests,100% lines/functions,97.24% branches.
- Real discovery parser verification: ONLYOFFICE472 actions, Collabora273;
  docx edit selected and both public keys validated. Real servers healthy on
  loopback58090/58091 under fdrive-office-dev, persisted proof-key volumes.
- Downloaded ONLYOFFICE9.4.0.1 and Collabora26.04.2.2.1. Pinned ONLYOFFICE ignores
  proof-key path env overrides; uses persisted DATA_DIR keys. Collabora image is
  distroless and requires native coolwsd flags, not legacy shell/extra_params.

- Root lint clean: 692 files. Typecheck: 13/13 packages plus tools.
- Coverage gates: 8/8 packages. Final web: 1058 tests, 99.93% lines,
  98.28% branches, 100% functions. Contracts 426 tests; API 911 tests.
- Container integration: 212 tests across four packages, all passed.
- Python: ruff clean; strict mypy 18 files; Docker pytest 346 passed,
  97.15% coverage; changed production modules each 100%.
- Full Playwright after final selector fixes: 74 passed (1.2 minutes).
  Never overlapped Playwright with Turbo in the same checkout.
- Live dev pane: cache clear and force rebuild each completed 6/6, zero errors,
  restored six previews (6.1 KB). Clearing `sftpgo:dev/photo copy.png` completed
  1/1, reduced indexed files 18 to 17, preserved original/Test tag/favorite/recent.
  Reindex restored 18 files. Friendly root label and warning-free selection verified.
- Dev API on 3001, web on 3002, rebuilt indexer on 58010. Thumbnails page left
  open in Codex. Existing invalid seeded PDF still appears in indexer errors.

## Next

1. Complete Phase 4 ONLYOFFICE WOPI, UI and real-editor end-to-end plus Collabora.
2. Phase 5 accounts, shares and blocking performance budgets.
3. Phase 6 recovery, similar images, index rules and WebDAV.
4. Configurable embedding provider/model remains deferred.

## Preserved Codex migration

Root instructions, implementer/test-writer roles, three-worker cap, worktree rules,
tracking, Claude role parity and orchestration script hardening remain uncommitted
for review. Previous validation: 16 orchestration regression groups; shell syntax,
TOML parsing, role parity and lint. This fresh session confirmed named roles are
available and followed the project instructions.

- Latest foundation gate: Python375 passed97.29% (directory/server100%); root
  lint808files, typecheck13packages/tools, coverage8/8, integration282tests
  (DB216/SFTP47/testkit6/API13), all green. Completed shares API and directory
  worktrees byte-verified and removed; changes remain uncommitted in main.

- Office outstanding: valid PPTX slide/master/layout/theme blank; ONLYOFFICE view
  cache ignores strong Version when LastModifiedTime present (approved conditional
  omission, real external edit regression); Collabora save focus; /view fallback
  still has stale future-copy (approved Office preview action).
- Account UI: client-mounted Activity fixes fresh navigation/hydration, global
  search shortcut above boundary. Queued writes capture immutable identity; upload
  initial-query invalidation fixed with cancel-then-refresh; reload workarounds removed. Final production browser26/26 and web1150 tests passed. Reviewed67files transferred; integrated gates running.

- Accounts67files integrated; live pane account/linked-login fields verified. Root lint840files/typecheck passed; coverage had one unchanged Office menu test5s timeout under load. Lower-concurrency rerun active. Shares web launched in separatecodex/p5-shares-web with complete copied prerequisite baseline; locked install passed.

- Accounts integrated gate passed: lint840files, typecheck13packages/tools, coverage8/8 plus Office helpers, all four container suites. Unchanged Office menu timeout passed at lower package concurrency; assertions/timeouts unchanged. Account checkout fully byte-verified and removed. Main pane Account and Link login dialog verified.

- Office external-cache regression now passed on actual ONLYOFFICE: same-size/same-mtime SFTP replacement changes rendered text; old text0/0, new1/1. Conditional LastModifiedTime omission reviewed, final transfer pending. Controlled queued PUT after rename reproduced404/lost save; approved transaction-local fresh registry/path resolution in writes, with sameUUID/new-path/no-resurrection regressions. Original editor title-reversion issue still under investigation.
- Preview Inspector favorite stat-cache bug confirmed independently; shares worker owns narrow metadata query/stat repair for early transfer. Office worker retains strict UI-toggle acceptance once repair copied.
- Performance full diagnostic produced real API/download/upload data; latest warm p9521.09ms and API/direct92.26% passed. Search timing still fails under concurrent workloads; production UI probe refinement ongoing. Parent final quiet full gate required. Runtime process cleanup/error artifact preservation strengthened after review.

- Latest Office acceptance7/7 passed on actual ONLYOFFICE; strengthened preview favorite assertion will reload after mutation to prove server persistence once fs.stat decoration repair lands. Collabora4/4 passed, including stored text and reopened document. Rename-back behavior traced to actual editor100ms focus-selection callback racing automated fill; observed selection wait fixes harness. Separate genuine queued-save404 repaired via transaction-local fresh registry path; API1228tests/84files and3real integrations passed. Final Office transfer still pending.
- Preview metadata web repair2files reviewed/transferred; root lint/typecheck/coverage passed. Live pane exposed underlying fs.stat missing metadata decoration; assigned API2file repair. OfficeRenamed.docx test favorite temporarily enabled for this verification; remove after persistent toggle works.
- Performance probe found Space intercepted by printable-key typeahead; shares worker assigned keyboard regression/repair. Perf uses normal Enter-open for independent readiness proof.

- fs.stat metadata decoration2files reviewed/transferred root and Office prerequisites. Live pane now shows persisted favorite after reload; removal also survived reload, restoring OfficeRenamed test file to not-favorited. API repair integrated gates passed: lint/typecheck, eight package coverage gates plus Office helpers, all four integration suites. Scope-engine checkout prepared from current reviewed root; locked install passed; no worker assigned until performance report/integration.

- Final production Office run6/7: only DOCX same-paragraph coauthor sequence failed with interleaved marker. Retaining exact persistence assertions; real Save/persisted-text barrier between writers and sanitized host/editor diagnostics assigned. Other six production cases passed. Performance observer serialization defect found: transformed callback referenced module-local __name in browser; raw source plus isolated execution test fixes instrumentation, actual budget probe still pending. Shares public/management review underway; initial web1179tests passed.

- Real production10k UI revealed unconstrained shell height rendered10000 rows (~10.18s). Perf worker's minimal SidebarProvider/Inset height and scrolling fix now passes5samples each: list p9563.72ms/max37rows, grid p9571.00ms/max130tiles. All10contexts exact10000 entries with normal clicks/keyboard/scroll/open. Desktop/mobile settings scroll and package gates pending. One earlier contended response9888 remains diagnosed separately; no count or timing gate relaxed.
- Shares production review complete for public credential isolation, streamed attachment/error handling, bounded previews, password generation cancellation, management actions and keyboard integration. Final40file manifest prepared, includes environment union against frozen Office fixture; final coverage and production3scenario suite pending. Office DOCX/XLSX two-writer production checks now passed with per-writer Save barrier; remaining cases running.
- Queued scope consumer split specified in P5-SCOPE-CONSUMERS.md: explicit mapping/read checks across HTTP/Office/events and MCP, truthful bounded authorized aggregates.

- Shares40files reviewed, strict delta44including4prior repairs verified, transferred uncommitted. Production browser4/4 passed; root lint872/typecheck passed. Root coverage first attempt failed because sandbox denied localhost listeners (EPERM); identical gate rerunning escalated. Live pane created password-protected Local share check, displayed public file/download after password, then revoked successfully; test link removed. Friendly Access/Password option labels assigned as2file early repair in provider-binding checkout.
- Provider-binding launched in fresh codex/p5-provider-binding with1051reviewed prerequisite hashes and locked install. Office composition/auth/harness already identical to root, so security implementation can proceed while Office harness diagnoses PPTX stale-caret failure. Office env updated to reviewed Office/accounts/shares union plus share fixture, recorded as baseline prerequisites; final Office delta must omit env.
- Perf count mismatch reproduced directly upstream: physical10000, direct10192/API10144 but10000unique, no missing names. macOS bind-mount enumeration duplicates; isolated Docker volume with one-time population approved for same real shared filesystem, SFTPGo RW/indexer RO, exactcounts retained. Root Biome artifact exclusion and tracked result .gitignore delegated. Final volume/browser/settings proof pending.

- Shares integrated gate completed: lint872/typecheck, eight coverage packages plus Office helpers passed (web135files1189tests). Earlier failures were localhost-listener EPERM from sandbox, resolved by same gate with allowed test listeners. Completed shares checkout/branch removed after byte verification of44deltas and all prerequisites.
- Share selected-option labels2files reviewed/transferred from provider worker; root lint/typecheck/eight coverage packages plus Office helpers passed (session99330). Main pane verified Read and download label, dialog cancelled. Temporary verification link679a4c82-343c-4030-97f5-b511c87e93e6 revoked and removed; original test DOCX preserved.
- Controlled production PPTX1/1 passed after Alice exits stale title edit and selects separate body placeholder following Bob's persisted save. Strict all-three-markers/sameUUID/reopen retained. Full production Office7 rerun underway; no host failure proven.

## Handover 2026-09-07 07:20-07:45 (Claude, after the overnight session stopped)

- Found four `codex/*` worktrees at `1fe7388` with uncommitted work and no running
  workers. Computed each worktree's delta against main and verified main's copy of
  every touched file against the seeding hashes in `/tmp/fdrive-phase-baselines`.
- `p5-provider-binding` (23 files): immutable provider-bound SFTPGo clients.
  `createIdentityClientResolver` resolves identity, provider and the exact current
  connection before any credential use; `TokenSource` takes `clientForIdentity` and
  revalidates before cache reads, mints and 401 retries; `createIdentityStorageFactory`
  returns an async, pinned storage provider used by session and API-token principals;
  login/link verify credentials through `clientForBaseUrl` captured before the call.
  No lazy client remains in `composition.ts`. Fixed two test-only typecheck errors
  (`storage-factory.test.ts` generic mock, `SftpgoError` arity) and import order.
  The integration test against two upstream servers from the spec was not written;
  binding is covered by unit tests with two fake servers.
- `p4-editor-e2e` (39 files): opt-in real-editor Playwright suite
  (`apps/web/office-e2e/**`, `playwright.office.config.ts`, `pnpm test:e2e:office`,
  `.github/workflows/office-e2e.yml`, `docs/OFFICE-TESTS.md`), plus the office
  repairs it exposed: valid blank PPTX (`pptx-parts.ts`), `LastModifiedTime` sent only
  to Collabora (`cache-version.test.ts`), queued writes resolving the current registry
  path inside the write scope (`write-file.ts`), and the preview `OfficePreview`
  fallback with an identity-bound "View in office" action.
- `p5-performance` (35 files): blocking harness (`tools/perf/**`, `apps/web/perf/**`,
  `.github/workflows/performance.yml`, `pnpm perf:strict`, `pnpm test:perf:coverage`),
  the shell height fix in `(shell)/layout.tsx` with a jsdom test, Biome exclusion of
  `tools/perf/results`, root manifest scripts and the `@fdrive/db` dev dependency.
- `p5-scope-engine` carried no worker changes (prepared checkout only).
- Integrated gates on main: lint 919 files; typecheck 13 packages plus tools; coverage
  8/8 packages plus office tools (11) and perf (100) suites; office e2e helper coverage
  18 tests 100%; integration 4/4 (DB 216, SFTPGo 47, testkit 6, API 14); Playwright
  79/79; real ONLYOFFICE acceptance 7/7 (1.5 min); real Collabora 4/4; fixture
  containers cleaned.
- Perf strict gate (`pnpm perf:strict`, quiet machine, results in ignored
  `tools/perf/results/2026-09-07T05-47-21-198Z.json`): list1kCold p95 29 ms, list1k
  p95 26 ms, uiList p95 67 ms (37 rows mounted), uiGrid p95 71 ms (130 tiles), API
  download 93.7% of direct (155 vs 165 MiB/s over 512 MiB), 200-file upload 0.48 s, all
  10,000 entries verified per sample. FAIL: search25k p95 513 ms against the 300 ms
  budget (p50 282 ms) with the amd64 TEI image under emulation on Apple Silicon.
  Budget left unchanged; production search optimization is unstarted follow-up work.
  The first run failed its settings layout check because the perf identity was not an
  admin; `tools/perf/stack.ts` now sets `FDRIVE_ADMIN_USERS` to the perf user (admin
  gates only System/account routes, none of the measured paths).
- Live pane (dev/dev on 3002): `/view/OfficeRenamed.docx` shows the office card with
  "View in office", which opened the real ONLYOFFICE viewer; `/system/indexer` scrolls
  inside the bounded shell with no horizontal overflow. The web dev server had hung at
  100% CPU after the dependency change and was restarted; the API is launched through
  `.claude/launch.json` with both `.env.dev` and `.env.office.onlyoffice.dev`.
- Not done: worktree removal (`.worktrees/p4-editor-e2e`, `p5-performance`,
  `p5-provider-binding`, `p5-scope-engine`) was blocked by the session's permission
  policy; every delta is byte-verified in main, so they can be removed with
  `git worktree remove --force` and `git branch -D codex/<name>`. Still no commits.
- Next (not started, per the "finish ongoing work only" instruction): P5-SCOPE-ENGINE,
  P5-SCOPE-CONSUMERS, the provider-binding two-server integration test, Phase 6.

## Trash chunk (started 2026-09-07 morning)

- Decision: trash is a provider capability, never fdrive-owned deleted data. Spec
  `docs/workflow/P6-TRASH.md`; SFTPGo pre-delete rename rule verified on the real 2.7.5
  container (file lands at `<trash>/<dir>/<name>/<ns>`, delete returns 200, dir deletes are
  per file, deletes under the trash are permanent, overwrites are not trashed).
- Running: `trash-core` implementer in `.worktrees/trash-core` (branch `codex/trash-core`)
  owning `packages/{core,contracts,testkit,sftpgo}`. Queued: `trash-api` (apps/api, config,
  dev seed, deploy docs) and `trash-web` (apps/web) after it integrates.
- Running in parallel: `scope-engine` implementer in `.worktrees/scope-engine` (branch
  `codex/scope-engine`) owning new `apps/api/src/scoping/**` and contracts `scopes.ts`
  plus narrow routes/index additions (P5-SCOPE-ENGINE.md). Expected trivial merge with
  trash-core in `packages/contracts/src/{routes,index}.ts`. `P5-SCOPE-CONSUMERS` stays
  queued until `trash-api` integrates because both edit search and composition.
