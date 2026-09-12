# MCP review — 2026-09-12

Historical review of `feat/webdav-provider` at `1f045c1`. Request: establish whether MCP
works and supports reading, organizing, and full file management. The authorized repairs
and access expansion are now implemented; see [current behavior](../MCP.md) and
[delivery evidence](STATUS-history.md#2026-09-12-mcp-access-and-file-management).
The findings below describe the pre-implementation baseline.

The MCP transport and token flow work in local tests. Access is uneven: browsing works
without an index, but most other tools require verified SFTPGo index mappings. Full file
management is absent, and the existing move tool can overwrite files unintentionally.

## Current capabilities

| Workflow | Available now | Limit |
| --- | --- | --- |
| Connect | Streamable HTTP at `/mcp`; bearer token or `/mcp/t/:token` | Manual personal tokens; no OAuth flow |
| Browse | `list_directory` | One identity; maximum 2,000 entries, no continuation |
| Search | `search`, `find_files`, `find_duplicates`, `similar_files` | Verified index mappings required; no visual image search |
| Read | `read_file_text`, `file_info` | Text needs the indexer and enabled text search; metadata needs an indexed file; no direct original-file/image read tool |
| Understand folders | `folder_overview`, `index_stats`, `recent_moves` | Index-dependent; bounded aggregates and history |
| Organize | `create_folder`, `move_path` | Global `FDRIVE_MCP_WRITES=true`, verified scopes, provider permission |
| Full management | Not implemented | No file creation/upload/edit, copy, Trash/restore, tags/favorites, or share management tools |

The server always advertises all 12 tools, including both write tools when disabled.
Tokens are bound to one identity and never grant administrator access. There are no
per-token operation grants, folder restrictions, or explicit multi-identity access.
Enabling the global write switch also enables writes for previously issued tokens;
there is no way to keep one token read-only while another can organize files.
Long-lived fdrive tokens still depend on usable provider credentials: the documented
[SFTPGo HTTP TOTP limitation](../AUTH.md#known-limitation-sftpgo-totp-enforced-for-http)
can require signing in again when the upstream token expires.

## Findings, in repair order

### 1. High: moving onto an existing file silently replaces it

[`runMovePath`](../../apps/api/src/mcp/handlers.ts) calls `storage.move` at line 1059
without the destination check used by the REST move/rename routes
([`requireTargetFree`](../../apps/api/src/fs/routes.ts), line 201).

**Reproduced on real disposable SFTPGo 2.7.5:** `/destination.txt` initially contained
`EXISTING DESTINATION CONTENT`. MCP moved `/source.txt` onto it successfully; reading the
destination returned `SOURCE CONTENT`, and the source was gone. The REST guard rejected
the same occupied destination before the MCP call. The write permission switch is required.

Repair this before widening write access. Share the normal move conflict/no-op/descendant
policy; use an atomic no-replace operation where the provider supports it, and document
any remaining provider race rather than assuming a preflight check is atomic.

### 2. Medium: a completed move can be reported as failed

After changing storage, `runMovePath` awaits scope-root lookup and audit persistence
(lines 1061–1063). An exception becomes an ordinary MCP tool error through `wrap`.

**Reproduced:** force `recordMove` to throw `audit database unavailable`; the call rejects,
but the destination contains the moved data and the source no longer exists. The storage
mutation was real; the database failure was injected. Report mutation success separately
from bookkeeping failure, so clients do not blindly retry a completed operation.

MCP also bypasses the REST routes' immediate metadata and filesystem-event updates.
The indexer listener can reconcile later; immediate tag/favorite/Office/browser consistency
was not established here. Route mutations through a shared application service.

### 3. Medium: token creation can select the wrong login

[`CreateTokenDialog`](../../apps/web/src/components/account/create-token-dialog.tsx),
line 60, sends only name and expiry. [`TokenService`](../../apps/api/src/tokens/service.ts)
defaults omitted `identityId` to the account's first linked identity, not the active login.
The API accepts an explicit identity, but the dialog has no selector. A user viewing a
second provider can therefore create a token for the first provider instead. This is a
source-confirmed UI/service mismatch; the browser test covers only one identity.

Show provider plus login when creating a token, default to the active identity, and
display its effective access. Multi-identity access should be explicitly granted if added.

### 4. Medium: index availability controls ordinary file access

`read_file_text`, `create_folder`, and `move_path` require verified index scopes even though
storage can authorize those operations. `file_info` has no live-stat fallback. The resolver
explicitly rejects non-SFTPGo providers ([resolver](../../apps/api/src/scoping/resolver.ts),
line 173). Consequently, WebDAV can browse but cannot use these tools.

**Reproduced with an unavailable-scope fixture and real SFTPGo storage:** listing succeeds;
reading an existing text file and creating a folder both fail with `no_roots`.

Separate token/path authorization from index mapping. Provider-backed reads and mutations
should work within explicit grants; index-derived content must retain verified mappings
and live read checks. This changes the current write-scope policy and needs a documented
authorization design, not simply removal of `requireVerifiedScopes`.

### 5. Medium: text reads bypass the configured Trash exclusion

`runReadFileText` (lines 464–478) never applies `currentTrashPath`, unlike listing and the
other scoped tools. **Reproduced:** listing `/.Trash` is rejected, but reading
`/.Trash/old.txt` passes a real storage read probe and invokes extraction with
`alice/.Trash/old.txt`. The fake extractor's text is returned. This violates the ordinary
tools' Trash exclusion; it does not bypass the upstream identity's read permission.

Apply the same normalized Trash boundary to text reads. Expose Trash through explicit
tools if desired.

### 6. Medium: links and large-folder traversal are unreliable

[`urls.ts`](../../apps/api/src/mcp/urls.ts) concatenates raw paths. **Reproduced:**
`/report#draft?.txt` produces a URL whose pathname is `/view/report`; the rest becomes a
fragment. Encode individual path segments. `list_directory` always passes a null public
URL (handler line 380), so its links remain relative even when an external URL is set.

`list_directory` has no cursor/offset and always returns the first page. `find_files` is
likewise limited without continuation. Agents cannot reliably enumerate large folders or
result sets; add stable pagination while keeping bounded authorization. `move_path` and
`recent_moves` also guess file/directory kind from an extension, which misclassifies
extensionless files and dotted folder names; use storage metadata.

### 7. Medium: search hides incomplete or degraded operation

`runSearch` drops `SearchResponse.partial` and `degraded` at line 259.
**Reproduced with an injected service response:** a partial, keyword-only empty result
becomes simply `{ query: "missing", results: [] }`. The assistant cannot distinguish this
from a complete search finding nothing. Preserve status and actionable unavailability reasons.

## Proposed access model and delivery sequence

Support the three requested workflows with explicit per-token grants:

| Mode | Proposed capabilities |
| --- | --- |
| Read | Browse, original/text/image reads, metadata, text/visual search, duplicates |
| Organize | Read plus mkdir, move/rename, copy, tags/favorites |
| Full management | Organize plus create/upload/edit and Trash/restore; permanent purge and public sharing require explicit grants |

1. Repair the existing defects above and add permanent regression coverage.
2. Add token identity selection, operation/path grants, and an index-independent capability
   status tool. Enforce permissions server-side on every call and advertise usable tools.
3. Share provider-backed file services with REST, preserving conflict behavior, metadata,
   Office identity and browser events. Add bounded reads, pagination, image search and copy.
4. Add content writes and Trash operations with version/conflict preconditions and truthful
   outcomes. Keep ordinary file capabilities usable with indexing disabled and on WebDAV.
5. Verify each mode through real token creation, an MCP client, both provider types and
   observed storage/UI results; include revocation, forbidden paths and dependency outages.

Client integration also needs cleanup: `docs/MCP.md` labels a `claude mcp add` command as
Claude Desktop setup, but that command configures
[Claude Code](https://code.claude.com/docs/en/mcp#option-1-add-a-remote-http-server).
Document and test each supported client separately. Tool definitions lack read/write
annotations; add the applicable [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations)
as client hints, alongside server-enforced grants. OAuth is a possible later interoperability
improvement; manual bearer authentication itself passed the SDK checks.

## Verification and limits

All runs used the repository orchestration helpers. No deployed user storage was accessed.

| Check | Result | Log directory under `.fdrive-workflow/logs/` |
| --- | --- | --- |
| MCP/token unit and SDK-over-HTTP suites | 263 tests passed, 13 files | `step.KrYz8J` |
| MCP scope and provider-binding integration | 15 tests passed, 2 files | `step.R4ThlX` |
| Audit probes reproducing the defects/limits | 7 observations passed | `step.FoPXic` |
| Account token browser flow plus login setup | 2 tests passed | `step.wQHJM1` |

SDK tests use a real local HTTP transport with fake search/index/storage dependencies.
The MCP scope integration uses real PostgreSQL/SFTPGo with fake indexer verification and
extraction; provider-binding integration uses two fake upstream HTTP servers. Audit mutation
probes use real disposable SFTPGo, supplied verified scopes and injected index dependencies.
Browser verification covers account navigation, token creation, one-time display and revocation.

The first sandboxed unit attempt stalled and was stopped (`step.HhjmZ4`, exit 143); the
run with local networking enabled passed. This is not a production MCP failure.

No production connection, real assistant UI connection, real PDF/Office/OCR extraction chain,
or full application/coverage gate was exercised. Source was reviewed; application code was
not changed. Probe source/config remain in
[the local audit directory](../../.fdrive-workflow/mcp-review-20260912/).
