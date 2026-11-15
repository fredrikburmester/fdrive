# Index scopes and authorization

Current implementation: [resolver](../apps/api/src/scoping/resolver.ts),
[round trip](../apps/api/src/scoping/round-trip.ts) and the scope helpers in
[`@fdrive/core`](../packages/core/src/scope.ts).

## Scopes

A scope `{fsPrefix, virtualPrefix}` maps part of the files folder onto part of one login's
files. Mapping is segment-aware and must round-trip. The index has one root, the files folder
(`idx.roots` row 1, `files`), and its paths are relative to it.

`scopesFor(username)` returns every scope of a login: its home, `/<username>` shown at `/`,
then one scope per folder shared with it, `/<owner>/<path>` shown at `/Shared with me/<name>`.
It runs one grants query and reads neither storage nor the index. A username that cannot be
one path segment is refused. Search, duplicates, thumbnails, photos, folder sizes, the Storage
page (the home scope alone), extraction, AI tools, MCP, the desktop change feed and its
`versions` check all use it with their principal's username, and the API's reader of the change
journal with every login's, for live updates, metadata and activity observations.

Whether index-backed features apply at all is separate: the files folder is indexed while
`FDRIVE_INDEXER_URL` is set and a feature that needs the indexer (thumbnails, full-text or image
search) is on. `GET /api/v1/search/status` reports `not_indexed` without an indexer.

## Shared folders and `Shared with me`

A scope nested inside the home shadows the home's own folder at that path: the scope helpers
pick the longest prefix in both directions, and `roundTripVirtualPath` drops any index row
whose path does not map back to where it came from. `Shared with me` is a reserved name at the
top of each home, so the round trip also drops every row of the home's own folder of that name,
shared or not, and index queries leave that folder out before their limit
(`reservedExclusion`). A real folder named `Shared with me` stays on disk, untouched and out of
sight; see [storage](STORAGE.md#wiring).

## The scope is the permission

Scopes are computed for every request from the username and the grants it has now, so a
share that ends drops out of the next search, thumbnail or folder size. An index row that
maps through them and back (`roundTripVirtualPath`), outside fdrive's own folders, is the
login's to see: search, image search, thumbnails, folder sizes, MCP, AI and activity read no
storage to prove it. Nothing else can differ: the files folder is fdrive's own, its storage
and the index agree on what each login reaches, the indexer never follows a symbolic link and
storage refuses one, and the reserved folders are left out in SQL. A file deleted outside
fdrive can still be listed until the indexer notices; opening it answers not found.

Live updates follow the same rule: a change journal row reaches a login whose scopes map one
of its ends, with no storage read ([the API's reader](INDEXER.md#the-apis-reader)).

## Consumers and tests

HTTP and MCP consumers must use the login's scopes, respect native/API-token identity
ownership and omit paths outside them. Bounded aggregates must report partial or sampled
results honestly. Office keys documents by owner and owner's path, not by scope, and
authorizes each callback itself; an Office UUID does not grant access. Live updates must not
leak paths to a login whose scopes do not reach them.

Regression coverage includes the [resolver](../apps/api/src/scoping/resolver.test.ts),
[round trip](../apps/api/src/scoping/round-trip.test.ts),
[local folder scoping](../apps/api/test/integration/scopes-local.test.ts) (two logins with
the same virtual names, a shared folder over a shadowed physical one, a file gone from disk,
and the MCP tools) and [queries per request](../apps/api/test/integration/request-queries.test.ts)
(a revoked share, full pages, fdrive's own folders).

## MCP folder grants

Explicit MCP token grants narrow virtual paths independently of indexing. Provider operations
check these grants directly; index-backed operations intersect them with the login's scopes and
retain nested scope shadow boundaries.
Ancestor browsing exposes only the chains to granted roots. fdrive's own folders (Trash, the
Mac app's folder, the Trash layout and backups; `isReservedPath`) remain excluded from ordinary
tools, and index queries leave them out before their limit; restore admits both original and
destination paths. Every MCP token has explicit grants; the AI's tools pass the session's
login, which keeps every scope.
