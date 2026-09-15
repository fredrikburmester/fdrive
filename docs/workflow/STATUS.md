# Current handoff

Updated: 2026-09-15. Unfinished product work: [plans](../plans/README.md).
Current implementation: [architecture](../ARCHITECTURE.md). Prior delivery evidence:
[history](STATUS-history.md). Historical branch/commit and in-progress labels are snapshots,
not current instructions.

## About attribution removed: "Built on SFTPGo." dropped

- Branch `refactor/remove-sftpgo-attribution` off `main`, opened as a PR; the OCR-originals and
  backups WIP in the main checkout stays out of that commit.
- With several data sources supported, the About page no longer credits any upstream project:
  `attribution` is gone from `ProviderModule`, `builtOn` from `AboutResponse` and the `/about`
  handler, and `ConnectionStatus.configuredProviderTypes` with it (it existed only to feed
  attribution from disabled providers). The factual "Connected to <provider> at <host>." line
  and the AGPL licence line stay.
- Licence check: stock SFTPGo runs as an external service over REST, unmodified and not
  distributed by fdrive, so the AGPL notice terms the old docstrings cited do not reach the web
  UI. The optional `integrations/sftpgo` image does carry AGPL modifications; its notice and
  source-offer duties stay where they are, in that image and its README.
- Verified: `pnpm typecheck` clean; `pnpm test` 6574 passed with one unrelated timeout in
  `apps/api/src/backups/recovery.test.ts` that passes on its own (known full-suite flake);
  `integration` and `browser e2e/about.spec.ts` passed; `workflow` passed every gate but lint.
- Lint blocker is not from this change: `pnpm lint` fails only on two untracked non-source
  files, `.claude/launch.json` and `.playwright-mcp/rehearsal.json`. `biome check apps packages`
  is clean. `.playwright-mcp/` looks like it wants a gitignore entry.

## Restoring OCR originals: implemented in the primary checkout

- Branch `feat/ocr-restore-originals` off `main` at `e303c12`. The pre-existing backup WIP in
  `apps/web/e2e/backups.spec.ts` and `apps/web/src/components/system/backup-*` is untouched and
  uncommitted.
- Kept originals had no reader: `apply_rewrite` wrote them and their sidecars, and nothing ever
  put one back. Recovery meant copying the file off the host by hand, and the next nightly pass
  then OCR'd it straight back again, because a rewrite re-keys its done-log row to the new size
  and the pre-OCR key was never recorded.
