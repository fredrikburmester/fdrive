# Fixes and verification still open

Carried from historical handoffs and checked against source on 2026-09-11. These are not
completed work or claims of newly reproduced runtime failures.

| Item | Current evidence | Completion |
| --- | --- | --- |
| Exclude nested Trash from folder totals | [folder-size](../../apps/api/src/fs/folder-size.ts) rejects the requested Trash path but calls `subtreeSize` without nested-trash exclusions | Parent totals omit Trash contents; cover scoped/shared mounts and disabled Trash |
| Explain partial text-search results | [search panel](../../apps/web/src/components/search/search-panel.tsx) shows the image partial notice; text response also carries `partial` | Display an accurate text-result omission notice independently of image state; browser regression |
| Expose visual image search through MCP | [tools](../../apps/api/src/mcp/tools.ts) has semantic `similar_files`, no visual-image search tool | Reuse image query/scoping/authorization and report unavailable/partial states; MCP contract and integration checks |
| Large-transfer memory verification | Historical requirement: 2 GiB transfer with RSS below 200 MiB; current harness measures 512 MiB throughput, not RSS | Measure API RSS and complete payload integrity on 2 GiB upload/download, preserve streaming/range/cancellation behavior; report environment and results |
| System settings live dev verification | Historical P9 handoff records automated checks but no real dev-stack pass | Exercise General, feature settings, Office, Shared folders and event log against the running dev stack; record actual evidence |

The provider-binding integration gap and Phase 5 strict performance gap are closed in
[delivery history](../workflow/STATUS-history.md). Provider binding uses two HTTP servers
backed by SFTPGo fakes; do not describe that as two containerized upstream implementations.
No new benchmark or browser run was performed during this documentation audit.

Active security findings remain in [pentest findings](../workflow/SHANNON-PENTEST-FINDINGS.md);
do not duplicate their changing status here.
