# Delivery history

Do not read this file in full: it is ~1,100 lines of dated snapshots kept as delivery
evidence for [architecture](../ARCHITECTURE.md), [plans](../plans/README.md),
[FOLLOWUPS](../plans/FOLLOWUPS.md) and [PERF](../PERF.md). Grep it for the specific claim
you need, or read one dated section. Nothing here is a current instruction.

Archived snapshots through 2026-09-12. Read [current STATUS](STATUS.md) and
[plans](../plans/README.md) for active work. Dates, worker assignments and incomplete labels
below describe their original handoff, not current instructions. Removed brief names are
historical identifiers; their originals remain in Git history.

## 2026-09-14 PR #23 metadata recovery review fixes

Later virtual metadata and physical Office path hooks invalidate overlapping queued targets,
including empty prefixes and directory descendants. Superseded recovery preserves snapshots
for inspection. Recovery takes identity/Office locks before job rows and rechecks invalidation
under those locks. Exact move replays remain idempotent.

The bounded revision snapshot is captured before filesystem publication; capacity failures leave
the source untouched and the operation ready. Notification delivery is a separate durable phase
after metadata commits. Failed delivery never reapplies metadata to a reused source path.

Application lint/typecheck/coverage pass (`step.WhVDBA`), including 2,242 API tests and 256 DB tests.
All 497 integration tests pass (`step.uuBMtI`), including the three review reproductions, Office
hook lock contention and concurrent metadata growth. Workflow helper regressions, lint and diff
checks pass. No native binary or storage image changed.

## 2026-09-14 Native metadata recovery