- New `services/ocr` modules `originals.py` (pure) and `restore.py` (I/O), four `/originals`
  endpoints, and a `restored` done-log row that stops the next pass from undoing a restore.
  Restores are refused rather than half-applied for a changed or missing target without the
  caller's opt-in, a checksum mismatch, an unresolvable sidecar, a path outside its root, an
  unconfigured root, or a missing parent directory. Legacy originals resolve from the done-log
  and backfill their sidecar. `ocr.originals_retention_days` prunes at the end of each pass,
  defaulting to 0 (keep forever). Behaviour: [OCR](../OCR.md#kept-originals).
- Admin UI is `System > Searchable PDFs > Kept originals`: search, per-row state, restore,
  download and delete, with state-specific confirmations. Everything but `/run` works while the
  `pdfOcr` feature is off, which is the state an operator is in when a pass has damaged a file.
- Per-file restore from the file browser was deliberately not built; the authorization reason is
  in [deferred](../plans/DEFERRED.md).
- Gates: `python ocr` (ruff, mypy, 96% coverage), `integration`, `browser e2e/ocr-originals.spec.ts`
  (screenshots inspected), and `application` typecheck plus `VITEST_MAX_WORKERS=1 pnpm test:coverage`
  (10/10 tasks). At full turbo concurrency the pre-existing backup tests flake on timing; they
  pass in isolation and under one worker.
- `application`'s repo-wide lint gate fails on two untracked local artifacts that predate this
  work, `.claude/launch.json` and `.playwright-mcp/`. `npx biome check $(git ls-files)` is clean.
  Either gitignore them or add `!**/.playwright-mcp` to `biome.json`.

### PR #33 review fixes

- Restore checks the destination after lock acquisition and immediately before replacement,
  refusing edits, deletion or recreation during copying even with prior overwrite consent.
  OCR results from another mtime require consent to replace a later revision.
- OCR/restore commits share a per-file PostgreSQL lock and refresh done-log keys, including
  after the subprocess, so a running pass cannot undo a restore. Delete and retention pruning
  hold the backup gate. Restore/delete waits run off the HTTP event loop.
- Final `python ocr` passes 267 tests at 96.20% coverage (`step.rdFnEF`), including 18 new
  regression cases. Integration ran 498 tests successfully (`step.pUdmw9`); one PostgreSQL
  container port-binding timeout skipped three tests, all passing in isolation (`step.QvutOH`).
- Workflow helper regressions and tracked-file lint pass. The full workflow gate still fails
  lint only on pre-existing `.claude/launch.json` and `.playwright-mcp/rehearsal.json`
  (`step.wyyCtc`); diff checks pass. Unrelated backup and planning WIP is preserved.

## Installation backups: implemented, final gates in progress

- Worktree `/private/tmp/fdrive-backups`, branch `codex/backups`, everything uncommitted; main
  checkout WIP preserved. Detailed evidence and remaining items:
  [backup handoff](BACKUP-HANDOFF.md); operator guide [BACKUPS.md](../BACKUPS.md);
  remaining acceptance [plan](../plans/BACKUPS.md).
- Resumed 2026-09-14: fixed the fixture that scheduled before key confirmation, the null-owner
  queue call and the web BigInt/typing errors; formatted the tree. Added retention-kept probe
  handling (no lock bypass, deadline shown), bounded spool sweep for orphaned archives and
  markers, a ten-minute estimate deadline with connection failures caught, and transient
  credential fields stripped before a fileserver destination is verified and saved.
- New qualification: Apache WebDAV and SFTPGo destinations with a 64 MiB streamed archive,
  completion catalog, fileserver-only fetch and restore into fresh databases; a CLI cutover and
  rollback rehearsal; a benchmark fixture whose numbers are published in the guide; browser
  coverage of the health panel (estimate and rehearsal report upload) in `backups.spec.ts`.
- Final tree passes `workflow`, `application` (`step.sxrWn3`: backup 44, API 2278, web 1852
  tests, thresholds met), `integration` (`step.8bOT2w`, six packages) and
  `browser e2e/backups.spec.ts` (`step.lW4yLM`, 2 tests, screenshots inspected). Intermediate
  failures and their fixes are listed in the handoff document.
- Docker Desktop stopped mid-session (socket gone); it was relaunched to continue container gates.
- Manual browser smoke test against the real dev stack, dev SFTPGo and a local MinIO (versioned
  and Object Lock buckets) passed; it found and fixed a 500 on deleting a run with a locked
  copy, which now answers 409 naming the retained copies. Details in the handoff document.
- Real Backblaze B2 round trip passed through the browser UI on the owner's test bucket:
  probe, delivery with readback, version IDs, byte verification and exact-version deletion.
  Real AWS S3 and B2 Object Lock remain untested.
- Not done: real AWS/B2 buckets (needs the owner's bucket names), hosted CI, a real host cutover.
  No commit, merge, push or deployment requested.

## Upload completion reveal: review fixes verified in worktree

- Worktree `/private/tmp/fdrive-upload-reveal`, branch `feat/upload-reveal`, based on
  `origin/main` at `b4cc8eb`. Primary checkout changes and the original `codex/upload-reveal`
  branch are preserved. Only the upload commit was copied to this PR branch; no merge requested.
- Completed uploads select successful files together and scroll the focused item into view
  in list, grid and tree modes. Folder uploads select their top-level folders. Failed,
  skipped and cancelled items are excluded; leaving the folder or switching login cancels
  pending automatic selection. Old Activity entries are not replayed.
- List/tree reveal accounts for the sticky header. Review fixes track successful retries,
  require a newer query result rendered in the current sort order before revealing
  replacements, and reveal surviving uploads if earlier files were renamed or removed.
  Fully removed batches are consumed without selecting later files that reuse their paths.
- Twelve hook regressions use real query refreshes, including cancellation/restart and
  unchanged replacement metadata (`step.Fmc4sA`). All 15 affected browser tests pass
  on the current-main PR branch (`step.0ZHVg9`), including replacement size-sort scrolling, Retry, list/grid/tree,
  folder uploads, existing reveal controls and pointer/keyboard selection.
- Standalone disposable dev verification passes at 1440px/light and 390px/dark, with long
  filenames, no page overflow and selection retained when scrolling away (`step.1OBNPC`).
  Screenshots: `.fdrive-workflow/evaluation/upload-{desktop,mobile-dark}.png`.
- Application lint/typecheck/coverage pass on the current-main PR branch
  (`VITEST_MAX_WORKERS=1`, `step.sTOwL0` coverage, including 1,875 web tests).
  No limits or thresholds changed. Integrated diff reviewed.

## Licensing: AGPL retained

- Keep AGPL for the server, web interface and native Mac app. README scope and root
  package metadata now explicitly use `AGPL-3.0-only`; the license text is unchanged.
- README distinguishes stock external SFTPGo from the optional modified integration.
  No commercial terms or purchase enforcement added. Workflow checks pass.

## Native metadata recovery follow-up

- [PR #23](https://github.com/fredrikburmester/fdrive-web/pull/23), worktree
  `/private/tmp/fdrive-native-metadata-recovery`, branch `codex/native-metadata-recovery`;
  primary WIP preserved.
- All three review fixes implemented: later path hooks invalidate superseded recovery targets,
  snapshot capacity is checked before publication, and notification delivery retries separately
  after metadata commits. [Behavior and limits](../MACOS.md#write-configuration-and-recovery).
- Application lint/typecheck/coverage pass (`step.WhVDBA` coverage), including 2,242 API tests
  and 256 DB tests; queue SQL retains 100% line coverage on real PostgreSQL. All 497 integration
  tests pass (`step.uuBMtI`), including all three review regressions and WebDAV/SFTPGo recovery.
  Workflow helper regressions, lint and diff checks pass. Ready for re-review.
- Remaining beta work: backup reclamation/recovery administration and broader native/editor
  qualification. No native UI, storage image, production or release changes.

## Native gaps: implemented on `claude/macos-gaps`, review pending

- Worktree `.worktrees/macos-gaps`, branch `claude/macos-gaps`, rebased onto `origin/main`
  (carries the friendly-storage-names commit and the edge-case hardening commit). Primary
  checkout WIP preserved.
- Pairing confirmation: the app persists the pairing record before polling and confirms
  after Keychain storage; the server revokes unconfirmed bundles at expiry and resumes the
  same bundle at next launch. Domain health from `NSFileProviderManager.domains()` shows
  System Settings guidance for a disabled extension. An extension heartbeat in the shared
  catalog drives a stalled-Finder warning. A retention job cancels idle bodies and stale
  conflicts and reclaims acknowledged backups after `FDRIVE_DESKTOP_RETENTION_DAYS`;
  administrators list and resolve uncertain commits. Conflict-copy names retry numbered
  up to three times. Behavior: [macOS](../MACOS.md).
- Edge-case hardening (handle reassignment, `.Trash` root collision, 403/409 mapping, disk
  preflight, native cycle refusal, reimport acknowledgement) is the first commit; the
  100-case review found the rest covered, documented or rehearsal-only.
- Verification: see the pull request. Signed Finder rehearsal of the new paths is listed in
  [beta qualification](../plans/MACOS-APP.md).

## Friendly storage names: verified

- Worktree `/private/tmp/fdrive-friendly-storage-names`, branch `codex/friendly-storage-names`,
  based on `origin/main` at `c16cebe`. Primary checkout WIP remains untouched.
- Setup collects a trimmed 1–120 character provider name. Existing System → Storage editing
  invalidates provider and identity caches; older setup clients and unnamed providers work.
  Environment-managed names survive initialization while deployment-controlled addresses stay locked.
- Existing Mac locations validate account/identity/provider IDs before updating display metadata,
  save the new name, and rename the same Finder domain. Endpoint, grants, token and catalog survive.
- Application lint/typecheck/coverage pass (`step.hNbNg2` coverage); 22 Swift tests and unsigned
  Xcode build pass (`step.RW9bXt`, `step.CGRtK8`). Signed isolated build passes (`step.LAjGGz`).
- Real Next dev + disposable PostgreSQL/SFTPGo + the signed app: setup name, admin rename,
  account menu, approval and existing native refresh verified. Saved binding, domain ID,
  catalog generation, cached inode and bytes stayed unchanged; offline refresh retained the
  name and Quick Look content. Test connection removed and dev services stopped afterward.
- Finder's single-domain sidebar still shows the app name **FDrive**; the domain and CloudStorage
  folder rename in place. See [platform behavior](../MACOS.md#display-name-refresh).
- Full integration passes (460 tests, `step.WzRfBD`). Existing storage/login/desktop browser
  cases pass (`step.cXZUU1`); the corrected naming regression passes (`step.pY1uo5`). It exercises
  setup, label-only PATCH, account/login display, and approval refetch on a simulated tab-visibility
  event in headless Chromium. Initial browser failures were test selector/event-delivery issues.
  Final workflow regressions, lint and diff checks pass; integrated diff reviewed.
- Server deployment is pending; production providers are unchanged. GitHub Actions stays disabled.
  A server deployment and local app rebuild are needed to exercise this with production.

## Native macOS Finder app: development preview

- Release setup: [PR #20](https://github.com/fredrikburmester/fdrive-web/pull/20),
  `/private/tmp/fdrive-macos-release`, branch `codex/macos-release`.
  Fredrik Burmester (MWD5K362T8) Developer ID identity, both profiles and all five encrypted
  GitHub secrets are configured. GitHub Actions is disabled at the owner's request because
  hosted CI costs too much; do not re-enable without explicit approval. Default tokens remain
  read-only and bot PR approval remains disabled. The Developer API key is validated by Apple.
- Published [macos-v0.1.0](https://github.com/fredrikburmester/fdrive-web/releases/tag/macos-v0.1.0)
  (prerelease, build 5, commit `3a5ab76`) with the local signed release: app and DMG notarized,
  stapled and Gatekeeper-accepted. `Casks/fdrive.rb` on `main` pins its SHA-256; the
  authenticated asset download matched it and `brew fetch` from a temporary tap passed.
  Publishing a draft exposed a 404 on `releases/tags/<tag>`; asset lookup now uses the release
  listing. Homebrew install on a Mac is pending (owner runs it).
- Mac branding is **FDrive** across the app, menus, extension, DMG volume and Homebrew cask.
  `/Applications/FDrive.app` is installed and launched; the existing Finder location survives.
  The notarized installer is also in Downloads. The app and menu bar reuse the web FD icon;
  native sizes are generated from the shared SVG. Bundle IDs and shared storage remain stable.
  Live app/Finder inspection now confirms the production connection and root folder listing.
  Production file downloads remain unverified. FDrive appears in the Dock/Command-Tab while
  its window is open or minimized; closing returns the same process to background-agent mode.
  Reopening from Applications restores foreground mode; Command-Tab away/back was exercised.
  The window observer leaves SwiftUI delegates and background refresh intact.
  Provider naming and refresh behavior: [provider guide](../STORAGE-PROVIDERS.md#display-names)
  and [Mac guide](../MACOS.md#display-name-refresh).
- Hosted CI run 34772703133 passed lint/typecheck but one existing web search-panel test
  failed waiting for `same.txt` (1835 other web tests passed). Native distribution checks pass;
  that exact test passes locally with one worker. The subsequent hosted run 34773480985
  passed on code commit 1632fd6. Actions was then disabled again for cost control.
- PR #19 review fixes: `/private/tmp/fdrive-pr19-fixes`, `codex/pr19-review-fixes`.
  Partial refreshes notify Finder and continue across failed folders/files; disconnect revokes
  its credential without storage access; pairing admission groups IPv6 callers by /64.
  Application, integration (460 tests), desktop browser checks, 18 Swift tests and the unsigned
  Xcode build pass (`step.MP5TUq`, `step.2Iviyj`, `step.WMZGnr`, `step.3WpjsM`, `step.LT6YX4`).
  Refresh regressions exercise the production helper with real SQLite and injected network/
  notification boundaries. This follow-up does not repeat the signed Finder rehearsal below.
- Worktree `/private/tmp/fdrive-native-macos`, branch `claude/native-macos`, updated to
  `origin/main` at `33b244f`. SwiftUI companion and replicated File Provider extension,
  macOS 26+/Apple silicon, read-only, no search. [Implementation/build guide](../MACOS.md).
- Browser pairing selects identities; separate `fdd_` credentials, Keychain secrets and
  SQLite catalogs preserve provider isolation. Metadata-only enumeration, streamed downloads,
  durable changes, refresh/backoff, reconnect and retryable disconnect are implemented.
- Live signed Finder rehearsal: SFTPGo and Apache WebDAV, same username/path with different
  bytes; nested browsing without content reads; Quick Look and TextEdit; same-size/same-mtime
  external overwrite evicts old content and opens new bytes. Fixed security-scoped Finder
  opening, team-prefixed App Group access, and metadata permission retry loops.
- Real Finder displayed 10,000 placeholder files; catalog and system state also contained
  all 10,000, and Apache logs recorded no GETs for them. Initial system reconciliation took
  several minutes. A 2 GiB file downloaded and matched SHA-256 in 14.12 seconds on loopback.
  These timings are local observations, not performance promises.
- Application, full integration, affected browser and workflow gates passed; final application
  coverage passed (`step.kiY7g2`), as did 13 Swift tests and the development-signed Xcode build
  (`step.s8cmQW`, `step.uiPUV5`). Real composed API integration covers PostgreSQL/SFTPGo/Apache DAV.
- Integrated diff reviewed. Disconnecting the temporary DAV location removed its domain while
  the original SFTPGo location remained usable after app restart. Its local demo remains running.
- [Remaining beta qualification](../plans/MACOS-APP.md): Homebrew install, second-Mac
  install/upgrade, broader editors/offline/low-disk/cancellation/reboot matrix and tuning the
  cost of hashing downloaded files on each refresh. No production deployment.

## Mobile System page headers

- Worktree `/private/tmp/fdrive-system-mobile-header`, branch `codex/system-mobile-header`.
- Phone headers stack the timestamp above wrapping actions, retain readable labels and
  provide 44px button heights. Desktop keeps the compact layout. Shared by all System pages.
- Two browser regressions pass on real Next dev with a disposable HTTP API fixture
  (`step.VZ48tw`): 320/375/402/640/768/1280px, light/dark, no header/content overflow,
  dialogs, Logs and the four-action Full-text search header. Screenshots inspected.
- Docker-backed browser setup unavailable: Docker Desktop's engine socket is absent.
  No physical Safari check. Application lint/typecheck/coverage pass (`step.3bQ8Sm` coverage).
- Initial application coverage failed with `listen EPERM` in sandboxed loopback fixtures;
  rerun with local socket access passed. Final workflow gate passes. Primary checkout WIP preserved.

## Mobile System stat typography

- Worktree `/private/tmp/fdrive-mobile-stat-text`, branch `claude/mobile-stat-text`.
- Below 768px, stat values use 16px text and labels use 12px; desktop keeps 24px/14px.
  Long image model names and the mismatch badge wrap inside their cards.
- Next dev with fixture API responses passes Chromium checks at 320, 393, 402, 767, 768
  and 1280px: computed sizes, card overflow and mismatch state; light/dark screenshots
  inspected in `.fdrive-workflow/evaluation/stats-*.png`. No device Safari check.
- Application lint/typecheck/coverage pass (`step.WSegxR` coverage). Standard System browser
  setup fails because Docker is unavailable (`step.DIzuJN`). Original checkout WIP preserved.

## Mobile log actions: ready for PR

- Worktree `/private/tmp/fdrive-mobile-log-actions`, branch `codex/mobile-log-actions`.
  Log exports stack at full width below 640px with 44px tap targets; desktop keeps its row.
- Application lint/typecheck/coverage pass (`step.dYKDbz` coverage). Live Next dev checks
  pass at 320, 402, 639, 640 and 1280px, including 320x360, in light/dark: buttons stay
  inside the drawer, copy and both download contents work, Escape closes the drawer.
  Screenshots and measurements: `.fdrive-workflow/evaluation/logs-*.png`, `layout-results.json`.
- Existing log-drawer browser case passes (`step.HLfRQh`) with native PostgreSQL and the
  composed API; storage and indexer use fixtures. Standard Docker setup is blocked:
  `Could not find a working container runtime strategy` (`step.r7P82c`). No device Safari check.

## Processing failure transparency: implemented, Docker verification pending

- Delivery: `main`. Per-feature file failures persist in PostgreSQL; System pages
  show causes, paths, attempts, history and targeted retries. Existing Logs includes these
  failures. Stage counters no longer share unrelated errors. Indexer raw logs rotate on
  a persistent 50 MiB volume. [Behavior](../SYSTEM-ACTIVITY.md#persistent-failure-details).
- Application lint/typecheck/coverage pass (`step.Bcsed7` coverage). Workflow, Python
  ruff/mypy and Compose validation pass. Native PostgreSQL rehearsal: 561 Python tests pass
  (25 Linux skips, one Linux-only watcher case deselected; `step.31Hi57`), and seven database log/
  failure-reader integration tests pass (`step.GgPFzT`). These do not replace Docker gates.
- Actual worker -> PostgreSQL -> composed API -> Next dev browser verified: corrupt PNG,
  stopped-worker history/Logs, restart, repair, UI retry, two generated thumbnails and
  resolved history after reload (`step.5zrYQa`). New browser regression passes with the
  native fixture (`step.cg32x9`); 320px/desktop light/dark screenshots inspected under
  `.fdrive-workflow/evaluation/failures-*.png`. Storage uses a fake provider; worker/DB are real.
- Required indexer Docker coverage/inotify (`step.GE6q9a`) and standard integration
  (`step.KhrrDp`) cannot start: Docker Desktop's engine socket is absent. Standard browser
  setup (`step.I7sJ93`) has the same dependency. Native coverage cannot meet 95% without Linux watcher
  execution; threshold is unchanged. [Remaining verification](../plans/PROCESSING-FAILURES.md).
- Disposable dev services stopped after verification; screenshots and launchers retained.
  No deployment. Unrelated System activity planning, mobile header handoff and
  `.playwright-mcp/` preserved.

## Mobile preview header: complete

- Mobile puts back/name/More on the first row and file navigation on the second. Controls
  have 44px tap targets; the counter stays on one line. Edit, Download, Open in new tab and
  Info remain available through More. Desktop retains the compact toolbar; blur is unchanged.
- Application lint/typecheck/coverage pass (`step.f0u15X` coverage). All 12 affected preview
  browser checks pass against a production build (`step.40v2T0`), including 320px/402px long
  filenames, navigation, menu downloads, keyboard dismissal and Info. Final workflow gate passes.
- Live Next dev header/menu inspected in light/dark and mobile/desktop layouts. Seeded
  preview remains at `http://127.0.0.1:53766`; launcher: `.fdrive-workflow/evaluation/mobile-header-dev.ts`.
- Initial coverage hit sandbox `listen EPERM`; rerun with loopback access passed. The first
  dev-server browser run stopped in login setup with an empty username; production rerun passed.
- Delivery: `main`. Unrelated System activity planning and `.playwright-mcp/` preserved.

## Inconsistency audit: complete on main

- Worktree `/private/tmp/fdrive-inconsistency-audit`, branch `codex/inconsistency-audit-20260912`,
  originally based on `6e9f2ce`, integrated with main `7462d7f`. Confirmed defects repaired;
  intentional differences documented.
- Application, integration, all four Python services, workflow and 39 affected browser cases
  pass. Live dev readiness/discovery and screenshot layout reviewed.
- [Complete dispositions and evidence](INCONSISTENCY-AUDIT-2026-09-12.md). Original checkout
  WIP preserved. Integrated application, database/storage, indexer and browser gates pass
  again; live dev UI verified. Committed to main on user request; no deployment performed.

## Tester report: thumbnail accounting and deployment readiness

- Thumbnail rebuilds require both sizes and saved database rows before reporting success.
  Missing/corrupt sources and partial generation count as errors; empty and over-limit
  files count as skips and still advance activity progress. Logs include skip reasons and
  available thumbnail sizes. [Indexer behavior](../INDEXER.md).
- `update.sh` waits for saved enabled subsystems and Office, including Tika readiness and
  its configuration revision. Disabled features permit fresh setup. The configurable
  `FDRIVE_READY_TIMEOUT_SECONDS` defaults to 1200; timeout exits nonzero with pending checks.
  [Deployment reference](../../deploy/REFERENCE.md).
- Pinned the image model runtime after real cached SigLIP CPU image/text probes returned
  1024 finite nonzero values each. Reproduced the upstream BOS/EOS warning: the actual
  vocabulary is 256000, so IDs 49406/49407 are valid. Tokenizer IDs and warnings remain
  unchanged. [Compatibility note](../../services/image-embed/README.md#runtime-compatibility).
- Passed: deployment coverage (81 tests), deployment typecheck, indexer Python gate
  (564 tests, 95.45% coverage, including Linux inotify), image-embed Python gate
  (74 tests, 100% coverage), real model probes, and the final workflow gate.
  Logs: `.fdrive-workflow/logs/step.18xbYv/`, `step.MpQZvI/`, `step.XcaRHb/`.
- Initial regression run exposed an incorrect size-limit fixture and log noise, both fixed.
  Subsequent indexer runs failed in fixture setup with `container ... is not running`:
  local Docker disk had zero available space. Removed this task's superseded test images
  and reclaimed unused build cache (3.47 GB in the final cleanup); no deployment performed.
- Committed on `main`; concurrent sidebar work preserved.

## Mobile search fixes

- Worktree `/private/tmp/fdrive-mobile-search`, branch `codex/mobile-search-fixes`.
- Search filters wrap within the viewport; command inputs use 16px text below `md`.
- Live Next dev checks pass at 320, 393, 402, 700 and 1280px widths, including a short
  320x360 viewport: all filters remain visible/selectable, no horizontal overflow,
  mobile input text computes to 16px, desktop remains 14px, and document search works.
  Light/dark layouts inspected. Screenshots: `.fdrive-workflow/mobile-search-*.png`.
- Application passes with `VITEST_MAX_WORKERS=1` (`step.uRu2CU` coverage log).
  Initial `verify: FAIL coverage (exit 1)` hit provider-picker's 5s timeout and a search-panel
  async assertion under high load (`step.lpo8BU`); both pass in isolation and the full rerun.
- Search browser gate passes 18/18 on Next dev (`step.KVu9UI`); no device Safari check claimed.

## Features navigation and spinner explanation

- Features expands to Shared folders, Thumbnails, Full-text search, Semantic search,
  Searchable PDFs, Image search and Office. General and Storage remain top-level, with
  Features below Storage. Expansion persists locally; feature routes reveal their active item.
- Live browser observations showed Image search advancing from the supplied 1,397 processed
  to 1,646, then 1,696, while errors stayed at 297. The scan was progressing. Source confirms
  per-feature activity lasts until the entire root scan ends; attempted work and shared
  errors do not imply new stored outputs. [Details](../SYSTEM-ACTIVITY.md#worker-accounting).
- Dev app navigation/collapse and light/dark/mobile layouts verified. Application passes
  with `VITEST_MAX_WORKERS=2`; affected activity browser checks pass after nesting Shared
  folders. Its active route reveals the group, keyboard order follows the hierarchy, and
  activity fetch failures preserve its existing quiet state. Workflow checks pass.
- The extended browser scenario initially reached its 60-second limit at the final route.
  Replaced a redundant route visit with Shared folders coverage; rerun passed at the same limit.
  Hosted CI for the preceding commit could not start because of GitHub billing/spending limits.
- Initial lint stopped on concurrent deployment/auth edits. Updated the existing flat-menu
  unit test; unrelated UI timeout failures passed with reduced concurrency and intact gates.
  No worker behavior changed or deployment performed; unrelated changes preserved.

## MCP access and file management: ready for review

- All four authorized stages implemented on `codex/mcp-access-management`. New tokens select a
  login, Read/Organize/Full mode and allowed folders. Create a replacement token for the new
  permissions; existing tokens retain legacy access. [MCP documentation](../MCP.md) covers
  tools, migration and limits; [delivery evidence](STATUS-history.md#2026-09-12-mcp-access-and-file-management).
- Application, affected browser, indexer and workflow checks pass. Integration tests all pass
  across the full run and a composition rerun after a disposable database failed during setup.
  Real SFTPGo/WebDAV operations and the web-origin MCP connection are verified;
  the token form was inspected visually. No deployment performed.
- Reads/uploads/edits have a 4 MiB cap. SHA-256 guards MCP edits within one API process;
  external clients can still race the provider write. No permanent deletion or public sharing.
- Unrelated System activity planning and `.playwright-mcp/` artifacts are preserved.

## About page project information

- Worktree `/private/tmp/fdrive-project-info`, branch `codex/project-info`, based on
  `origin/main` at `26bc01e`; primary checkout changes preserved.
- About shows the API build's commit link and sampled API uptime, GitHub, the macOS app
  guide, Buy Me a Coffee, and ten feature guides. Existing attribution and provider-host
  privacy remain intact. [Build metadata and uptime](../../deploy/REFERENCE.md#running-version-and-uptime).
- Application lint/typecheck/coverage pass (`step.hG5vxd` coverage); all five About browser
  checks pass (`step.XrLJud`), including 320–1280px/light/dark and 44px resource links.
  Live Next dev + disposable PostgreSQL/SFTPGo verified desktop and mobile content/scrolling.
  All 497 integration tests pass (`step.aWI1oK`). A production API image builds and reports
  the supplied Git revision from both its runtime module and OCI label; temporary image removed.
- macOS opens the app guide; no GitHub release was published at the time. No deployment or
  hosted Actions changes; the temporary live dev stack was stopped after verification.

## System sidebar activity: shipped

Merged via PR #14 (`b38690e`); implementation `ab18549`. Original checkout work preserved.
[Behavior and contracts](../SYSTEM-ACTIVITY.md); [verification evidence](STATUS-history.md#2026-09-12-system-sidebar-activity).

- Per-section spinners, fixed-workload percentages, accessible details, runtime transitions
  and immediate mutation feedback. Indexer/OCR provide lightweight in-memory snapshots.
- Passed: application, integration, indexer/OCR Python, final web package, workflow and all
  20 affected browser cases. Real worker/dev-app smoke: 120 images rebuilt, zero errors;
  progress visible through navigation and idle after completion. Light/dark/mobile reviewed.
- OCR/clear jobs retain unknown totals and show live counts. Merged.
  Test runner pins its own Docker image to avoid worktree races.

## Findings repair: ready for PR review

- Branch `codex/findings-20260912`, isolated from the original checkout's MCP WIP.
- Addressed 46 supplied findings covering downloads, archives, providers, UI state and workers.
  Three MCP WIP findings are deferred; unrestricted legacy-token compatibility is unchanged.
- Application, integration, workflow, 32 affected browser tests and all four Python service gates pass.
  Live Next dev inspection confirms keyboard selection and draft recovery/save.
- Complete dispositions, evidence and remaining provider limits:
  [FINDINGS-2026-09-12.md](FINDINGS-2026-09-12.md). Next: review and merge the PR.

## Preflight allowlist for processing worker resource keys: complete on main

- A beta tester reported on 2026-09-12 that `deploy/preflight.sh` rejects every resource key
  `compose.yaml` interpolates since the resource-cap commit (1fb84a2): the six `FDRIVE_*_CPUS`
  and `FDRIVE_*_MEMORY` pairs, `FDRIVE_EMBED_THREADS`, `FDRIVE_IMAGE_EMBED_THREADS` and
  `FDRIVE_TIKA_JAVA_OPTS`, 15 keys in all, so `update.sh` refuses a `.env` that follows
  REFERENCE.md. Cause: the allowlist is generated from `DEPLOY_EXTRA_KEYS`, and that commit
  documented the keys in REFERENCE.md without adding them to the table.
- Fix: the 15 keys are `DEPLOY_EXTRA_KEYS` entries and `pnpm env:example` regenerated the
  allowlist; the other generated files are unchanged. Two new tests close the gap: preflight
  accepts a `.env` setting all 15, and every `${FDRIVE_*}` reference in `compose.yaml` and the
  production overlays must be a known key, which is the check that was missing.
- Follow-up: `.env.example` is the quick-start template and lists only the secrets by design,
  so the keys are not added there; its header pointer now also names REFERENCE.md's processing
  worker resource limits, which is the only cue an operator reading the template alone gets.
- Evidence: `pnpm test:deploy:coverage` 60/60 at 100% coverage, `tsc -p tools/deploy`,
  `biome check tools/deploy/`. Dropping one key from the allowlist or the table makes the new
  tests fail.

## GitHub Actions budget: scaled down (2026-09-12)

- **Evidence**: private repository on the free plan (2000 minutes/month). The 30 days to
  2026-09-12 billed ~2530 minutes (CI 2282, Performance 217, Office 34) and runs now fail
  at start with the spending-limit message. A CI run cost ~30 minutes over seven jobs
  (e2e 664 min/month, check 582, indexer 338, integration 325); 60 % of CI minutes were
  push-to-main runs duplicating the PR run, and rapid pushes stacked without cancelling.
- **Change**: `CI` runs only `application` on pull requests (docs/agent-config paths
  ignored, superseded runs cancelled, ~8 min). New `Python services` runs indexer/ocr only
  when `services/**` or the Python helpers change. New `CI (full)` holds the previous seven
  jobs, gated on the `ci:full` PR label or `workflow_dispatch`. `Performance budgets` and
  `Real Office editors` are `workflow_dispatch` only (both were already disabled by hand;
  re-enable them after merge so dispatch works). No workflow runs on push to `main`.
  Timeouts trimmed to ~2x the observed maxima; failure artifacts kept 7 days; the
  always-on coverage artifact upload was dropped (nothing consumed it).
- **Expected spend**: ~10 PR-runs-a-week × 8 min ≈ 350 min/month plus opt-in full runs.
- **Trade-off**: a direct commit to `main` gets no automatic check; run
  `gh workflow run CI --ref main` (or `"CI (full)"`) when one is wanted.

## WebDAV storage provider: complete on PR #5, awaiting merge

Branch `feat/webdav-provider`, PR #5. Durable documentation: [WEBDAV.md](../WEBDAV.md),
[STORAGE-PROVIDERS.md](../STORAGE-PROVIDERS.md), [TRASH.md](../TRASH.md); the plan is removed.
Per-slice evidence for slices 1–4 (package, adapter and module, registration, real-server
conformance, manual browser pass) is archived in [history](STATUS-history.md).

- **Done (slice 5, Trash)**: `webdavModule` declares `trash: "move"` and the `trash`
  capability, so the API storage factory moves deleted files into the configured folder and
  serves list/restore/purge/empty from it. `TrashSettings` (contracts) now carries the active
  provider module's `strategy` (`native` | `move` | `none`) next to the stored configuration
  (`TrashConfiguration`, unchanged on disk); the refinement requires confirmed rules only for
  `native` and refuses enabling for `none`. The settings service reads the strategy from the
  provider module per request, refuses an update whose strategy no longer matches (conflict),
  and reports a stored row as disabled when the current strategy would not allow it. The
  Trash settings card keys its copy on the strategy: SFTPGo rules, link and confirmation
  checkbox for `native`; "fdrive moves deleted files" copy with no checkbox for `move`; a
  disabled switch and "no Trash" copy for `none`. TRASH.md gained a section for providers
  where fdrive performs the move.
- **Evidence (slice 5)**: `@fdrive/webdav test:integration` 20/20 against the SFTPGo WebDAV
  container, including a new round trip (delete dir and file, list, restore, purge, empty)
  through `withMoveToTrash` + `createRecycleFolderTrash` as the factory composes them.
  `browser e2e/trash.spec.ts` gained a WebDAV scenario in the isolated Trash environment:
  add the SFTPGo WebDAV binding as a row, link and switch to it, enable Trash from the
  "move" card (no rule checkbox), move a file to Trash from the listing, restore it from
  `/trash`, and read its contents back. Gates on 2026-09-12: `package @fdrive/contracts`,
  `application`, `integration`, `workflow` and `browser e2e/trash.spec.ts --workers=1` all
  pass (the web coverage step needed two reruns under a load average near 30 from other
  checkouts' gates: 5 s test timeouts in untouched `search-panel`, `office-actions` and
  `capability-gating` suites, each passing alone).
- **Found on the way**: Trash settings belong to the active login's row, and
  `FDRIVE_ADMIN_USERS` makes someone admin only while their SFTPGo login is active, so a
  WebDAV row's Trash can only be configured by an owner account from the setup claim. The
  browser scenario grants that flag directly in its disposable database; TRASH.md documents
  the limitation and FOLLOWUPS carries the decision (explicit provider choice on the settings
  endpoint and card, or account-wide environment admins).
- **Known**: GitGuardian on PR #5 flags two fake test passwords in an earlier commit's
  history; the current tree no longer contains those patterns, and history is not rewritten
  here, so the incidents need dismissing in the GitGuardian dashboard. The two pre-existing UI
  issues found during the manual pass (Base UI `Select` trigger showing the raw value; a
  non-admin opening `/system/*` by URL) were fixed on `main` (PRs #6 and #7) and are merged
  into this branch.

## Move to Trash busy indicator: complete (uncommitted, `claude/trash-loading-indicator-c30eb5`)

- Moving a large folder or selection to Trash gave no feedback while the single delete request
  ran. `DeleteDialog` now shows a spinner with progressive copy on the confirm button
  ("Moving to Trash…" / "Deleting…", from `deleteDialogCopy().pendingLabel`), disables Cancel,
  and ignores Escape while `pending`, so the indicator stays visible until the request settles.
  Both call sites (`file-browser.tsx`, `virtual-listing.tsx`) already pass `remove.isPending`.
- Verification: `package @fdrive/web` (lint, typecheck, coverage) and `browser e2e/trash.spec.ts`
  pass; the spec now holds the delete request back to assert the busy state. `application`
  coverage hit unrelated timeout flakes under a load average around 20 (untouched search-panel,
  office-actions and trash queries tests); each passes in isolation.
- Limitation: the request is one round trip, so there is no per-item progress, and the dialog is
  modal for its whole duration. A non-blocking loading toast is the alternative if that matters.

## HEIC/HEIF viewing and indexing support: complete

- **Non-destructive storage**: Original `.heic` and `.heif` files remain bit-for-bit untouched in SFTPGo storage; no on-upload conversion.
- **Backend & indexing**:
  - `packages/contracts`: `.heic`/`.heif` added to `IMAGE_EXTENSIONS` (`isImageFileName`).
  - `apps/api`: `.heif` added to `PRECOMPRESSED_EXTENSIONS` in archive stream utils.
  - `services/indexer`: `pillow-heif>=0.18` added; registered opener idempotently before PIL reads; `.heic`/`.heif` added to `IMAGE_EXTS` in chunking (enabling 256/1024px WebP thumbnails, OCR, and SigLIP visual embeddings).
- **Frontend & CSP compliance**:
  - `apps/web`: Production CSP unchanged (`script-src 'self' 'unsafe-inline'`); `heic-to/csp` is a wasm2js build running in the existing `worker-src blob:` allowance, so no `'wasm-unsafe-eval'` is needed.
  - `apps/web/src/lib/preview/heic.ts`: `fetchHeicAsJpeg` enforces the 50 MiB cap on the known size, `Content-Length`, and the streamed body (shared `boundedBody`) before `heic-to/csp` decodes.
  - `ImageViewer`: derives HEIC from the file name, renders `<picture><source type="image/heic">` for native Safari decoding, shows the 1024px WebP thumbnail elsewhere, decodes on zoom or thumbnail 404, aborts an in-flight decode on unmount, keeps the thumbnail with an error pill when decoding fails, and reuses `Unsupported` when nothing can be shown. Inspector shows the 256px thumbnail for HEIC.
  - Public shares & galleries: Single-file HEIC shares automatically present in gallery mode with lightbox viewing; directory listings expose the preview button.
- **Verification**: `python indexer`, `package @fdrive/contracts`, `package @fdrive/web`, `application`, `workflow`, and `browser` (`preview.spec.ts`, `grid-thumbs.spec.ts`, `shares.spec.ts`) all pass.

## Beta field report (clean install, 2026-09-11): fixed

- **No worker had a CPU bound** (addendum widened this from `embed` alone). `deploy/compose.yaml`
  now sets thread counts explicitly where the amplification is thread-based —
  `FDRIVE_EMBED_THREADS` / `FDRIVE_IMAGE_EMBED_THREADS` (default 4) and `OMP_THREAD_LIMIT=1`
  on the indexer, whose `pytesseract` children each parallelised across every core on top of
  `INDEX_WORKERS` — and exposes opt-in `cpus:`/`mem_limit:` knobs on `indexer`, `ocr`, `tika`,
  `onlyoffice`, `embed` and `image-embed`. The hard caps default to 0/no limit because Docker
  rejects a `cpus:` above the host's core count; `tika` also gained `FDRIVE_TIKA_JAVA_OPTS`.
  Table in `deploy/REFERENCE.md#processing-worker-resource-limits`.
- **Controllers served `ready` with a stale `error`.** Neither the restart path nor
  `reconcile`'s ready branch cleared `_error`, so a worker stopped transiently (an api
  recreate during `update.sh`) kept a resolved reason attached until the retry window elapsed.
  Cleared on both paths in **both** `controller.py` and `office_controller.py`, which had the
  identical bug; regressions in each controller's tests.
- **Overload fed back into the controllers.** A loaded host slowed the api, the controller's
  2 s poll timed out, and 9 s of that stopped a healthy model child — whose reload loaded the
  host further and made the indexer log a connection error per file. `FeatureClient`/`OfficeClient`
  timeouts are now 5 s, and the poll loop separates a rejected document (fails closed after
  `FDRIVE_RUNTIME_STALE_SECONDS`, still 9 s) from an unreachable endpoint
  (`FDRIVE_RUNTIME_UNREACHABLE_SECONDS`, default 60 s) via a new `EndpointUnavailable`. Both
  still fail closed, and the stop reason now names which happened.
- **Not a bug: the api's health derivation.** `runtimeFailure` already requires the controller's
  `status` to be `failed` and never reads `error` on its own (`apps/api/src/system/runtime-status.ts:63`),
  and `controllerVerdict` only consults a controller when the sidecar itself is unreachable.
  The reported `search: failed` was accurate at probe time — the child really had been stopped
  by the loop above — and `/health` caches a fan-out for 15 s, so a later `/runtime` read can
  disagree with it.
- **Indexer hammered an absent embed backend.** One connection error per file (176 lines in
  one observed window). New `embed_backoff.py` gate: the first transport failure pauses
  embedding for 60 s and logs once, files keep their FTS chunks as `partial`, recovery logs
  once. `HTTPStatusError` and other answers from a live backend stay per-file.
- **`deploy/README.md` step 2** told a first-time operator to clone a private repo over
  anonymous HTTPS. Now the SSH form, with the access prerequisite stated.
- **CI never built the deployment images.** New `images` job builds `apps/web/Dockerfile` and
  `apps/api/Dockerfile`; both verified building locally. The two TypeScript errors the reporter
  hit were caught by CI's existing typecheck, but only after the push to `main` — the window in
  which an operator pulls a `main` that does not build is a direct-to-main consequence, not a
  missing check.
- Not reproduced: `docs/workflow/P10-WEBDAV.md` no longer exists, and `docs/STORAGE-PROVIDERS.md`
  already states WebDAV is unimplemented.
- Left alone: `indexer.wait_for_embed` is dead production code (tests only). The backoff gate
  supersedes it; removal is a separate cleanup.
- Gates: `workflow`, `python runtime`, `python indexer` all pass; both deployment images build. No application/browser change.

## 65-finding code audit: complete

- All 65 user-supplied findings resolved on `main`, one dedicated subagent per finding and a
  separate commit per fix. 50 fixed, 12 rejected with evidence, DB-03 covered by DB-01/02,
  SEC-08 real but deliberately unfixed, FS-06 an upstream limitation.
- Per-finding verdicts, evidence and limits: [BUG-AUDIT-2026-09-11.md](BUG-AUDIT-2026-09-11.md).
- Final gates on `main`: `application`, `integration` (real PostgreSQL and SFTPGo containers),
  affected `browser` specs, and `workflow` all pass.
- Two reported root causes were disproved rather than implemented: SEC-04's username fan-out
  does not reproduce (the exhaustible axis is IPv6 /64 address supply), and DB-10's 32-bit
  local column does not exist, since SFTPGo owns that value and the bundled SQLite provider
  is unaffected.
- Open for the maintainer: SEC-08 needs either edge rate limiting keyed by IPv6 /64 or a
  minimum share-password strength; both are deployment or product decisions, not audit fixes.
- Issue patches, the per-finding ledger and verification logs: `.fdrive-workflow/audit-20260911/`.

## Issue #2: remaining findings

- Findings 4, 6, 14 and 15 remained relevant and are now committed on `main`.
- Added five non-partial FK indexes in migration `0002_foreign_key_indexes`; existing
  primary/unique indexes already cover the other reported columns. PostgreSQL catalog
  regression verifies a usable leading-column index for every app FK, including SET NULL.
- Identity overrides accept only indexed roots plus their own provider's template root;
  installation-wide shared mappings retain the union. Cross-provider regression passes.
- About attribution includes disabled configured provider types; enabled login connections
  and endpoint privacy remain separate. Unit, composed-app and browser regressions pass.
- Auth fixtures preserve original session age across switch/rotate/unlink, keep lastSeenAt
  consistent, clear cached tokens on verified login/link, and remap used tags on transfer/unlink
  while retaining destination tag colors and other identities' metadata.
- Application lint/typecheck and all package/tool coverage pass with bounded concurrency
  (`.fdrive-workflow/logs/step.k5nzVY/`). The first default-worker coverage run failed with
  `Streamable HTTP error: Error POSTing to endpoint: auth required` in the MCP fixture
  (`step.VG6vco`); no production MCP change or relaxed gate was made.
- Full integration passes (DB 274, API 35, SFTPGo 72, testkit 9; `step.6iyNZq`). About and
  account-scope browser tests pass 6/6 on the disposable Next dev stack (`step.EKL5gx`).
- Live Next dev inspection passed with disposable SFTPGo/Postgres: all providers disabled,
  attribution visible, enabled-provider list empty and setup complete. Screenshot:
  `.fdrive-workflow/evaluation/issue2-about-disabled.png`.
- First workflow attempt hit the unchanged mock-startup regression assertion
  `missing pnpm <--filter> <@fdrive/api> <dev>` (`step.TRXZTY`); full workflow rerun
  passed unchanged, including lint and diff checks.
- Committed and pushed as `df51078` (FK indexes), `dd7e781` (about attribution),
  `2b9bedc` (identity override roots) and `093b71b` (auth fixtures); the first eleven
  findings were already pushed. No GitHub issue closure performed.

## Agent configuration and guard

- Instruction files are split by audience. `AGENTS.md` (read by Codex, and by Claude through
  `CLAUDE.md`) and `WORKING.md` are runtime-neutral; delegation, roles, model policy and
  worktree handoffs moved to `docs/workflow/ORCHESTRATION.md`, which now has a section per
  runtime. `CLAUDE.md` imports all three, so Claude Code sees what it did before.
- Codex 0.153.4 does have subagents (`spawn_agent`; the `multi_agent` feature is stable and on,
  `multi_agent_v2` is off, so V1 settings apply). Worker model and effort are pinned in
  `.codex/config.toml` under `[agents]` to `gpt-5.6-sol` at `high`; without it subagents
  inherit the primary model. The table name was confirmed by type-error probe, not docs.
- `.codex/config.toml` also registers the same PreToolUse guard. Codex ships the matching
  `PreToolUseHookSpecificOutputWire` schema, so the guard's deny payload is understood by both
  runtimes; its matcher is `.*` because Codex tool names differ from Claude's.
- The guard now dispatches on payload shape when it does not recognise the tool name: a
  `command` string is a shell call, a path plus replacement content is an edit, a path alone is
  not. Covered by new cases in `test-guard-tool-use.sh`.
- Unverified: no Codex session has exercised the hook yet, so hook trust (Codex records a
  `trusted_hash` per command) and the real tool-call payload shape are unconfirmed. The
  lockfile rule may need a field name added once a Codex edit payload is observed.

- Added `CLAUDE.md` importing `AGENTS.md` and `WORKING.md`: Claude Code loads `CLAUDE.md`, not
  `AGENTS.md`, so the working agreements were not reaching sessions before this.
- `implementer` and `test-writer` carry tool allowlists; neither can delegate. Added read-only
  `explorer` (sonnet, medium effort) for evidence gathering.
- A PreToolUse guard (`tools/orchestration/guard-tool-use.{sh,py}`, registered in
  `.claude/settings.json`) refuses SHA-less stash operations, `git reset --hard`,
  `git clean -f`, `git push --force`, lockfile hand-edits and session links. Commit and merge
  paths are untouched, so `merge-chunk.sh` is unaffected. The same rules stay stated in
  WORKING.md so they are known before an attempt.
- Step logs prune to a count cap, `FDRIVE_LOG_RETENTION_COUNT` (default 300, `0` disables,
  malformed values prune nothing). An age window was tried first and did not bound size at
  the rate these accumulate; the cap holds at roughly 4 MB regardless of rate. Covered by
  `test-log-retention.sh`.
- Added a `/fdrive-verify <profile>` skill that runs a profile in the current checkout. The
  name avoids a collision: a bundled Claude Code skill owns `/verify` and shadows a project
  skill of that name, which is not obvious from the failure. Agents may still call
  `verify.sh` directly, as WORKING.md directs.
- `verify workflow` passes, including the new `test-guard-tool-use.sh` regression group.
  This change is configuration, documentation and workflow tooling only; no application,
  browser or security verification is claimed.

## Documentation cleanup

- Added the storage-provider developer guide; removed five obsolete P10 briefs.
- Removed completed P2–P9/UX/onboarding briefs and the mixed root plan. Unfinished features,
  fixes/verification and deferred ideas now have separate documents under `docs/plans/`.
- Preserved current scope/Office/security contracts in developer references, moved dated
  handoffs to history and updated source-comment/document links.
- Cleanup passed the workflow gate and local link/anchor checks; independent backlog review
  confirmed remaining requirements survived. Existing application/test/pentest diffs were
  preserved exactly. The earlier provider guide also passed its TypeScript example typecheck.

## Checkout

- `main`; only the remaining issue #2 fixes and their verification notes are uncommitted.
- Earlier provider/auth/pentest and documentation changes were committed and pushed before
  this follow-up. Detailed historical security findings remain in
  [pentest findings](SHANNON-PENTEST-FINDINGS.md).

## Established verification

- Phase 5 full strict performance passed, including search25k p95 195.82 ms (<300).
- Provider binding has integrated two-HTTP-server fixture coverage (SFTPGo fakes).
- Remaining feature/verification gaps are listed in plans; completed work and old worker
  assignments must not be restarted from historical briefs.

## Destination picker folder creation

- Worktree `/private/tmp/fdrive-destination-new-folder`, branch `codex/destination-new-folder`.
- Shared Move, Copy, Extract, archive destination and Restore pickers offer New folder.
  Creation uses the displayed directory, enters the returned folder and waits for the
  operation's confirmation. Cancellation, failed-name retry and source restrictions remain.
- Folder naming rejects unsafe path segments; pending creation blocks duplicate submissions
  and dismissal. Long breadcrumbs truncate with full-name hover text; mobile actions are 44px.
- All 30 affected Chromium browser checks pass on Next dev with disposable PostgreSQL/SFTPGo
  and WebDAV (`step.ZGlqwv`), including creation in all five destination modes. Light/dark
  screenshots at 320/402/1280px reviewed under `.fdrive-workflow/evaluation/destination-picker/`.
- Final application lint/typecheck/coverage pass (`step.tYRT79` coverage). Workflow helper
  regressions, lint and diff checks pass. No production or hosted Actions changes.
