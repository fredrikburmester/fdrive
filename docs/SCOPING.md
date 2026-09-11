# Index scopes and authorization

Current implementation: [resolver](../apps/api/src/scoping/resolver.ts),
[contracts](../packages/contracts/src/scopes.ts) and the API's scoping directory.

## Trusted mappings

Scopes map `{rootName, fsPrefix, virtualPrefix}` between index roots and one identity's
virtual filesystem. Canonical, segment-aware mapping must round-trip. Administrators own
the mapping; matching names are a consistency check, never proof of identical storage.
A deliberately wrong trusted mapping cannot be repaired by permission probes.

The resolver combines the provider's home template, per-identity overrides and adopted
shared-folder mappings. It currently supports SFTPGo providers. Unknown or unsupported
roots do not silently acquire index access.

`configuredMappings` supplies trusted locations for Office and metadata events without
depending on index contents. `verifiedIndexScopes` supplies only verified, indexed scopes
for search, duplicates, thumbnails, extraction and MCP. Shared-folder adoption needs
verification evidence, so an unavailable indexer may leave only the base mappings.

## Virtual and shared folders

Identity overrides include `unindexedPrefixes`: mounts explicitly acknowledged as not
indexed. Version 2 records preserve these alongside mappings. An unmapped mount is reported
with its virtual path; supported scopes can remain usable rather than disabling the login.
Resetting overrides persists an empty record, not a SQL-null settings value.

Shared-folder mappings are stored under `mount_mappings`. Each maps a virtual path to a
root and filesystem prefix; the resolver decides which logins can adopt it from their live
listing and directory verification. Administrator-confirmed suggestions use bounded index
evidence, not SFTPGo administration or automatic trust. See
[mapping store](../apps/api/src/scoping/mount-mapping-store.ts) and
[suggestions](../apps/api/src/scoping/suggest.ts).

Configuration routes require cookie authentication, account ownership where applicable,
administrator authorization for writes and CSRF protection. Non-admin status responses
omit physical prefixes. Never accept arbitrary index paths from an unprivileged caller.

## Verification and live reads

The resolver compares bounded SFTP and indexer directory observations, accounting for
shadowing by more-specific mounts. Mismatch, overflow and unreachable dependencies fail
closed for affected scopes. The verification cache defaults to 30 seconds and 1,000 entries;
its key includes identity/provider and mapping inputs, and configuration writes invalidate it.
This is not a cache of per-file read permission.

Index-derived content must also pass live storage read authorization. Stat/list metadata
alone does not prove file download access. Directory probes may stop after one complete
listing entry or a confirmed empty listing; HTTP success headers alone are insufficient.
Providers without that optimization use a full list. Probe concurrency is bounded; positive
read proofs are reused only within the request. Final candidate metadata/path mapping is
rechecked before returning results; a changed path requires its own proof.

## Consumers and tests

HTTP and MCP consumers must receive explicit verified scopes, respect native/API-token
identity ownership and omit inaccessible paths/content. Bounded aggregates must report
partial or sampled results honestly. Office callbacks use current configured mappings and
their own live authorization; an Office UUID does not grant access. Index events must not
leak paths to unauthorized subscribers.

Regression coverage includes
[real scoping](../apps/api/test/integration/scopes-sftp.test.ts),
[MCP scoping](../apps/api/test/integration/mcp-scopes-sftp.test.ts) and
[provider binding](../apps/api/test/integration/provider-binding.test.ts).
Use two identities with overlapping virtual names and different permissions; include
mapping changes, unindexed mounts, dependency failures and renamed/deleted paths.
