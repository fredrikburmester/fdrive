# Fixes and verification still open

Carried from historical handoffs and checked against source on 2026-09-11. These are not
completed work or claims of newly reproduced runtime failures.

| Item | Current evidence | Completion |
| --- | --- | --- |
| Let environment admins configure Trash for non-SFTPGo rows | [Trash settings routes](../../apps/api/src/trash/settings-routes.ts) resolve the row from the caller's active login, and [auth](../../apps/api/src/auth/service.ts) grants `FDRIVE_ADMIN_USERS` admin only on the SFTPGo login, so a WebDAV row's Trash is configurable only by an owner account from the setup claim ([TRASH.md](../TRASH.md)) | Decide between an explicit provider choice on the Trash settings endpoint and card, or account-wide environment-admin status; cover with an API test and the WebDAV Trash browser scenario in `e2e/trash.spec.ts` without its direct database grant |
| Exclude nested Trash from folder totals | [folder-size](../../apps/api/src/fs/folder-size.ts) rejects the requested Trash path but calls `subtreeSize` without nested-trash exclusions | Parent totals omit Trash contents; cover scoped/shared mounts and disabled Trash |
| Explain partial text-search results | [search panel](../../apps/web/src/components/search/search-panel.tsx) shows the image partial notice; text response also carries `partial` | Display an accurate text-result omission notice independently of image state; browser regression |
| Large-transfer memory verification | Historical requirement: 2 GiB transfer with RSS below 200 MiB; current harness measures 512 MiB throughput, not RSS | Measure API RSS and complete payload integrity on 2 GiB upload/download, preserve streaming/range/cancellation behavior; report environment and results |
| S3 provider: second self-hosted target in CI | [S3.md](../S3.md) records MinIO as the only CI backend; Garage, SeaweedFS, RustFS, Ceph RGW and the hosted buckets are intended targets without a recorded pass | Add a Garage container to `@fdrive/testkit` (single-node layout, one bucket and key through its CLI) and run `packages/s3`'s conformance suite against it; run the suite by hand against the hosted targets once and fill the compatibility table; turn every deviation into a fake toggle and unit test |
| S3 provider: bounded or queued large-folder Trash | Moving a folder to Trash on S3 copies every object; [S3.md](../S3.md) caps directory operations at 100 000 keys and otherwise lets the request run | Decide between refusing Trash for folders over a fixed object count with permanent delete still offered, or a queued move with progress (the guide records no non-atomic move job yet); cover with an API test |
| S3 provider: objects over 5 GiB | `CopyObject` refuses larger sources; the adapter answers `payload_too_large` before touching them | Implement `UploadPartCopy` in 1 GiB ranges for copy and move, with a fake toggle and a sparse-object MinIO test |
| System settings live dev verification | Historical P9 handoff records automated checks but no real dev-stack pass | Exercise General, feature settings, Office, Shared folders and event log against the running dev stack; record actual evidence |

The provider-binding integration gap and Phase 5 strict performance gap are closed. Provider binding uses two HTTP servers
backed by SFTPGo fakes; do not describe that as two containerized upstream implementations.
No new benchmark or browser run was performed during this documentation audit.

Security reports follow [SECURITY.md](../../SECURITY.md); do not track them here.