Implemented in `/private/tmp/fdrive-native-metadata-recovery`, branch
`codex/native-metadata-recovery`, from merged PR #22 (`922da2e`). Completed receipts and
metadata recovery jobs commit together; revision checks, identity ownership, transaction
rollback and bounded retries protect delayed work. [Current behavior and deployment
limits](../MACOS.md#write-configuration-and-recovery).

Application lint/typecheck/coverage pass (`step.MHu3XE` coverage); API worker coverage is
100%, and real PostgreSQL queue coverage retains the project thresholds. All 482 integration
tests pass (`step.mipVT0`), including WebDAV/SFTPGo publication with injected metadata failure,
API restart, unchanged receipts and preservation of independently recreated source files.
Workflow orchestration regressions, lint and diff checks pass.
No native binary/UI, storage image, production deployment or release changed.

## 2026-09-14 Native macOS writes: SFTPGo enforcement

- PR #21 merged as `0b32449d`. Worktree `/private/tmp/fdrive-macos-writes`, branch
  `codex/sftpgo-write-enforcement`; primary WIP preserved.
- Optional pinned SFTPGo v2.7.5 image adds cross-protocol local filesystem leases.
  Open writers prevent acquisition; expiry fences old tokens until admitted handles drain.
  Native fdrive operations retain ordinary permissions/quotas and use staged publication.
  Stock SFTPGo stays read-only. [Qualification/deployment boundary](../../integrations/sftpgo/README.md).
- PR #22 review fixes: lease control rechecks account/HTTP policy without occupying a
  transfer session; single-session uploads can renew. A distinct lease-loss response
  marker aborts scoped work as retryable, preserving ordinary file conflicts. Regression
  coverage includes response cancellation failure and same-operation desktop commit retry.
- Review-fix image build/Go race tests and source-archive comparison pass (`step.uNreN3`);
  application gates pass (`step.LRNG3O` coverage). Focused real-server regressions pass
  (`step.XeXhBK`). Docker disk exhaustion interrupted earlier fixture runs; removing only
  this worktree's disposable Go/indexer build caches restored space. No assertions relaxed.
- Complete review-fix integration gate passes (`step.paR2zQ`), including desktop
  same-operation retry after lease loss and unchanged quota/conflict protections.
- Application lint/typecheck/coverage and provider coverage pass. Pinned image builds with
  Go race tests; checked-in overlay matches its included source archive. All 470 integration
  cases pass across full/focused runs (`step.8J44Ls`, `step.24qJeG`, `step.LLerdE`): one
  disk-interrupted indexer setup passed on isolated rerun. No gates or assertions weakened.
- Seven storage/pairing browser checks pass (`step.ughPKk`); 27 Swift tests and unsigned build
  pass (`step.Rs7wZR`, `step.dVPQ71`). Isolated signed build and signature verification pass
  (`step.WVBONH`). Real Finder/TextEdit save and a competing-lease retry reach exact remote
  bytes; Finder Trash/native Restore retain bytes and IDs. All four journal entries completed.
- Final workflow gate passes all orchestration regressions, lint and diff checks.
- Test location disconnected, isolated app quit and fixture services stopped. Evidence:
  `.fdrive-workflow/evaluation/sftpgo-native-evidence.md`. Production app/connection unchanged.
- Full beta still needs metadata-effect outbox, backup reclamation/recovery administration
  and the broader failure/editor/release matrix in [the write plan](../plans/MACOS-WRITES.md).
  No production installation, deployment, release or Actions change.


## 2026-09-13 Inconsistency audit

Confirmed audit defects repaired in `codex/inconsistency-audit-20260912` from `6e9f2ce`.
Application, integration, four Python service gates, workflow and 39 browser cases pass;
live Next dev readiness/discovery and warning layouts reviewed. Integrated with main
`7462d7f`, retaining newer navigation and thumbnail accounting; integrated gates and live
dev verification pass. Committed to local main on user request; unrelated WIP preserved.
[Dispositions, compatibility decisions and evidence](INCONSISTENCY-AUDIT-2026-09-12.md).

## 2026-09-12 MCP access and file management

Implemented on `feat/webdav-provider` from `1f045c1`, uncommitted at delivery. The
[review](MCP-REVIEW-2026-09-12.md) records the original defects; current behavior lives in
[MCP.md](../MCP.md), [AUTH.md](../AUTH.md) and [SCOPING.md](../SCOPING.md). All four authorized
stages are implemented; the completed acceptance plan was removed.

- New tokens select one linked login, Read/Organize/Full mode and normalized folder grants.
  Migration `0004_mcp_token_access` adds nullable access JSON; old tokens retain verified-index
  rules and the legacy global write flag. New grants independently govern direct provider
  access; index results additionally intersect verified mappings and live read proofs.
- Direct original/text/image reads, live metadata, copy, text creation, bounded base64 upload,
  SHA-256 text replacement, recoverable Trash/restore, tags, favorites and visual search.
  Optional byte-based document extraction works without mounted index roots. Shared REST/MCP
  move/copy admission prevents occupied-target replacement and descendant moves; completed
  storage operations report metadata/history failures as warnings. Trash exclusions, path
  links, pagination and search status are repaired. Next dev routes `/mcp` at the web origin.
- `application` passes: lint, typecheck and all workspace, Office, performance and deployment
  coverage gates with unchanged thresholds. Coverage log: `.fdrive-workflow/logs/step.dc0Vla`.
  The new token tests were split by behavior after a combined dialog test exceeded 5 seconds
  under suite load; both scenarios pass, including selected login and Full folder grants.
- `integration` passes: five package suites, including 40 API tests and real SFTPGo/WebDAV MCP
  HTTP workflows. Occupied destinations survive; post-write audit failure returns success
  with a warning; unindexed WebDAV supports create/read/edit/copy/move/Trash/restore;
  out-of-folder access and revoked tokens are denied. Log: `.fdrive-workflow/logs/step.ab6FpI`.
  An old write fixture was corrected to request Organize after the new Read default denied it.
- `browser e2e/account.spec.ts --workers=1` passes (2 tests). The UI-created Full token is used
  through the web-origin `/mcp` for create/read/tag, denied outside-folder creation and
  revocation. Real disposable SFTPGo/PostgreSQL/API/Next dev stack; token form screenshot
  inspected at `apps/web/test-results/account-alice-creates-an-A-20b5a--shows-it-and-can-revoke-it-chromium/token-permissions.png`.
  Log: `.fdrive-workflow/logs/step.J82DOv`.
- `python indexer` passes Ruff, mypy and Docker coverage/inotify: 539 tests, 95.24% coverage,
  including actual PDF extraction. Log: `.fdrive-workflow/logs/step.5zDKpZ`. Earlier runs were
  blocked by a full Docker virtual disk (PostgreSQL initdb and image build reported no space);
  unused build cache was reclaimed, retaining images, containers and data volumes.
- `workflow` passes all six orchestration regression scripts, syntax checks, lint and diff
  check after delivery documentation cleanup. Logs remain under `.fdrive-workflow/logs/`.
- Limits: 4 MiB original files/uploads/replacements, optional extraction dependencies, bounded
  index/Trash scans with partial status, and no atomic edit compare-and-swap against other API
  processes or external clients. No permanent deletion/public sharing. External hosted-client
  connectivity and production deployment were not tested; the local HTTP/SDK/browser paths were.
- Unrelated System activity planning and `.playwright-mcp/` remained untouched.
- PR preparation on `codex/mcp-access-management` integrates `main` at `08cc98c`. Conflict
  resolution retains both sets of token/indexer tests and handoff sections; the new extraction
  client also adopts main's cancellation of HTTP error bodies.
- After integration, lint/typecheck and every application coverage suite pass. Full coverage
  ran with `turbo run test:coverage --concurrency=1 -- --maxWorkers=2`, followed by all Office,
  performance and deployment suites, retaining thresholds (`.fdrive-workflow/logs/step.tleIzW`).
  Standard runs hit search-panel/Office-action timing failures under a load average near 35;
  both suites pass with reduced concurrency. No test or threshold was relaxed.
- Integration: four package suites and 37 API tests pass in `.fdrive-workflow/logs/step.EVuROm`;
  composition's three tests did not run because its disposable database stopped during setup.
  All three pass on the isolated rerun (`.fdrive-workflow/logs/step.6R6nBO`). The full helper run
  remains recorded as failed; the suites are verified across these two runs.
- Post-integration browser: 2 account tests pass (`.fdrive-workflow/logs/step.4nA8f5`). Indexer:
  551 tests, 95.22% coverage, Ruff and mypy pass (`.fdrive-workflow/logs/step.p1mcKn`). Workflow:
  all six regression scripts, syntax, lint and diff checks pass. No deployment performed.
- Conflict refresh after System activity PR #14 merges `main` at `b38690e` into PR #13.
  Only STATUS and this history conflicted; both features' delivery records are retained.
  Workflow and workspace typechecks pass, as do 308 focused MCP/token/activity API tests and
  five composition/MCP storage integration tests (`.fdrive-workflow/logs/step.BJW7bg`). A host
  watcher test required Linux's libc; the supported indexer Docker gate passes all 558 tests
  at 95.45% coverage, with Ruff and mypy passing (`.fdrive-workflow/logs/step.igPQs8`).

## 2026-09-12 System sidebar activity

Implemented in `/private/tmp/fdrive-system-activity`, branch `codex/system-activity` from
`1f045c1`; verification completed before PR publication. Durable design: [SYSTEM-ACTIVITY.md](../SYSTEM-ACTIVITY.md).

- Added admin-only activity aggregation, one five-second sidebar query, mutation feedback,
  per-feature worker counters, stable rebuild inventories and explicit terminal outcomes.
  Fixed workloads show weighted percentages below 100 while running; unknown totals stay
  indeterminate. Disabled/idle, waiting, unavailable and error states are distinct.
- Passed helper profiles: `application`, `integration`, `python indexer` (543 tests, 95.44%
  coverage including Linux inotify), `python ocr`, final `package @fdrive/web`, `workflow`,
  and `browser system-activity.spec.ts system.spec.ts features.spec.ts office-settings.spec.ts
  system-storage.spec.ts --workers=1` (20/20). Application and integration logs:
  `.fdrive-workflow/logs/step.XrYvyd/`, `step.KQnrXp/`; final browser: `step.bG0L4h/`.
- Real Next dev + PostgreSQL + SFTPGo + Python indexer smoke generated 240 previews and
  rebuilt 120 actual images with zero errors. Observed percentage, navigation and completion;
  evidence in `.fdrive-workflow/live-activity/`. Intercepted browser tests separately cover
  reload, offline recovery, non-admin isolation, keyboard tooltip semantics and reduced motion.
  Reviewed settled light/dark/mobile screenshots in `apps/web/test-results/`.
- Initial test runs exposed a full Docker disk, a shared test-image tag race, outdated route
  expectations, broad text selectors and a missing tooltip role. Resolved without weakening
  gates. The Docker helper now runs its own immutable image ID. OCR/clear pre-inventorying
  remains optional; no completion percentage is invented for those jobs.
- Rebased for PR publication onto `08cc98c`, preserving newer OCR lock cleanup and thread-start
  failure handling. Revalidated OCR and indexer (555 tests, 95.42% coverage), application lint,
  types and full coverage, integration, and all 20 affected browser cases. Reduced concurrency
  resolved six UI test failures;
  reclaiming unused Docker build cache resolved PostgreSQL disk exhaustion. Gates unchanged.
  Rebase coverage, integration and browser logs: `.fdrive-workflow/logs/step.df59I2/`,
  `step.KkEREI/`, `step.PutGbj/`.

## 2026-09-11 WebDAV storage provider, slices 1–4 (PR #5)

Branch `feat/webdav-provider`, PR #5. The plan was removed when slice 5 landed; see [WEBDAV.md](../WEBDAV.md).

- **Done (slice 1)**: `packages/webdav` (`@fdrive/webdav`) with the protocol client
  (`PROPFIND`/`GET`/`PUT`/`MKCOL`/`MOVE`/`COPY`/`DELETE`, Basic auth per request, manual
  redirects refused, bounded multistatus parsing over `fast-xml-parser`), the `OPTIONS` probe,
  and an in-memory class 1 fake server in `src/fake` (prefix, href and namespace styles,
  ranges, `If-Range`, `If-None-Match: *`, `Overwrite`, `X-OC-Mtime`, read-only users,
  redirect and no-`DAV` toggles). Lockfile updated through `run-in-checkout.sh --lock`.
- **Done (slice 2)**: `createWebdavStorageProvider` (own-property methods over the client, core
  path normalization, `WebdavError` → `StorageError` with 409 on `MKCOL`/`MOVE`/`COPY` read as a
  missing parent, `mkdir -p` that recurses only on a missing parent, `deleteFile`/`deleteDir`
  refusing the wrong kind) and `webdavModule` (username/password credential, no config, only
  `atomicMove` true, `trash: "none"`, `authenticate` as `PROPFIND` Depth 0 on the root,
  storage bound to the identity's username rather than the stored credential's). The shared
  `describeStorageProvider` suite passes over the fake three ways: plain, under a path prefix
  with absolute hrefs, and with a default namespace.
- **Done (slice 3)**: `ProviderType` gains `webdav`; the API registry, `@fdrive/api`
  dependency and lockfile, web label ("WebDAV") and icon (`Globe`) are wired. New API tests:
  admin create/probe/list of a WebDAV row with its form and capabilities, refusal of undeclared
  config, public listing without the endpoint, a login through a WebDAV row that never touches
  the SFTPGo fake, and a same-path isolation test with one SFTPGo and one WebDAV identity on
  one account (each server sees only its own credential). `deploy/compose.dev.yaml` now
  enables SFTPGo's WebDAV binding on `FDRIVE_DEV_SFTPGO_WEBDAV_PORT` (default 58082) as the
  dev target.
- **Done (slice 4)**: `startSftpgo` in the testkit now enables SFTPGo's WebDAV binding and
  returns `webdavUrl`; `packages/webdav/test/integration/container.contract.test.ts` runs the
  shared conformance suite plus probe/authenticate, denied-write (`forbidden`), same-path
  isolation between two logins, and range/stale-`If-Range` checks against it. The real server
  answers 403 for a `MOVE`/`COPY` of a missing source, so the adapter now stats the source on a
  refusal and reports `not_found` when it is gone (unit-tested on the fake). The e2e stack
  exports `E2E_SFTPGO_WEBDAV_URL`; the new `e2e/webdav-provider.spec.ts` adds the WebDAV
  binding through System > Storage (type picker, probe, remove) and signs in through it,
  browses the seeded home, uploads a file and checks the login's capabilities. The login row is
  disabled rather than removed afterwards (a login binds it), and `system-storage.spec.ts`
  now counts cards relative to what is present.
- **Confinement**: request URLs are built only from provider paths under the endpoint prefix;
  `assertValidPath` rejects `.`/`..` segments because the URL parser resolves dot segments
  (a `/../etc` path reached the origin root before this check) and `buildUrl` re-verifies
  the prefix. Hrefs on another origin or outside the prefix are dropped, never followed.
- **Evidence (slice 3)**: `application` passes (lint, typecheck, workspace coverage).
  `integration` ran 14 API suites: 13 pass, `sftp-rename.test.ts` failed on its own
  `docker build` of the indexer image hanging on the `python:3.12-slim` metadata fetch, the
  pre-existing flake recorded in history (Docker Hub was unreachable from this machine during
  the run). `browser e2e/login-providers.spec.ts e2e/system-storage.spec.ts --workers=1`
  passes. `workflow` passes. Real dev app over SFTPGo's WebDAV binding, through the API on
  the running stack: candidate probe ("reachable and requires a login"), row created, alice
  logged in with `providerType: webdav` and only `atomicMove` true, list, upload with parents,
  download, byte range (206), rename to a Unicode and literal-percent name, directory copy,
  recursive delete, and `unsupported` from zip and share creation; SFTPGo's REST API saw the
  same files. Earlier slice evidence: `package @fdrive/webdav` (220 tests, coverage
  99.6/99.5/100/99.7).
- **Manual browser pass** (production build `next start` on the dev stack, over SFTPGo's
  WebDAV binding): sign in through the WebDAV row, list, new folder, new text file, view,
  edit and save, rename, duplicate, per-file download for a multi-selection (no zip), delete
  with the permanent-deletion warning, and as admin the Storage card (WebDAV label, globe,
  address, "Reachable", only "Atomic move"), add a second WebDAV row through the dialog
  (candidate probe), and remove it. It found one real defect, fixed in the client: SFTPGo
  gzips `text/*` bodies when the client accepts compression, Node's fetch accepts and decodes
  transparently, so `GET` reported the encoded `Content-Length` (23 bytes for an empty file)
  over a decoded body and the API's download closed early. The client now sends
  `Accept-Encoding: identity` on every request and drops the declared length when a response
  is still encoded. Two pre-existing issues seen on the way, not WebDAV's: the Base UI
  `Select` trigger shows the raw value (row id, `webdav`) rather than the option label in the
  login and Add-provider pickers, and a non-admin can open `/system/*` by URL (the sidebar
  hides it; the API refuses with 403 and the page shows an empty state).
- **Limitation**: `next dev` on this machine does not hydrate any page (checked on three dev
  servers, including other sessions', with headless Chromium; no console or page errors, the
  HMR websocket handshake fails in browsers only); the manual pass above used a production
  build instead. The shared dev database also had to be reset
  (`pnpm dev:env:reset`): its ten recorded migrations predated this branch's four-entry
  journal, which is `main`'s state, not a WebDAV change.
- **Evidence (slice 4)**: `package @fdrive/webdav` passes; `@fdrive/webdav test:integration`
  19/19 against the SFTPGo WebDAV container; `@fdrive/testkit test:integration` 10/10;
  `browser e2e/webdav-provider.spec.ts e2e/login-providers.spec.ts e2e/system-storage.spec.ts
  --workers=1` passes 7/7.
- **Not done at this snapshot**: Trash through generic move (slice 5); it landed on 2026-09-12
  (see current STATUS). GitGuardian on PR #5 flags two fake test passwords in an
  earlier commit's history; the current tree no longer contains those patterns, and history
  is not rewritten here, so the incidents need dismissing in the GitGuardian dashboard.

## Latest handoff: command helpers (2026-09-08)

- Implemented `command-lib.sh`, `run-in-checkout.sh`, `setup-checkout.sh`,
  `prepare-worktree.sh`, `verify.sh`, and `test-command-helpers.sh`. Existing review/merge
  interfaces preserved; existing regression harness now uses portable temporary directories.
- WORKING is policy/models (813 words); COMMANDS holds recipes, profile choices, requirements,
  and troubleshooting. Agent instructions reference helpers. Runtime state is ignored by
  Git/Biome/Docker. Product MCP UI/docs, source, manifests, and lockfile unchanged.
- Runtime: newest installed stable Node 24 from PATH/nvm, exact installed pinned pnpm;
  explicit overrides supported. Setup refuses incompatible existing dependency stores,
  installs noninteractively with frozen lockfile, builds/links but never runs migrations.
  Setup/gates share per-checkout locks; interruption/failure paths have regression coverage.
- Integrated `verify.sh <root> workflow` passed: 28 helper regression groups, 16 existing
  orchestration groups, shell/TOML parsing, lint (1,043 files), diff check. Doc links/recipe
  syntax passed. Default runtime smoke selected Node 24.20.0 and pnpm 10.11.0.
- Real setup passed with Node 24.20.0 and permissions for the existing pnpm store: both frozen
  installs, DB build, declared binary/link verification. No migrations run. Real core profile:
  lint/typecheck + 292 tests; functions/lines 100%, branches 99.64%.
- Both workers integrated as reviewed uncommitted changes; complete transfer verified and
  temporary checkouts/branches removed. No workers active. Changes uncommitted on main at
  `98234ec`. Application-wide/Docker/browser suites not run for this tooling-only change.

## Earlier handoff: workflow docs (2026-09-08)

- `WORKING.md` shortened from 1,986 to 1,375 words; shared rules and copyable setup,
  worktree, review/merge, tests, Python, and dev-server recipes; technical lessons retained
  in `PITFALLS.md`. Follow-up: consolidated model/agent setup in WORKING, removed the
  obsolete runtime guides, duplicate agent definitions, and legacy launcher.
- User-confirmed worker default: `gpt-5.6-sol`, high reasoning; complex-work override
  `gpt-6-astra`, high.
  Project config uses explicit defaults; role instructions use package scripts.
- Validation: 16 workflow regression groups; shell/TOML parsing; local links and Bash recipe
  syntax; lint checked 1,043 files, clean; `git diff --check` passed. Homebrew pnpm's version
  switch failed registry verification; installed pnpm 10.11.0 ran lint under Node 24.20.0.
- Docs/config only; application suites not run. Fresh-session role/model loading remains
  unverified. One worker removed obsolete ignore entries; reviewed diff transferred without
  commits, temporary worktree removed. Development instructions/config contain no legacy
  agent references; product MCP UI/docs unchanged. Changes uncommitted on main at `98234ec`.

## Removed sections (pruned 2026-09-11)

In-flight session narrative from 2026-09-07 and earlier was removed: worker assignments,
queued chunks and next-step lists that later handoffs superseded, all citing specs that no
longer exist. Verified outcomes from that work are recorded in their own dated sections
below; the trash design decision lives in [TRASH](../TRASH.md). Full text remains in Git
history at d9e3a7e and earlier. Removed: Historical state (2026-09-07), Delivered, Validation, Next, Preserved Codex migration, Handover 2026-09-07 07:20-07:45 (after the overnight session stopped), Trash chunk (started 2026-09-07 morning).

## 2026-09-08 Phase 5 closure

- User goal: search25k p95 <300 ms (last 513 ms), plus specified provider-binding two-server integration coverage.
- Clean starting HEAD `a761f82`. No commits requested; reviewed changes transfer uncommitted.
- `p5-search-latency`, `.worktrees/p5-search-latency`: Astra/high implementer, initial measured diagnosis only; production scope assigned after evidence. Preserve real TEI/model, budgets, ranking, identity scoping and live-read authorization. Primary runs final quiet strict gate.
- `p5-provider-integration`, `.worktrees/p5-provider-integration`: Astra/high test-writer; owns new `apps/api/test/integration/provider-binding.test.ts` and dedicated helper files only. Two actual HTTP servers, same username/path, sanitized observations; switches before cached token, during mint, between binding/execution, before retry, native and API-token requests. B receives no A credentials or mutation. No production changes without reassignment.
- Resumed: previous turn yielded progress (13 tests + complete profiler); no profiler remains running. Main advanced independently to `ccbca81` (role model pins only), preserved.
- Provider tests reviewed; API package 1773 tests and focused integration 13 pass. Pending uncommitted transfer and target gates.
- Current real search baseline p95 1410 ms; instrumented p95 1243 ms. Stage p95: TEI 642, filename SQL 208, fulltext 187, file probes span 306, directory listing 217. Artifacts in search worktree ignored results and `.fdrive-workflow/search-profile.json`.
- Production overlap approved: `search/service.ts` + tests, Sol/high implementer in existing search worktree. Keyword SQL overlaps embedding; folder authorization overlaps file authorization. Preserve ranking/all live checks. Primary investigates TEI threading separately.
- Provider integration's 3 reviewed files transferred and byte-verified to main, uncommitted.
- Target application lint/typecheck passed. Initial sandbox run denied existing local HTTP listeners; permitted rerun passed those but two existing 5000-entry archive tests timed out under concurrent suites. Next target application uses `TURBO_CONCURRENCY=1`; no lowered coverage/timeouts.
- Search overlap diff reviewed (2 files, focused service 35/35); worker package gates pending. TEI isolated diagnosis in `.worktrees/p5-tei-runtime`, Sol/high; no model/image changes authorized, initial ignored CPU-thread comparison only.

- Search overlap transferred to main and byte-verified; API package 1775 tests passes. Main dev API auto-reloaded.
- TEI exact-image comparisons (100 requests, 96 unique queries, vectors bit-identical): default p95 323 ms; quota2 512; quota1 871; cpuset1 989; tokenization/RAYON/OMP/MKL=1 663. CPU tuning rejected. Investigating official native ARM same-model runtime because emulated TEI alone exceeds total budget; no model change.

## 2026-09-08 Phase 5 verification

- Target application gates passed with `TURBO_CONCURRENCY=1`; integration 4/4 passed (DB 238, testkit 9, API 33 including new provider-binding 13, SFTPGo 57). Affected browser tests 12/12 passed. Live dev search returned README and Enter opened its rendered preview.
- Phase 5 resumed: main real `perf --only search25k` measurement in progress (`/tmp/fdrive-p5-search-current.log`). Provider-binding 13 tests remain integrated; target application/integration/browser logs reconfirmed passing.
- Worker job `40bc268cdd704b47a6c42b8caf791b8e` owns ignored native-TEI diagnostic artifacts in `.worktrees/p5-tei-runtime`, official source revision `4150561d42c495fe95f2aebb57fbb602c13ff4e6`, same multilingual-e5-small. Builds/benchmarks wait for current measurement; no production runtime changes yet.
- Current main amd64 diagnostic: search25k p95 765.7 ms, p50 466.5, zero errors (`tools/perf/results/2026-09-08T07-39-18-359Z.json`).
- Native ARM64 official TEI build succeeded. Same-model 100-request comparison: embedding p95 17.0 ms, p50 8.4; max vector difference 1.06e-7, minimum cosine 0.999999999999885. Worker corrected the reused benchmark helper's stale amd64 image label; launch/build logs prove native image.
- Native runtime wiring in worker: pinned source recipe plus ARM Compose override, truthful perf runtime metadata. First real search p95 311.4 ms, p50 212.5, zero errors (`.worktrees/p5-tei-runtime/tools/perf/results/2026-09-08T07-55-30-057Z.json`), still fails300. Review followup adds coverage for runtime selector, confines worker umask adjustment to ignored launcher, and profiles remaining stages. No budget/model/data/auth changes.
- Reviewed six native-runtime files transferred to main and byte-verified. Primary perf-tool coverage100%, typecheck:tools pass; dev/core Compose override comparison confirms inherited model/volumes/security unchanged. Clean pinned Git-context native build passed; archive Docker context rejected and replaced. Source revision unchanged.
- Native stage profile p95404ms (instrumented): directory-list p95176ms for25000 entries; file probe span262ms; filenameSQL159ms. Approved bounded directory-read proof: require complete first JSON entry or empty array, cancel remaining metadata; never accept200/`[` alone, no file check/concurrency/cache changes. Worker owns core optional port, SFTPGo client/provider/authorizer plus tests; runtime files frozen. Existing two-server integration baseline copied and hashed in `/tmp/fdrive-p5-probe-baseline.json`.
- Bounded directory probe worker gates: SFTPGo414 tests, API1778, provider-binding14 pass. Diagnostic median173.5ms/p95314ms. Stage profile: directory p9523ms, file span144ms, filenameSQL147ms. Primary review found falsy stream rejection could allow access; worker correcting fail-closed handling before integration.
- Approved final latency change in service.ts/tests: per-fanout candidate metadata/read probes overlap remaining SQL, request-local kind/path memo only, final metadata/path revalidated. All candidate checks, limits/ranking/scopes and six-probe concurrency preserved. No root integration of probe/pipeline until reviewed and gated.
- Final worker turn9 reviewed and transferred uncommitted: bounded fail-closed directory probe plus content-fanout read checks overlapping filename SQL. Final metadata/path checks and rejection/partial semantics preserved; irrelevant old-path failures do not affect final results. Provider integration now14 cases. Frozen runtime and transfer baselines byte-verified. Worker idle.
- Independent target application passed (API1787, SFTPGo416, core292; full lint/typecheck/coverage). Initial integration had an unrelated PostgreSQL teardown57P01 after238 DB assertions passed; serial package rerun passed all4 suites (API34, DB238, testkit9, SFTPGo57). Affected browser12/12 pass. Final quiet full perf:strict running; no latency pass claimed yet.
- Phase5 goals verified complete: full strict gate PASS, all budgets, zero scenario errors. Search25000: p50 129.48ms, p95 195.82ms (<300), p99 211.14ms,100 measured requests/20 warmups. Result `tools/perf/results/2026-09-08T08-50-55-358Z.json`; log `/tmp/fdrive-p5-final-strict.log`. Same multilingual-e5-small/384 dimensions, native ARM source4150561d42c4, Apple M3 Pro.
- Dev embed recreated with the verified ARM Compose override, health200. Live search readme returned filename/content results; Down/Enter opened rendered README preview. Changes remain uncommitted; worker worktrees retained with saved evidence/copied prerequisites, no active worker.

## 2026-09-08 Search and file browser UX

- User authorized six improvements. Clean baseline e922bb4; no commits requested.
- Prepared ux-search-unified and ux-file-controls isolated worktrees, codex branches. Implementers; specs UX-SEARCH-UNIFIED.md and UX-FILE-CONTROLS.md define disjoint ownership and gates. Search owns panel/query/filter/browser search tests; file controls owns reveal/list/grid/toolbar/sidebar and new browser spec.
- Primary will review actual diffs, transfer uncommitted, run application + affected browser gates and real dev UI verification. No production changes yet.
- Running jobs: search ec88944899ee4733811070c77dfad906; file controls a1280db7231c45e38144756470f3d595. Both initialized in separate prepared checkouts. Main dev web verified running from main checkout on3002.
- Search initial pass: worker reports web1440 tests + browser12 pass; primary rejects integration pending independent failure states (text-unavailable must not suppress images), zero-hit partial/filter notices, and short-viewport bounds. Same job turn3 fixing, no model switch.
- File-controls initial pass incomplete: scoped CLI denied relative test wrapper. Same job turn2 correcting command invocation and primary review: one-shot repeatable reveal requests, meaningful24px thumbnails, toolbar visibility wiring, shared download handler, regression browser coverage. No permission expansion.
- Worker quota exhausted on both workers (search turn4, controls turn2): CLI says individual quota resets in~2h40m. No fallback used. Changes preserved in worker checkouts; no application transfer to main yet.
- Primary independently ran browser gates: controls6/6 PASS (`/tmp/fdrive-ux-controls-browser.log`); search/mobile/account23/25 PASS (`/tmp/fdrive-ux-search-browser.log`). Two SEARCH TEST defects: 700px sheet height799.999969 vs exact800 at search.spec.ts277 (use approximate comparison); landscape-notes.txt locator matches basename and path at377/386 (use exact:true). Actual UI shown correctly in failure evidence. Search package gate final worker output passed; controls package passed.
- Primary review additionally found two forbidden `any` casts in new virtualizer mocks (file-list.test.tsx and file-grid.test.tsx); replace with typed Parameters<typeof actual.useVirtualizer>[0] or typed generic mock. Remaining tests need authorized worker or explicit primary-test-edit exception; async question sent to user, not yet answered.
- Scope reviewed: search files + test-only placeholder updates in mobile.spec.ts/account-identities.spec.ts; file-controls owned scope clean after browser teardown. Temporary e2e shadow folders only during harness run, not deliverables. New source/helper/test files inspected. Repeat reveal uses consumed token, selected download shares keyboard helper, list thumbnails24px using supported256px endpoint, sidebar scoped group/menu gaps.
- Real dev search UI verified in temporary search-worktree web server on3004, existing main API3001: query "a warm orange sunset" renders text/filename results plus sand.png visual match without mode switch. Main web3002 remains unchanged. Temporary server session97717, log `/tmp/fdrive-ux-search-dev.log`; stop after target integration. No target application/browser integration gates yet; final worktree cleanup pending transfer+verification.
- User explicitly authorized primary to finish both chunks directly and merge all. Primary fixing test selectors/geometry tolerance and typed virtualizer mocks, strengthening repeated reveal to preserve the mounted page. Commits and merges now authorized; no new workers required.
- Completed and merged both chunks into main: file controls 1adae0e via 1a17b18; unified search d4accea via 5b17152. All six requested improvements implemented. Primary reviewed source/new files and corrected remaining tests directly under user authorization.
- Final target application PASS: lint, typecheck, full coverage (`/tmp/fdrive-ux-final-application.log`). Workflow profile PASS (`/tmp/fdrive-ux-workflow.log`). Combined search/file-controls/mobile/account/grid browser suite31/31 PASS (`/tmp/fdrive-ux-all-browser-verified.log`). Thumbnail persistence test now uses a decodable PNG and scoped thumbnail response because the test harness fake indexer never generates thumbnails; verifies actual decode before and after reload, not merely an img element.
- Real main dev app3002 verified: simultaneous filename/content/visual results, selected-file reveal with URL cleanup, multi-selection Download toolbar, persisted colorful list thumbnails, compact sidebar. Temporary worktree server3004 stopped; existing main servers retained.
- UX worktrees clean and fully integrated before removal; older P5 worktrees untouched. Unrelated generated apps/web/CLAUDE.md preserved outside Git at `.fdrive-workflow/preserved/ux-search-unified/apps/web/CLAUDE.md`. No push requested; no outstanding UX implementation work.


## Handoffs archived during plan cleanup (2026-09-11)

Historical snapshots below may contain superseded status or removed brief names.
Current work is in [STATUS](STATUS.md); unfinished work is in [plans](../plans/README.md).

# Archived handoff snapshot

Updated: 2026-09-11. Owner: primary agent.

## Provider developer guide (2026-09-11)

- Added [Adding a storage provider](../STORAGE-PROVIDERS.md), checked against current source:
  packaging, typed module example, authentication, storage semantics, registration, UI maps,
  capability boundaries, lifecycle/isolation rules and fake/real-backend verification.
- Removed five obsolete P10 design/chunk plans, including speculative WebDAV/owned-share
  APIs. Current limitations remain explicit in the guide; README, developer/contributor docs,
  AUTH and PLAN link there. Existing isolation corrections were carried into the guide.
- Docs only; existing application, test and pentest edits preserved. Passed workflow gate,
  guide link/anchor checks and example typecheck against current core interfaces.

## P10 prerequisite merged and PR rebased (2026-09-10)

- PR #3 merged into main (`46228b5`); PR #1 rebased onto that main revision.
  The obsolete migration-squash commit was dropped; the final rebased Git tree exactly
  matches the previously verified PR tree. Application/integration/browser checks remain
  applicable; no application code or migration content changed.
- PR #3's CI application job had an unrelated failure in the unchanged session maximum-age
  test (`expected true to be false`); local schema and DB checks passed. Normal merge used,
  without overriding branch protections. PR #1 now targets main.
- Local uncommitted edits preserved byte-for-byte; pre-rebase history retained on
  `codex/p10-before-rebase`. Publication uses a lease against the previous remote PR head.

## P10 PR reduction follow-up (2026-09-10)

- Prerequisite [PR #3](https://github.com/fredrikburmester/fdrive-web/pull/3),
  `codex/migration-baseline`, squashes only the existing main schema. P10 is stacked on it;
  `0001_storage_providers` contains four provider columns and the Office FK cascade.
  Merge the prerequisite first, then retarget PR #1 to main.
- Shared web identity/account fixtures, provider-service fixtures and named route rejection
  cases remove another 218 net application lines; existing refactor included. Combined
  reduction: 1,433 net application/package lines versus published revision `4ffd14b`.
- Exact PostgreSQL schema comparisons pass for old main versus baseline and old P10 versus
  baseline plus delta (column order ignored); custom indexes and schema version preserved.
  Baseline workflow and DB integration pass (259 tests).
- Clean committed P10 checks pass: application, integration (DB 267, API 35, SFTPGo 72,
  testkit 9), production browser 29/29, actual Next dev storage flows 3/3. Workflow passes.
  One initial integration run hit a Docker port-binding timeout; serialized rerun passed
  without changing limits. Logs in `.worktrees/p10-reduction-check/.fdrive-workflow/logs/`:
  `step.UKxwAQ` (coverage), `step.YLUGwZ` (integration), `step.IVR2EN` (production browser),
  `step.AIvzaX` (dev browser); initial timeout `step.u9KrXC`.
  Schema-comparison artifacts: `/private/tmp/fdrive-pr-reduction/`.
- Pre-existing isolation, Playwright and pentest edits remain uncommitted and unchanged.
  Checkouts: `.worktrees/migration-baseline`, `.worktrees/p10-reduction-check`.

## P10 PR reduction (2026-09-10, verified)

- Implemented directly on `claude/p10-storage-providers`; existing isolation and pentest
  edits preserved. Refactor committed on request; no push requested.
- Canonical memory storage lives at `@fdrive/core/testing`, re-exported by testkit; its
  tests moved with it. Shared HTTP dispatch, derived request schemas, SFTPGo user runner,
  setup guard/claim persistence, provider fixtures, mutation invalidation and field inputs
  replace repetition. Removed unused browser action sets; table-driven form tests.
- Recovery fixed unfinished JSX/type errors and restored memory move conflicts, bounded
  probe streaming, setup race/restart tests, and unchanged query invalidation behavior.
- Plan adjustments: kept endpoint comparisons and post-login ownership rechecks (isolation),
  the explicit setup login entry point, and capability props (avoid a query subscription
  per file row). Kept separate conformance cases and simple dialog state/copy; extra helpers
  there add indirection without meaningful savings. Kept typed repository patches and config
  copying. Configuration validation moved to service.
- Passed: application (lint, types, all coverage); final API/core package rechecks;
  integration (DB 267, API 35, SFTPGo 72, testkit 9); affected production browser 16/16;
  real Next dev storage flows 3/3. No gates lowered.
- Evidence: `.fdrive-workflow/logs/step.6shFUF/` (application coverage), `step.7cJuDQ/`
  (final API), `step.ZJmbzL/` (final core), `step.qGPRxL/` (integration), `step.BSK3fD/`
  (production browser), `step.U16joC/` (dev browser). Roughly 1,100 net application/package
  lines removed versus HEAD, counting new shared fixture/tests and existing follow-up edits.

## P10 validated PR follow-up (2026-09-10)

- Branch `claude/p10-storage-providers`, uncommitted: environment endpoint comparisons
  ignore trailing slashes; seeding preserves the pinned row, address, enabled state and
  identities. Environment administrator checks use the same comparison.
- Shared-database Playwright tests now run serially by default. The memory identity fixture
  serializes provider updates with login/link, with deterministic regressions for both.
- Passed: application (lint, typecheck, all coverage); integration (API 35, DB 267,
  testkit 9, SFTPGo 72); auth/login-provider/storage browser flows 9/9 using the default worker count.
  Application used `VITEST_MAX_WORKERS=1` and `TURBO_CONCURRENCY=1`; initial sandbox server-listen
  failures and a parallel large-ZIP timeout were resolved without changing test thresholds.
- Evidence: `.fdrive-workflow/logs/step.qa54GC/` (coverage), `step.lsI3mN/` (integration),
  `step.fs6adu/` (browser). Unrelated pentest/report edits remain separate.

## P10 provider isolation review fixes (2026-09-10)

- Branch `claude/p10-storage-providers`: env administrator grants now require the configured
  SFTPGo endpoint; remote providers require explicit index mappings; PostgreSQL row locks
  serialize address changes with verified login/link persistence; a durable setup marker
  preserves access after disabling the final provider.
- Regression coverage includes all four findings, stale verified credentials and concurrent
  first login/link versus address changes on real PostgreSQL, plus disable/reload/re-enable
  through the storage UI. Provider-binding integration fixtures now declare their env admin
  endpoint and indexed scope explicitly (mock indexer directory; two distinct HTTP upstreams).
- Passed: workflow, final lint/typecheck; coverage for all eight packages and Office/perf/deploy tools;
  integration suites (SFTPGo 72, testkit 9, DB 267, API 35); affected production browser flows
  12/12 and real dev-app storage flows 3/3. Initial parallel coverage timed out in a large-trash fixture; serial package runs
  passed with existing thresholds/timeouts. Integration fixture failures passed after correction
  in a targeted 14/14 provider-binding rerun.
- Evidence: `.fdrive-workflow/logs/step.Zmlmif/` (web coverage), `step.t6aNoB/` (other coverage),
  `step.tgdZzi/` (integration), `step.bPWhf5/` (binding rerun), `step.2CEHHN/` (browser),
  `step.Gp718l/` (dev browser).
- Unrelated pentest edits and `PR-REVIEW-FINDINGS.md` remain outside this change.

## P10 storage providers: A2 capabilities in the web (implemented 2026-09-10)

- Current reference: [provider guide](../STORAGE-PROVIDERS.md#5-enable-only-supported-features). The file browser, login and account halves were done in the main checkout
  (commit `9b89489`); System > Storage came from one `implementer` worktree
  (`claude/p10-system-storage`) transferred with `transfer-checkout.sh` after rebasing it onto
  that commit.
- Delivered: `lib/identity/capabilities.ts` (`capabilitiesFor`, `anyLoginCan`, `browserActions`,
  `planDownload` in `lib/files/download.ts`); one `capabilities` prop on the context menu,
  toolbar, list, grid, virtual listings and Inspector; sidebar Shares/Trash as the union across
  logins with a per-type `ProviderIcon`; login page over `GET /providers` with
  `ProviderFieldInputs` and a `ProviderPicker` for several providers; Add/Remove login dialogs
  rendering the provider's fields with relabelled confirmation fields; scope card gated on
  `scopeMapping`; provider-neutral scope copy; `/system/storage` (list, add, test, edit,
  enable/disable, remove) and General reduced to server address + Trash; Trash settings save
  now invalidates `auth.me` so the capability follows the setting.
- Passed on `main`: web unit suite with coverage; `application` for the first half; browser
  (`--workers=1`) `auth`, `login-providers`, `about`, `account-identities`, `account-scope`,
  `smoke`, `file-controls`, `trash` 21/21 on the first half, and in the worker worktree
  `system` + `system-storage` 13/13 (real API and SFTPGo). After the transfer, on `main`:
  `application` (lint, typecheck, coverage) and browser `system`, `system-storage`,
  `login-providers`, `features` with `--workers=1`, all passing; `workflow`.
- Known: no capability can be false for an SFTPGo login except `trash`/`office`/`index`/
  `scopeMapping` through configuration, so the per-flag hiding is covered by component tests
  (`capability-gating.test.tsx`), not browser specs. WebDAV and owned shares remain unimplemented; see
  [current limits](../STORAGE-PROVIDERS.md#current-limits).
- Worktree: main checkout, branch `main`; the `p10-system-storage` worktree can be removed once
  the transfer commit is in.
- Review (PR #1, `claude/p10-storage-providers`): ten confirmed findings fixed on 2026-09-10,
  covered by the [lifecycle requirements](../STORAGE-PROVIDERS.md#isolation-and-lifecycle-requirements) (disabled provider
  keeps sessions alive, public label never the host, setup writes config after login, address
  equality after upstream login, seed keeps/retires rows, duplicate address 409, office_files
  cascade, per-row `index`, delete dialog reads the capability).

## P10 storage providers: A1 registry and generic auth (implemented 2026-09-10)

- Current reference: [provider guide](../STORAGE-PROVIDERS.md). The following records the
  original delivery; the guide describes the current implementation. Implemented directly in the main checkout, no worker worktrees.
- Delivered: `ProviderModule` port and field validation in core, `stat`/`ifRange`/optional
  `zip`+`setModifiedAt` on `StorageProvider`, `withMoveToTrash`; `app.providers` gains
  `label`/`config`/`enabled`/`managed_by_env`; `SFTPGO_URL` seeds
  and pins the SFTPGo row at startup (`ProviderService.seedFromEnvironment`), nothing else is
  migrated (pre-release, no compatibility with the old `connection.sftpgo` setting);
  `packages/sftpgo` exports `sftpgoModule` (adapter, probe and 401 retry moved in from the API);
  `@fdrive/testkit` exports the canonical `createMemoryStorage` and `describeStorageProvider`
  (runs against memory, the SFTPGo fake, and the real SFTPGo container in
  `packages/sftpgo/test/integration/container.contract.test.ts`, 72/72); API: `providers/{registry,service,routes}`, generic
  `TokenSource`, `verifyCredentials`, `createPinnedStorageFactory` for Office, `unsupported`
  error kind, `/providers` and `/admin/providers*` routes replacing `/admin/connection`;
  contracts: `LoginRequest { providerId?, credential }`, `LinkIdentityRequest { providerId?,
  credential, currentCredential }`, `IdentitySummary.capabilities`, `AboutResponse.builtOn[]`
  and `providers[]`, `AdminProvider*`; web: minimal adaptation only (login form, link/unlink
  dialogs, About, System > General over `/admin/providers`); A2 followed the same day.
- Passed on `main` checkout: `application` (lint, typecheck, coverage: api 99.03% statements),
  `workflow`, `integration` for all files except the two known pre-existing failures
  (`sftp-rename.test.ts` Docker pull of `python:3.12-slim` hangs; `provider-binding.test.ts`
  "api-token: isolates mutation" barrier flake, also on unchanged `main`). The other eight
  provider-binding cases pass against two live upstreams with provider rows disabled/added through
  `/admin/providers`. Browser (production build, `--workers=1`): `system`, `auth`,
  `account-identities`, `about`, `smoke` specs 21/21.
- Semantics to know: a stored credential never follows a configuration change because identities
  are bound to rows; re-addressing a row that logins use is refused (`conflict`), env-managed rows
  refuse address changes and deletion, and `verifyCredentials` re-checks the row after the
  upstream login. With several enabled providers a login must name `providerId` (400 otherwise);
  setup creates the SFTPGo row disabled and enables it after the owner login.
- Not done in A1: `roots[].sftpgoPath` keeps its name; core keeps its own memory fake (cannot
  depend on testkit); no page shows the new `general` event log subsystem; the conformance
  suite accepts `upstream_unavailable` as well as `bad_request` for listing a file, because real
  SFTPGo 2.7.5 drops the connection there. The web integration followed; see the [provider guide](../STORAGE-PROVIDERS.md).
- Migrations squashed (2026-09-10): `packages/db/drizzle` now holds one `0000_init` migration
  regenerated from the schema plus the hand-written extension, gin/hnsw index and
  `idx.schema_version = 1` statements. Verified by applying the old ten-file chain and the new
  file to two fresh pgvector containers and diffing `pg_dump --schema-only`: identical apart from
  column order. Existing dev databases must be dropped and recreated (no users yet).
- Worktree: main checkout, branch `main`.

## P9 System settings restructure and event log (committed 2026-09-09)

- Spec: `P9-SYSTEM-SETTINGS.md` (retired brief). Two `implementer` worktrees
  (`claude/p9-system-web` for `apps/web`, `claude/p9-event-log` for db/contracts/api) merged
  with `merge-chunk.sh`; the `LogSheet`, its hook and the page mounts were added directly in
  the main checkout afterwards.
- Web: Features is toggles only (six cards with "Open" links plus an Office card); Connection
  became General (`/system/general`, old URL redirects); new Shared folders and Office pages;
  Indexer and OCR settings live in a `SettingsSheet` with a discard guard; `SystemPage` gates
  on `feature` ids instead of the page title; every feature page has a Logs sheet with level
  filter, copy, .txt/.ndjson download and "Load older". The Indexer "Recent errors" list is gone.
- API: `app.system_events` (migration `0008_system_events`), `GET /api/v1/system/{subsystem}/logs`
  merging `idx.scans`/`idx.files` errors and `idx.ocr_runs`/`idx.ocr_log` failures; events are
  recorded for settings saves, maintenance requests and failures, feature toggles, worker
  reachability transitions and Office settings saves.
- Passed on `main`: `application` (lint, typecheck, coverage) and browser `system`, `features`,
  `office-settings`, `trash`, `account-scope` specs with `--workers=1`. In the event-log
  worktree: `@fdrive/db` integration 10/10 (migration and the merge query) and
  `composition.test.ts`. Two API integration tests fail there and on unchanged `main` alike:
  `sftp-rename.test.ts` (Docker credential helper hangs on `python:3.12-slim` pull) and
  `provider-binding.test.ts` "provider barrier was not reached" (reproduced on `main`).
- Known: the five browser specs race each other at the default two workers (onboarding
  specs reset `walkthroughComplete`, and the clear tests share the fake indexer's busy state);
  pre-existing, run them with `--workers=1`. The walkthrough's Office step label is still
  the literal "ONLYOFFICE" regardless of product.
- Not done: no real dev-stack pass yet (the browser specs run against the production build
  with a fake indexer).

## P8 virtual folder index support (in progress, uncommitted)

- Spec: `P8-VIRTUAL-FOLDERS.md` (retired brief). Implemented directly in the main
  checkout (no worker worktrees): VF-1, VF-2, and VF-3 together.
- Step 0 evidence (dev stack, indexer container started for this): carol's scope status was
  `unavailable`/`mismatch` and `/api/v1/search/status` reported `mismatch`; alice's scope
  status was `available`/`ok`. Reproduced before any change.
- Contract deltas beyond the spec, both needed by the editor: the status also returns the
  stored `unindexedPrefixes` (both roles; virtual paths) so a later save cannot silently
  drop earlier acknowledgements, and the administrator branch returns `overrides` (the
  stored list on its own) next to the effective `mappings`, so the editor never has to
  guess which rows are template-derived.
- Override record is now `version: 2` with `unindexedPrefixes`; version 1 rows read as
  having none. `reset` now persists an empty record: the previous `null` value violated
  `app.settings.value NOT NULL` against real Postgres (a 500 on "Remove" in the browser
  test), which the in-memory repo never caught. Covered in `scopes-sftp.test.ts` step 7.
- `usableScopesFor` deleted. `validateScopeOverrides` gained `unknown_root` (index roots
  plus the template root are known); the route reports the reason in `details.reason`.
- Dev seed: carol's override is not stored by `generate-seed.ts` (the seed is SFTPGo JSON
  and files only; overrides live in the API database), so carol stays the visible unmapped
  case and the mapping is `sftpgo` + `/_folders/shared`, documented in deploy/REFERENCE.md.
- Passed: `application` (lint, typecheck, coverage), `workflow`, full `integration`
  (including `scopes-sftp.test.ts` with the two-identity virtual folder and reset steps), and
  browser `e2e/account-scope.spec.ts` 3/3 (serial: both tests edit one login's override).
- Live dev (API 3001 `tsx watch`, own Next dev server on 3004, real indexer container):
  carol non-admin view shows `/shared is not indexed. Ask an administrator`; as `dev`
  (admin) linked carol, mapped `/shared` → `sftpgo:/_folders/shared`, status turned
  Available with `/`, `/shared`; with text search temporarily enabled, carol's
  `/api/v1/search?q=team` returned `/shared/team.txt`. Restored afterwards: override reset,
  carol unlinked, text search off again (dev `features.configuration` row now exists with
  everything off, equivalent to the default). The 3002 Next server on this machine belongs to
  an old screenshots checkout under `/private/tmp` and was left alone.
- Pre-existing, unrelated: clicking "Link login" under `next dev` raised the dev overlay
  `isSearchShortcut: event.key undefined` (`apps/web/src/lib/search/shortcut.tsx`); not
  reproduced in the production-build e2e run. Not changed here.
- Follow-up (same day): folder-level mappings and suggestions, spec
  `P8-FOLDER-MAPPINGS.md` (retired brief). `mount_mappings` settings record; adoption
  decided per login from verification evidence (two-pass verify, cached); `configuredMappings`
  now includes adopted scopes so Office and events see them. New `IndexQueries.directoriesWithFiles`
  (real-Postgres test passed, 2 cases). Routes: `GET/PUT /system/mount-mappings`,
  `GET .../scope/suggestions`. Web: suggestion chips, "Apply to every login" default, Shared
  folders card on System > Connection (now System > Shared folders, see P9).
- A parallel public-URL effort worked in this same checkout and committed to `main`
  (`08a9dbd`) while this task was in progress; none of this task's hunks were included.
  Interim gates ran in `.worktrees/scope-e2e` (branch `claude/scope-e2e`, this task's files on
  HEAD `10d8a52`): browser `account-scope.spec.ts` 3/3 and `workflow` passed there. Final gates
  ran in the main checkout on top of `08a9dbd`: `application` (lint, typecheck, coverage),
  `workflow`, browser `account-scope.spec.ts` 3/3, `scopes-sftp.test.ts` (steps 1-8), and the
  DB `directoriesWithFiles` cases (2). Live dev: suggestion `sftpgo:/_folders/shared` offered
  for carol from real index rows, saved as a shared folder mapping, carol's search returned
  `/shared/team.txt` with nothing stored on her login; card visible under System > Connection (now System > Shared folders, see P9).
  The interim worktree was removed after the main-checkout gates passed. Unrelated committed lint finding from `biome check .`:
  `apps/web/src/lib/search/queries.test.ts:314` unused `SEARCH_STARTUP_RETRY_MS`.
- Not committed. Worktree: main checkout, branch `main`.

## Auth pentest triage fixes (in progress, uncommitted)

- Source: [SHANNON-PENTEST-FINDINGS.md](SHANNON-PENTEST-FINDINGS.md), fixes table at the end.
  AUTH-VULN-01 deliberately left as a dev-environment artifact; AUTH-VULN-03 out of scope.
- Fixed 02, 04, 05, 06, 07 with regression tests. Contract change: `LinkIdentityRequest`
  now requires `currentPassword` (optional `currentOtp`); web dialog and e2e updated.
  DB behavior change: login with a replaced password revokes the account's other sessions;
  unlink revokes sessions using that login (requesting session re-pointed and rotated).
  Public share metadata is withheld for password-protected shares until the password verifies.
- Passed: `application` (lint, typecheck, coverage); DB identity-links integration (30/30);
  API `shares-sftp` and `accounts-sftp` integration against real SFTPGo/PostgreSQL; browser
  `account-identities.spec.ts` and `shares.spec.ts` against the real backend. The full
  `integration` profile also failed `sftp-rename.test.ts` on a Docker image pull for the indexer
  build (environmental, unrelated). No manual dev-UI pass beyond those e2e flows.
- Follow-up (2026-09-09): AUTH-VULN-03 closed with `FDRIVE_SESSION_MAX_AGE_DAYS` (default 90;
  `resolvePrincipal` refuses older sessions, rotation keeps `createdAt`); unlink now requires the
  owner's password like link (`UnlinkIdentityRequest` DELETE body; web dialog and e2e updated).
- Committed and pushed to `main` on 2026-09-09; CI green after Linux/CI-only fixes. Residuals recorded in the findings table (write-share metadata stays withheld;
  limiter is count-after-failure; SFTPGo-side password rotation still honours the 60s cache).

## ONLYOFFICE onboarding (verified)

- Bundled pinned engine; off until enabled in onboarding/System settings. View-only
  by default; editing requires an explicit provider-bound SFTPGo username list.
- Reviewed/transferred backend and deployment worktrees; copies retained. No migrations
  or environment activation fallback. Removed obsolete production Office overlay.
- Real controller: off → discovery-ready → off; no leftover editor, PostgreSQL,
  RabbitMQ, or Redis daemons. Proxy preserves browser host:port. Generated secrets and
  proof keys persist privately. Python lint/types/coverage and Compose variants pass.
- Application lint/types/coverage, API/DB integration, and all five affected browser
  tests pass. Live dev UI verified validation, editor selection, review, and Finish.
  Added invalid-URL and runtime toggle/callback regressions after integration findings.
  Editor menus refresh automatically after startup; editing the user list preserves its
  original revision during polling. Final frontend and workflow checks pass.
- Real bundled ONLYOFFICE suite: 7/7 passed (Word/Excel/PowerPoint coediting, saved-byte
  verification, rename/copy, external changes, read-only isolation). Collabora: 4/4 passed.
  Fixed the separate-origin editor fixture CSP; production stays on the fdrive origin.
- Work is repository/local fixtures only; no owner server access. Other agents' worktrees
  excluded from lint/build contexts without changing their content. Disposable fixtures
  cleaned up.

## Trash onboarding (verified)

- Seventh optional choice after six processing features; followed by ONLYOFFICE and review. Saved through
  provider-bound admin settings with revision checks. SFTPGo recycle rules require explicit
  operator confirmation; no WebAdmin credentials, automatic rule creation, or remote access.
- Backend reviewed and transferred; copy retained in `.worktrees/onboarding-trash-backend`.
  Each request captures a consistent configuration. Account-wide and MCP search included.
- Removed deployment/dev environment activation keys. Preflight/dev-env and focused UI
  tests pass. Application lint/types/coverage pass with `VITEST_MAX_WORKERS=2`; default
  concurrency hit unrelated 5s archive-fixture timeouts. API/DB integration and affected
  browser tests pass (onboarding resume/skip, enable, restore/conflict/purge, live disable).
- Fresh local dev UI verified: claim → connection → file-user → six processing choices →
  Trash → review → files, with Trash navigation available. Invalid hidden drafts cannot
  block disabling. Final frontend lint/typecheck/coverage passed after that form fix.
  Workflow gate passed; no remote server access or compatibility migrations.

## Generic installation documentation

- Canonical runbook: deploy/README.md. Generic host/path/account examples; existing versus
  new SFTPGo, deployment inputs before startup, mount verification, one web flow, updates,
  and failure diagnosis. Advanced reference covers named volumes, networks and permissions.
- Work in this task is repository-only. Host deployment is performed by its local operator
  or agent using the runbook; there is no pending remote-operation approval request here.
- Documentation checked against shipped Compose/scripts. Workflow verification recorded
  in the task result; no deployment operations performed for this documentation change.

## Continuous onboarding (verified)

- One shell-free `/setup` flow: claim → connection → administrator → six processing features → Trash → ONLYOFFICE → review.
  File-user verification establishes a session internally; only Finish enters the file browser.
  Reload resumes saved choices; other users skip the owner walkthrough.
- Explained WebClient file-user versus WebAdmin accounts and fdrive-only administrator rights.
  Removed SFTPGo inventory API/contracts/UI. Default home mapping; automatic storage checks
  only for enabled features. Storage/mapping controls have been removed from onboarding;
  per-account corrections remain in Account settings. Directory 400/403/404 responses are
  mapping failures, not proof of an unreachable indexer; access still fails closed.
- Reviewed/transferred inventory worktree; copy retained. Preserved unrelated user edits.
  Fixed transient feature-load resume bypass and unavailable probes remaining “Checking”.
- Passed final application lint/types/coverage, API/DB integration, and real-backend browser
  resume/skip-all/finish regression. Live dev: fresh claim, account, enable, automatic missing-
  mount notice, reload, both OCR choices, finish into files despite optional processing blocked.
  Disposable dev fixtures cleaned up; no live owner SFTPGo access or compatibility migration.
- Workflow helper regressions passed; final formatting fixed and documentation gate rechecked.

## LAN onboarding defaults (verified)

- User requires access from another device after init-env/update. Default web binding now
  all interfaces, with server-IP instructions; loopback remains an explicit override.
- Removed forced HTTPS assumption in core/Office proxies. HTTP default supports LAN cookies;
  FDRIVE_PROXY_SCHEME=https supports an HTTPS edge without trusting client protocol headers.
- Startup output directs users to the server IP and honors configured ports/URLs. Preflight
  validates the browser-facing protocol; init-env still generates only two required secrets.
- Passed: deploy coverage, deploy TypeScript, workflow, rendered Compose default binding,
  and real Caddy HTTP/HTTPS forwarding plus automatic cookie checks for core/Office variants.
  Initial Docker Desktop stale file mount was refreshed; existing workflow mock-start race
  passed on rerun. No remote Unraid configuration or SFTPGo data changed.

## Pre-release compatibility cleanup (verified)

- Removed feature upgrade script, environment activation, managed/unmanaged branches,
  compatibility UI, and related tests/docs. No existing installations need migration.
- One persisted feature configuration path; absent settings leave every feature off.
  Malformed worker settings leave processing off.
- Reviewed and transferred 22 Python paths from `.worktrees/p8-remove-legacy-workers`;
  copy retained. Unrelated user agent-config/WORKING edits preserved.
- Passed: application lint/types/coverage; full API/DB integration; 12 browser checks against
  Next dev; dev UI inspection; workflow; Compose config; target runtime/OCR Python; Linux
  indexer 506 tests at 95.52%; final real SFTP rename/indexer integration recheck.
- No live owner SFTPGo access or user data migration performed.

## Setup walkthrough (implemented and verified)

- User requested UI-managed optional features, minimal deployment config, and guided SFTPGo
  connection/user diagnostics. Selected bundled workers, inactive until enabled.
- Design and acceptance criteria: `P8-SETUP-WALKTHROUGH.md` (retired brief).
- Integrated versioned feature settings/admission, resumable owner claim, SFTPGo diagnostics,
  walkthrough/System UI, lazy processing/models, and minimal deployment.
  Both OCR toggles are in onboarding. Reviewed worker deltas transferred; copies retained.
  Commit/push authorized; unrelated user edits preserved.
- Review fixes: bounded polling, cancellation without sweeps, durable derivative backfill,
  scanned-PDF extraction, model lifecycle/readiness, ARM wrapper,
  thumbnail-dialog completion independent of slow cache-size refresh, isolated Next builds.
- Passed: final application (1,860 API / 1,528 web tests plus workspace/deploy coverage),
  workflow, runtime/OCR Python (OCR 138 tests, 97.64%), focused regressions, final integration.
- Real dev UI passed: claim, connection, failed login/retry, admin user inventory, saved-step
  resume, all six choices, skip-all and finish into files. Fixture servers stopped.
- Actual production Compose passed: fresh all-off boot, idle model controllers, owner auth,
  writable OCR backup state, UI thumbnail enable -> generated 256/1024 previews -> authorized
  WebP 200; UI disable -> workers off, models stopped, thumbnail 404, cache retained.
  Production fixture containers/volumes removed; unused task images removed for disk space.
- Final Linux indexer passed 505 tests at 95.61% coverage with strict precision, including
  inotify. Final affected browser suite passed 12/12, including both rebuild dialogs.
  Docker Desktop stale-file/disk failures resolved without changing application data.
- All required profiles, including final documentation/workflow checks, passed. No live
  owner SFTPGo connection performed. Host mount changes still require deployment configuration,
  as explained in the walkthrough and deployment guide.

## README screenshots (2026-09-08)

- Added all 13 user-provided PNGs under `docs/screenshots/`, with a README overview
  and five expandable feature galleries. Original filenames and image bytes preserved.
- Image links, alt text, gallery markup, and scoped diff check verified; workflow gate
  passed. Included in the user-requested commit of all current changes.

## P7 folder views (complete)

- User selected Plan A and remaining recommendations: server pins per identity/path,
  exact-folder resolution, nullable future sort state, global-only virtual listings,
  rename/delete tracking, account reset across linked identities.
- Primary owns web hooks, toolbar/account controls, docs and target verification.
- Backend and virtual-view implementers integrated after diff review and scoped transfer.
  Copies retained in `.worktrees/p7-folder-view-backend` and `.worktrees/p7-virtual-views`.
- Global default retains `fdrive.view` in this browser. Folder pins sync across devices.
- Target workflow, application (lint/typecheck/coverage), and integration passed. Application
  used `TURBO_CONCURRENCY=1` and permitted socket access; no gates weakened.
- Live dev smoke on isolated ports 3004/3005 verified saved Grid on `/photos`, default List
  on `/docs`, persistence, unpin, and account controls. Restored the temporary pin; stopped
  owned servers, preserved existing dev processes.
- Browser: five new feature scenarios passed, including another browser, mobile, rollback,
  rename/reset, and virtual listings. Corrected ambiguous existing View selectors; thumbnail
  harness uses an explicit image fixture because its fake indexer generates no thumbnails.
- All 54 affected browser scenarios passed across the initial run and corrected spec reruns.
  Backend/virtual worker copies remain retained. Logs: `.fdrive-workflow/logs/` (ignored).

## Workflow simplification (complete)

- Requested changes integrated and verified; baseline `e791fd5`. Three workflow worktrees
  reviewed, byte/mode-verified against target, then removed. Other task worktrees preserved.
- Native optional delegation; compact shared docs/roles; recovery and history loaded on demand.
  Opus worker defaults and explicit Fable-worker approval policy now live in `.claude/agents/` and WORKING.
- Helpers: compact PASS/FAIL with retained logs; Python venv/dev readiness setup; working-tree
  baselines before setup; scoped conflict-safe uncommitted transfer with diff/check modes.
  CI shares setup/verification commands and uploads only helper logs on failure.
- Target `workflow` PASS: 32 command +8 environment +19 integration-helper +11 transfer
  regression groups; shell/Python/TOML syntax, lint, diff checks. CI YAML and docs links pass.
- Real core profile PASS: 292 tests, existing coverage intact. Quiet89 vs verbose1611 bytes
  (94.5% less output); shared docs/roles ~60% fewer words. Evidence in ignored
  `.fdrive-workflow/evaluation/`; full gate logs under `.fdrive-workflow/logs/`.
- Hosted CI not run locally; new role text takes effect when the runtime reloads configuration.
  Dev lifecycle tested with fixtures and occupied-port smoke; existing live servers preserved.

## Search startup recovery (2026-09-08)

- User requested automatic recovery after deployment without page reload.
- Implementer completed search contracts/API/UI/tests in `.worktrees/search-startup-recovery`,
  branch `claude/search-startup-recovery`; baseline committed HEAD, no copied prerequisites.
- Add transient scope reason and bounded polling while open; preserve scope authorization.
- Reviewed scope and production diff; committed as `af0a3d9` after user requested commit/push.
- Live dev verification: stopped local `fdrive-dev-indexer-1`, observed startup message;
  restarted indexer and saw text plus visual results for unchanged `readme` query without reload.
- Workflow, target application (lint/typecheck/coverage), and integration passed.
- Target search browser suite passed 17/17, including startup message and unchanged-query
  recovery. Logs: `/tmp/fdrive-startup-{application-final,integration,browser-final}.log`.
- Complete. Worker checkout removed after exact file comparison and target gates.
  Unrelated concurrent workflow changes preserved.

## Tester report: self-recovering workers and health (2026-09-10)

- External tester reported four defects; three reproduced from code, `init-env.sh`
  overwriting `.env` did not (script refuses to overwrite; awaiting their exact command).
- Runtime and Office controllers clear exhausted startup attempts after
  `FDRIVE_RUNTIME_RETRY_AFTER_SECONDS` (default 300) instead of only on a revision change,
  so an api restart under load no longer leaves an enabled feature dead (`467fe17`).
- Indexer health/stats handlers reopen their postgres connection after `db` is recreated;
  image embedding no longer logs a second error for a thumbnail that was never written.
- `GET /api/v1/health` gains subsystem status `failed` with the controller's reason in
  `detail`; the same reason is carried into the feature detail on System > Features
  (`ab5f9fa`). Docs: `deploy/REFERENCE.md`, `deploy/README.md`, `docs/INDEXER.md`,
  `docs/OFFICE.md`.
- Gates: runtime 27, indexer 483 (coverage gate at 83.8% fails on untouched main too),
  contracts 631, api 1959, repo typecheck and lint clean. Committed directly to main.

## Product state

- Latest search/file-browser UX merged and verified; no outstanding UX work. Prior target
  application/workflow gates passed and affected browser suite passed 31/31.
- Phase 5 strict performance gate previously passed: search25k p95 195.82 ms (<300),
  zero errors; detailed evidence in archive.
- Earlier P5 worktrees were retained by the preceding task. Do not clean them without review.
- Full prior evidence, performance work, and historical handoffs: earlier sections of this file.
  Product scope and architecture remain in [architecture](../ARCHITECTURE.md).


## 2026-09-11: issue #2 concurrency fixes

Implemented in order, with commits between groups:

- #11, `f8b8b55`: credential snapshot before authentication and comparison under persistence
  locks. Same-password replacements preserve both sessions; stale differing credentials
  are rejected. Deferred API and PostgreSQL regressions pass.
- #8–10, `e413915`: atomic insert-only provider creation; readdress conflicts translated;
  provider deletion serialized with identity persistence. Concurrent repository and real
  PostgreSQL tests pass.
- #3/cache, `a99204b`: coalesced token misses, invalidation/prime generations and ordered
  persistence; stale scope computations cannot replace cache or in-flight entries.
- #7: setup claim shares the login transaction. Losing claims roll back auth changes;
  unused newly created providers are removed. Later setup failures clean up their session
  while preserving resumable ownership. Existing identities and sessions survive losing
  claims. Finalization remains last.
- All application gates pass using `--concurrency=1 -- --maxWorkers=2` for coverage.
  API coverage initially reached 98.99% against 99%; added auth-claim and failed-cleanup
  regressions, then passed without threshold changes. Full final integration passes
  (`.fdrive-workflow/logs/step.tfMCpG/`), including the actual setup HTTP race on real
  SFTPGo/PostgreSQL and a check that only one provider/account/identity/credential/session remains.
- One token-group workflow run hit the environment-helper timing failure
  `missing pnpm <--filter> <@fdrive/api> <dev>`; the unchanged workflow gate passed on rerun.


## Issue #2 handoffs archived 2026-09-11

## Issue #2: concurrency

- Completed in requested order: #11 (`f8b8b55`), #8–10 (`e413915`), #3/cache
  (`a99204b`), then #7 setup rollback and failed-request session cleanup.
- Application gates pass with reduced-concurrency coverage. Final full integration passes,
  including deterministic real-SFTPGo setup competition with one remaining provider,
  account, identity, credential and session, plus PostgreSQL preservation of existing losers.
- Completion evidence is in [history](STATUS-history.md). No concurrency plan remains open.

## Issue #2: quick fixes

- Items 2, 5, 12 and 13 implemented locally: uploads forward request cancellation;
  upstream 416 maps to `bad_request` (public shares return 400 instead of 502);
  spare-provider E2E cleanup sends the CSRF header and checks success; auth docs use
  `currentCredential`. The obsolete probe document was already removed.
- Regressions cover cancellation with and without a body, client error classification
  (412 stays unchanged), and removal of a provider left by an interrupted browser run.
- Lint and typecheck pass. Default parallel coverage hit the two existing 5000ms archive
  test timeouts (`.fdrive-workflow/logs/step.IIsiDj/`); all package coverage passes with
  `turbo run test:coverage --concurrency=1 -- --maxWorkers=2`
  (`.fdrive-workflow/logs/step.OvSddD/`). No gates or timeouts changed.
- Integration passes against disposable SFTPGo/PostgreSQL. Storage browser tests pass
  with `E2E_DEV=1`, including the new leftover-provider cleanup regression. Tooling
  coverage and workflow verification pass. Committed and pushed as `7b097d2`.

## Issue #2: descendant move/copy guard

- Item 1 implemented locally: normalized descendant targets return 400 before storage,
  metadata or events; equal-path API no-ops remain supported. Move/copy pickers exclude
  selected subtrees and require a valid destination for every selected source.
- Regression coverage checks preserved file contents, no mutation/event side effects,
  normalized paths, sibling prefixes and both picker flows. Focused API tests, lint and
  typecheck pass. Integration passes; all 9 move/copy browser tests pass against disposable
  SFTPGo/PostgreSQL with `E2E_DEV=1`. Interactive dev check confirmed the selected folder
  is hidden, same-parent confirmation disabled, and a valid sibling destination enabled.
- Default parallel application coverage hit existing archive/trash test timeouts
  (`.fdrive-workflow/logs/step.pkuX6l/`). All package coverage passes with
  `turbo run test:coverage --concurrency=1 -- --maxWorkers=2`
  (`.fdrive-workflow/logs/step.pmRLLk/`); no timeouts or thresholds changed.
- Committed on `main` as `4d80db3` at the user's request.


### Earlier checkout note (historical)

## Existing checkout work

- Provider/auth isolation edits and tests, Playwright configuration, pentest findings and
  `PR-REVIEW-FINDINGS.md` predate this cleanup and remain uncommitted. The documentation
  cleanup was moved to `main` for the requested commit; no push requested.
- Detailed security followups: [pentest findings](SHANNON-PENTEST-FINDINGS.md).
- This cleanup changes documentation and source comments only. It does not claim new
  application, browser, performance or security verification.

- Previous local main history is retained on `codex/main-before-docs-cleanup`; main now
  starts from the merged PR #1. Its base tree matched the documentation checkout exactly.

## 2026-09-14: Native macOS writes merged in PR #21

- Worktree `/private/tmp/fdrive-macos-writes`, branch `codex/macos-writes`, based on `c16cebef`.
  Primary WIP preserved. [Write plan](../plans/MACOS-WRITES.md), [implementation](../MACOS.md#write-configuration-and-recovery).
- Explicit v2 grants, storage-enforced Apache DAV leases, staged uploads/backups, durable
  PostgreSQL receipts and native SQLite recovery. Finder saves, uploads, folders, rename,
  moves, offline retry and conflict copies work on qualified DAV. SFTPGo stays read-only:
  its conditional headers and cross-protocol locks fail the safety gate chosen by the user.
- Application lint/typecheck pass (`step.Yfalsq`, `step.CT3774`); coverage passed except an
  unrelated web timeout under load (`step.m3L1Vd`), whose single-worker rerun passes
  (`step.BNPWfz`). Full integration passes (`step.l6WCwr`: 42 API cases plus DB/provider suites).
  Browser pairing passed earlier (`step.ClTfGm`, 3 cases plus login setup); real pairing also
  exercised during Trash verification. All 26 Swift tests/native build pass (`step.SYgqIz`,
  `step.kgmnmH`); final isolated signed build/signature pass (`step.XhxuO3`).
  Final workflow gate passes all orchestration regressions, lint and diff check.
- Isolated development-signed app `se.burmester.fdrive.mac.writetest` exercised real
  Finder/TextEdit: materialize, save, new file/folder, rename/move, offline save/reconnect,
  both conflict versions on storage. Repeated saves exposed a timestamp issue, fixed and
  verified with three consecutive saves. Production app/connection untouched.
- Recoverable Finder Trash explicitly approved and implemented. Native file/folder Trash and
  app **Restore from Trash** pass, including nested/empty folders, exact bytes, stable IDs and
  reconnect. Rehearsal exposed permission and descendant-notification bugs, fixed with
  regression coverage and a one-time catalog metadata refresh. Finder drag/Undo restoration
  was unreliable in this rehearsal; the app provides an explicit Restore control to the
  location's top level. Finder Put Back and permanent purge remain unavailable.
  Permanent-delete callbacks reject and ask macOS to restore the local item.
- Remaining: SFTPGo storage-side enforcement; metadata-effect outbox; safe recovery retention/
  reclamation and administration; broader reboot/low-disk/package/cross-domain qualification.
  Backup capacity is conservative and refuses new writes instead of discarding recovery data.
- Isolated test location disconnected, test app quit and test services stopped. Evidence under
  `.fdrive-workflow/evaluation/native-write-evidence.md`. Prepared for PR review; no release or
  production deployment. Actions configuration untouched.

Merged as `0b32449d`. Evidence above records the qualified DAV delivery snapshot.
