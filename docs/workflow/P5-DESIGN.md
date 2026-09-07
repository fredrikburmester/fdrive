# Phase 5 architecture and queue

Primary decisions for autonomous continuation, 2026-09-06. Implement only after
Phase 4 shared contracts/composition settle; prepare disjoint repositories first.
Configurable embedding provider/model remains excluded.

## Accounts and identities

Link verifies the new SFTPGo username/password/TOTP through the existing rate-limited
login flow. Never trust an identity ID as proof of ownership. A new identity joins
the current account; an already-linked identity is idempotent. If those credentials
already belong to another fdrive account, transfer ONLY that identity, never all
identities/admin status of the source account. This must be an atomic transaction.
Preserve its favorites/recents/shares. Copy only its used tag definitions into the
target account, remapping file tags; name collisions reuse target tags. Unrelated
source-account tags/identities remain unchanged. Revoke source sessions and tokens
scoped to the transferred identity; never transfer API tokens. Rotate the linking
browser session after privilege context changes. Do not delete source accounts.

Unlink requires at least one other linked identity. Move the identity to a fresh
independent account with its metadata rather than deleting credentials/files or
making future login inaccessible. New account is not admin; configured admin
usernames keep their existing behavior. Revoke affected tokens/sessions, select a
remaining active identity, return updated MeResponse. Browser clears identity-keyed
queries and aborts old requests after switch/link/unlink to avoid mixed views.

Switch validates ownership and persists the session's active identity. Existing
explicit identity header remains supported. Account-wide favorites/search return
identity IDs with every entry, query only owned identities, and keep per-identity
authorization. Bounded concurrency and result limits; identical virtual paths from
different identities remain distinct. Navigating a result selects its identity.

API-token UI already exists; verify create/show-once/revoke with multiple identities
and ensure a transferred/unlinked identity cannot authenticate old tokens.

## Scope verification gap

PLAN §4 promised login scope verification and stored identity overrides; current
code derives template-only scopes. Close that gap before marking Phase 5 complete.
Scope configuration grants access to index-derived content and therefore is an
admin-controlled mapping, not arbitrary unprivileged filesystem input. The account
page may display mapping/status. Verify candidate mapping against live SFTP root
and indexer directory listing; mismatch disables index-backed endpoints with a
clear warning. Apply one resolver consistently to search, thumbnails, duplicates,
MCP, metadata events and office canonical locations. Keep ordinary SFTP browsing
available when mapping is invalid or missing. Tests use a deliberately wrong home
template and assert another user's snippets/previews never leave the API.

## Shares

SFTPGo remains source of truth for share auth, permissions, password, expiry and
download-count limits. fdrive stores only its own share UUID, identity, upstream
share ID, metadata and hasPassword; never share passwords. Creation/update/deletion
uses owner's current SFTP credentials and records changes only after upstream
success; handle partial failure explicitly with compensation/reconciliation.

Public routes use app UUIDs, resolve stored upstream IDs, proxy through configured
SFTPGo only. Browser never receives private upstream host or upstream credentials.
Password goes in HTTP Basic per request; don't put it in URL/local storage/logs.
Client session memory can retain it while navigating a share. Rate limit unknown
IDs/password attempts and uploads by client key; no trusting arbitrary proxy IP.
Propagate Range/content length/disposition and stream bytes without buffering.
Public listing and file paths stay within share roots, normalize strictly, reject
traversal/encoded separators where ambiguous. Upstream share permissions remain
final authority. Write-only shares reveal no listing/content. Never call owner
download/upload as a fallback for failed public-share requests (would bypass limits).

Share management UI: create read/download or upload link, choose selected paths,
optional password/expiry/download count, copy app URL, revoke. Public page /s/:id
supports password, directory browse, preview/download/zip, upload queue/drop zone,
and plain expired/exhausted/unavailable feedback. All controls use existing shadcn.

## Performance

Run existing full perf suite in strict mode; record measurements, not guessed wins.
Extend missing PLAN budgets: browser10k entries interactive <500ms after data, search25k p95<300ms,
RSS for2GiB transfer <200MiB, concurrency/upload throughput. Make CI budgets
blocking only once the real representative workload exists. Missing measurements
cannot count as pass. Zero-copy path only if measured streaming budget fails;
then short-lived identity/path/range-bound signed URLs and proxy validation must
preserve all authorization and never expose credentials. Do not bypass failing
performance tests by loosening limits or switching to fakes.

## Worker sequence

1. Accounts repository transaction + integration (DB-only, after office registry).
2. Shares repository + typed API/contracts (after office contracts).
3. Scope resolver/indexer verification (API/Python, isolated from account composition).
4. Accounts API/cross-identity views; corresponding web UI after interfaces settle.
5. Public-share web UI, full real-stack Playwright, strict performance/CI.
