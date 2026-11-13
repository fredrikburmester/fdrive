# Index scopes and authorization

Current implementation: [resolver](../apps/api/src/scoping/resolver.ts),
[round trip](../apps/api/src/scoping/round-trip.ts),
[read authorizer](../apps/api/src/scoping/read-authorizer.ts) and the scope helpers in
[`@fdrive/core`](../packages/core/src/scope.ts).

## Scopes

A scope `{rootName, fsPrefix, virtualPrefix}` maps part of an index root onto part of one
login's files. Mapping is segment-aware and must round-trip.

Every login's home is `<root>/<username>`, shown at `/`: the scope
`{rootName: root, fsPrefix: "/<username>", virtualPrefix: "/"}`. The root is the index root
its provider names (`ProviderModule.indexRootName`). The local folder names the configured
root whose `storagePath` is `FDRIVE_STORAGE_ROOT`, or the only root there is. Nothing is configured per
login: home templates, per-login overrides and folder mappings went with SFTPGo, and
migration 0017 deletes their stored settings.

## Configured and indexed scopes

`configuredMappings(identity)` returns the home plus any extra scopes whenever the provider
names a root, indexed or not, reading only the provider row. Office, index events, the Office
file registry, desktop effects and activity observations use it. It is unavailable as
`provider_mismatch` (the provider is gone or disabled), `no_roots` (it names no root) or
`invalid_configuration` (the username is not one path segment).

`verifiedIndexScopes(identity)` keeps the configured scopes whose root is in
`FDRIVE_INDEX_ROOTS`, and is `no_roots` when none is. Search, duplicates, thumbnails, folder
sizes, extraction, AI tools and MCP use it, never `configuredMappings`.
`GET /api/v1/search/status` reports its reason. "Verified" means indexed: nothing compares
live listings with the index any more.

## Extra scopes

The resolver's optional `extraScopes(identity, home)` appends scopes after the home, for
folders mounted inside a login's files, such as another user's folder at
`/Shared with me/<name>` mapped to `/<owner>/<path>` on the same root. Extra scopes must be
canonical and never claim `/`. A nested scope shadows the home's own folder at that path:
the scope helpers pick the longest prefix in both directions, and `roundTripVirtualPath`
drops any index row whose path does not map back to where it came from, so a file in the
shadowed physical folder never surfaces under the mount.

## Live reads

Index-derived content must also pass live storage read authorization. Stat/list metadata
alone does not prove file download access. A file is proved by the storage's `probeFileRead`
where it has one: the files folder asks the kernel whether the API may read the file
(`access(R_OK)`, the check `open` makes) and reads none of it. A storage without it is asked
for a download whose body is cancelled unread. Directory probes may stop after one complete
listing entry or a confirmed empty listing; HTTP success headers alone are insufficient.
Providers without that optimization use a full list. Probe concurrency is bounded; positive
read proofs are reused only within the request. Final candidate metadata/path mapping is
rechecked before returning results; a changed path requires its own proof.

## Consumers and tests

HTTP and MCP consumers must receive explicit indexed scopes, respect native/API-token
identity ownership and omit inaccessible paths/content. Bounded aggregates must report
partial or sampled results honestly. Office callbacks use current configured mappings and
their own live authorization; an Office UUID does not grant access. Index events must not
leak paths to unauthorized subscribers.

Regression coverage includes the [resolver](../apps/api/src/scoping/resolver.test.ts),
[round trip](../apps/api/src/scoping/round-trip.test.ts),
[local folder scoping](../apps/api/test/integration/scopes-local.test.ts) (two logins with
the same virtual names, a shared folder over a shadowed physical one, a file gone from disk,
and the MCP tools) and [provider binding](../apps/api/test/integration/provider-binding.test.ts).

## MCP folder grants

Explicit MCP token grants narrow virtual paths independently of indexing. Provider operations
check these grants directly; index-backed operations intersect them with indexed scopes,
retain nested scope shadow boundaries and then perform the usual live read authorization.
Ancestor browsing exposes only the chains to granted roots. Configured Trash remains excluded
from ordinary tools; restore admits both original and destination paths. Legacy tokens retain
the indexed-scope restrictions described in [MCP](MCP.md).
