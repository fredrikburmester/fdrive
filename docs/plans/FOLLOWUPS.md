# Fixes and verification still open

Carried from historical handoffs and checked against source on 2026-09-11. These are not
completed work or claims of newly reproduced runtime failures.

| Item | Current evidence | Completion |
| --- | --- | --- |
| Exclude nested Trash from folder totals | [folder-size](../../apps/api/src/fs/folder-size.ts) rejects the requested Trash path but calls `subtreeSize` without nested-trash exclusions | Parent totals omit Trash contents; cover scoped/shared mounts and disabled Trash |
| Explain partial text-search results | [search panel](../../apps/web/src/components/search/search-panel.tsx) shows the image partial notice; text response also carries `partial` | Display an accurate text-result omission notice independently of image state; browser regression |
| Large-transfer memory verification | Historical requirement: 2 GiB transfer with RSS below 200 MiB; current harness measures 512 MiB throughput, not RSS | Measure API RSS and complete payload integrity on 2 GiB upload/download, preserve streaming/range/cancellation behavior; report environment and results |
| Office reported ready before its document service has settled | On an installation updated on 2026-11-12, the bundled ONLYOFFICE restarted its document service once about three minutes after starting, two minutes after `deploy/wait-ready.ts` had reported Office ready. This is the stock image's behaviour | Decide whether readiness should wait for that restart (the controller's ready check, or `wait-ready.ts`), so a document opened right after an update does not drop once; verify on a fresh start of the bundled Office |
| System settings live dev verification | Historical P9 handoff records automated checks but no real dev-stack pass | Exercise General, Users, feature settings, Office and event log against the running dev stack; record actual evidence |
| Mac change feed on a live server | Unit tests cover the [feed](../../apps/api/src/desktop/changes.ts)'s anchors and folder mapping; an [integration test](../../apps/api/test/integration/desktop-changes-local.test.ts) covers an upload, a move, a delete, a watcher row, a restore and a gap over a real files folder and Postgres; Swift tests cover the anchor's storage, resync and partial application. No signed app has used the feed against a live server, and the hourly full check's real cost is unmeasured | Run a signed app against a live server: changes made on the web and on the disk reach Finder, and a restore resyncs. Measure the hourly full check's requests and duration on a large location |

The Phase 5 strict performance gap is closed.
No new benchmark or browser run was performed during this documentation audit.

Security reports follow [SECURITY.md](../../SECURITY.md); do not track them here.
