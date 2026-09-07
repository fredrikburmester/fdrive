# MCP server

fdrive exposes a [Model Context Protocol](https://modelcontextprotocol.io) server so Claude,
Raycast, and other MCP clients can search, browse, and (optionally) write to a user's share. It is
implemented in TypeScript inside `apps/api` (`apps/api/src/mcp/`), on top of the same search
service and storage abstraction the web UI uses, and replaces filesai's Python
`mcp_server.py` (see PLAN.md §2.2, §7).

## Endpoint

The MCP server is mounted **outside** `/api/v1`, so it is never behind the session/CSRF machinery
the rest of the API uses:

| Route | Notes |
|---|---|
| `POST /mcp`, `GET /mcp`, `DELETE /mcp` | Streamable HTTP transport, stateless, JSON responses. Requires `Authorization: Bearer <token>`. |
| `POST /mcp/t/:token`, `GET /mcp/t/:token`, `DELETE /mcp/t/:token` | Same, with the token in the URL path instead of a header, for clients that cannot set custom headers (claude.ai's web connectors). |

**The `/mcp/t/:token` URL is itself a secret.** Anyone who has it can act as that token's identity
for as long as the token is valid. Treat it exactly like the bearer token: do not paste it into a
public channel, ticket, or chat log.

A request with neither a valid `Authorization: Bearer` header nor a valid path token gets a plain
`401 {"error": "unauthorized"}` JSON response, before any MCP protocol handling happens.

## Auth

Tokens are created on the account page (`/account`, "API tokens" card) or via
`POST /api/v1/account/tokens` while signed in with a session; see `apps/api/src/tokens/`. A token:

- Starts with `fdr_`, is 32 random bytes base64url-encoded, and is shown exactly once at creation.
  Only its sha256 hash is stored.
- Is scoped to exactly one linked identity (an SFTPGo login), defaulting to the account's first
  identity when none is given explicitly at creation. Every MCP tool call is scoped to that
  identity the same way the web UI scopes a signed-in session: through `@fdrive/core`'s `Scope`
  and the `IndexQueries` scope predicates, so a token can never see another identity's files, even
  another identity on the same fdrive account.
- Can have no expiry ("never"), or 30/90/365 days from creation.
- Never grants admin access, regardless of the underlying account's `isAdmin` flag.
- Has `lastUsedAt` refreshed at most once a minute, so a busy client does not write on every call.

The account-page token routes (`GET`/`POST /api/v1/account/tokens`, `DELETE
/api/v1/account/tokens/:id`) are session-only: the principal resolver mounted on `/api/v1` never
resolves a bearer token, so a leaked API token cannot be used to manage other tokens.

## Tools

Every tool name and argument shape mirrors filesai's `mcp_server.py`, so existing prompts and the
Raycast extension keep working once repointed (below). Every tool validates its input with a zod
schema (enforced by the MCP SDK before the handler runs) and maps every error, expected or not, to
an MCP tool error (`isError: true` with a text message) rather than crashing the connection or the
server process.

| Tool | Purpose |
|---|---|
| `search` | Hybrid search (semantic + full-text + filename) over the identity's scope, backed by the same `SearchService` as the web UI's search panel. Filters: `path_prefix`, `ext`, `modified_after`, `modified_before`, `limit`. Results carry a `url` pointing at fdrive (`<FDRIVE_PUBLIC_URL>/view<path>`), snippets, and a relevance score. |
| `find_files` | Metadata-only lookup (no content): `name_contains`, `path_prefix`, `ext`, date range, `min_size_mb`, `order_by` (`modified_desc`\|`modified_asc`\|`size_desc`\|`path`), `limit`. Backed by the index, not live storage. `total_matches` counts only the files this call actually verified are readable right now, never a raw index count. |
| `list_directory` | Live listing through `principal.storage.list`, authoritative and always up to date, including files the indexer has not seen yet, and authorized by SFTPGo itself: works even when the index or its scope verification is unavailable. |
| `read_file_text` | Live text extraction via the indexer's internal `POST /extract` endpoint (`FDRIVE_INDEXER_URL`), only after a live download check passes. Supports `offset`/`max_chars` paging. Returns a tool error when `FDRIVE_INDEXER_URL` is not configured, the path is out of scope, or the read is denied (the same message either way, so a denial never discloses that a path exists). |
| `file_info` | Index metadata for one file (size, dates, hash, text status) plus every other readable path in scope holding an identical copy (same sha256). A read-denied file is reported exactly like an unindexed one. |
| `find_duplicates` | Groups of byte-identical, currently readable files, largest waste first, optionally scoped to a `path_prefix`. A group with fewer than two readable copies never appears; counts and wasted bytes are computed only from the copies that survive. |
| `similar_files` | Files whose average chunk embedding is closest to the given file's, for finding other versions of the same document. Requires the file to already be indexed and readable right now (the source file itself is live-read-checked, not only the candidates it is compared against). |
| `folder_overview` | Aggregate size, file count, newest modification, and top file types per sub-folder, `depth` levels below `path_prefix`. Bytes are only ever added for a file that is both in scope and currently readable. |
| `index_stats` | Health of the identity's scope: files tracked, chunks embedded, and whether write tools are enabled, computed only from files this call individually verified are readable, never a raw scope-wide count. |
| `create_folder` | **Write, gated.** Creates a folder (and parents) through `principal.storage`, so SFTPGo permissions and fdrive's own change events apply. Storage-native, like `list_directory`: works even when the index is unavailable. |
| `move_path` | **Write, gated.** Moves or renames a path through `principal.storage` (storage-native, independent of index availability). When both `src` and `dst` resolve into the same configured index root, records a row in `idx.moves` (`actor = "mcp"`) so the index can update in place instead of re-extracting, and so the move shows up in `recent_moves`. |
| `recent_moves` | Audit log of moves made through this MCP server (`actor = "mcp"`), newest first, scoped to the identity's index roots. A move only appears once both its source and destination round-trip into scope and its destination passes a live read check; a hidden or shadowed source is never disclosed even when the destination is fine. |

## Scope and live authorization

Every tool above that reads the index resolves the caller's *verified* index scopes
(`ScopeResolver.verifiedIndexScopes`, see `docs/workflow/P5-SCOPES.md`) for the token's own linked
identity, never a username/template fallback, and builds one bounded, request-local read authorizer
against that identity's own storage. Concretely, before any name, hash, text status, snippet, size,
or aggregate derived from the index can appear in a tool's result:

1. The candidate's physical location is mapped to the caller's virtual path and back
   (`roundTripVirtualPath`); a mismatch (a more specific scope override shadows the original
   physical location) drops the candidate silently.
2. A live read check runs against the caller's own storage: `storage.download` (opened and
   immediately cancelled, never buffered) for a file, `storage.list` for a folder. Listing or
   stat succeeding is never treated as proof of read permission on its own.

When verified scopes are unavailable for the caller (no configured index roots, a broken mapping,
or the indexer being unreachable), every index-backed tool answers with a short, reason-carrying
error (for example `index features are unavailable for this identity (no_roots)`) rather than a
partial or best-guess mapping. `list_directory`, `create_folder`, and `move_path` are unaffected:
they go straight through `principal.storage`, authorized by SFTPGo itself, and keep working even
when indexing is down entirely.

**`partial: true`.** An aggregate or listing tool (`find_files`, `find_duplicates`, `similar_files`,
`folder_overview`, `index_stats`, `file_info`'s `identical_copies`, `recent_moves`) authorizes at
most 2000 candidate files per call, six at a time. Whenever that cap, a denial, or an unavailable
probe left something out of what the underlying index query reported, the response carries an extra
`partial: true` field. Treat its absence as "everything this call examined was returned," never as
"this is the whole index": a response can still be an undercount of the true state of the caller's
share if, for example, a folder has more than 2000 files in scope. `partial` never appears when
every examined candidate was returned.

## Write gating

`create_folder` and `move_path` are disabled by default. Set `FDRIVE_MCP_WRITES=true` on the API
container to enable them for every token. There is no per-token write flag in v1: a token either
belongs to an account whose fdrive deployment has writes enabled, or it does not. When disabled,
both tools return a tool error explaining that `FDRIVE_MCP_WRITES` is off, rather than silently
no-op'ing.

## Configuration

| Variable | Purpose |
|---|---|
| `FDRIVE_INDEXER_URL` | Base URL of the indexer's internal HTTP endpoint (e.g. `http://indexer:8090`). Enables `read_file_text`; omitted, that tool always returns a tool error. |
| `FDRIVE_MCP_WRITES` | `true` to enable `create_folder` and `move_path`. Defaults to `false`. |
| `FDRIVE_PUBLIC_URL` | Used to build the `url` field on search/file results and the "Connect Claude" snippets on the account page. |

## Connecting Claude

The account page's "API tokens" card shows, right after creating a token, two ready-to-copy
snippets:

```bash
claude mcp add --transport http fdrive <public url>/mcp --header "Authorization: Bearer <token>"
```

For claude.ai's web connectors, which cannot set a custom header, use the token-in-path form
instead:

```
<public url>/mcp/t/<token>
```

## Repointing the Raycast extension

The `raycast/` extension (from `server-stuff/filesai/raycast`, ported into this repo per PLAN.md
§11) talks to an MCP server over streamable HTTP with a bearer token and a Filestash base URL for
building result links. To repoint it at fdrive:

1. Create an fdrive API token on `/account` for the SFTPGo identity the extension should act as.
2. In Raycast's preferences for the extension, set:
   - **MCP endpoint**: `<public url>/mcp` (or `<public url>/mcp/t/<token>` if you would rather not
     also set the bearer preference; the extension only needs one or the other).
   - **Bearer token**: the fdrive token from step 1, instead of the old filesai `MCP_TOKEN`.
   - **Result URL base**: fdrive's public URL instead of Filestash's. Every tool result's `url`
     field already points at `<public url>/view<path>` or `<public url>/files<path>`, so once the
     extension's "open result" action uses the tool's own `url` field (rather than constructing a
     Filestash link itself from `path`), no further change is needed.
3. Remove the old `MCP_TOKEN` and `FILESTASH_URL` preferences; they no longer apply.

## Testing

- Pure helpers (`apps/api/src/mcp/format.ts`, `scope-context.ts`, `urls.ts`) and every tool's
  business logic (`apps/api/src/mcp/handlers.ts`) are unit tested with stubbed `IndexQueries`,
  `SearchService`, `ReadAuthorizer`, and `StorageProvider`, including the scope-enforcement branches
  ("path is outside this identity's scope"), exact denied-file exclusion from every tool and
  aggregate, literal percent-sign paths, the 2000-candidate cap and its `partial: true`, and that
  scopes always resolve from the bearer token's own identity (never a cookie's), using hand-built
  `ScopeContext` and fake `ReadAuthorizer` fixtures.
- `apps/api/src/mcp/routes.e2e.test.ts` exercises the whole stack end to end: a real
  `@hono/node-server` on an ephemeral port, the official MCP TypeScript SDK's client
  (`StreamableHTTPClientTransport`) over real HTTP, the in-memory fake SFTPGo server for storage,
  memory-backed repositories for tokens and identities, and a stub indexer fetch. It covers
  initialize, `tools/list`, calling every tool at least once, `create_folder` gated off then on,
  token-in-path auth, bearer auth, and 401 with no credentials.
- `apps/api/test/integration/mcp-scopes-sftp.test.ts` runs every scope-sensitive tool above against
  a real SFTPGo container and a real, migrated Postgres database with two identities (one full
  access with a virtual-folder override, one list-only) to prove: a shadowed physical location never
  surfaces under an override's virtual name, an unreadable file never appears in `find_files` or
  `file_info` even though it is indexed, a duplicate group keeps only its readable copies, and a
  hidden `recent_moves` source is never disclosed.
