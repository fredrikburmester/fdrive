# Phase 4 host architecture

Primary decisions, 2026-09-06. Implementation follows foundation chunks.

## File identity and authority

The original signed identity/path ID contradicts WOPI's stable cross-user ID
requirement. Add `app.office_files`: UUID id, provider UUID FK, rootName text,
root-relative normalized path text, nullable deletedAt, createdAt. Partial unique
index `(providerId, rootName, path) WHERE deletedAt IS NULL`. No FK to idx.files:
clearing the index must not change office identity. Resolve location through
existing home scopes (even without index enabled), then upsert a shared UUID.
Identity-specific virtual paths and credentials remain separate from file IDs.
Move events update registered paths by exact/prefix boundary, preserving UUIDs;
deletes tombstone them. Recreated paths get new UUIDs. SFTP operations remain the
authority; this registry never grants file access. Duplicate move notifications
are idempotent. Replacing an existing destination tombstones its former UUID.

Every callback looks up the UUID, checks provider identity, maps its CURRENT
location into the identity's current scopes, checks current session/identity
ownership, and stats via that user's SFTPGo credentials. Out-of-scope/removed
files fail closed. No global hash match grants shared access.

Office tokens: HS256 JWT with purpose-separated key derived from master using
HKDF-SHA256; fixed issuer/audience, identity ID, hashed session ID, file UUID,
mode (view/edit), issued/expiry seconds. Expiry is min(session expiry, now+8h).
Strict bounded decode, fixed algorithm, constant-time signature verification.
Never accept browser-supplied claims or log tokens. View tokens never mutate data.
Expiry and logged-out/revoked sessions invalidate callbacks immediately.

SFTPGo 2.7.5 user profile does not expose per-path permissions. The previous
explicit-edit-intent design is invalid: real ONLYOFFICE coediting let a read-only
participant's edits persist through another writer's save. Direct PutFile403 does
not close this gap. Phase4 cannot complete until edit admission has authority.
View remains available after download authorization. Do not probe by writing,
opening r+, or creating temporary siblings: these are unsafe or false positives.
Webclient CanAddFiles is upload OR overwrite; WebDAV OPTIONS PUT is not a permission
check. Preserve credential-only mode with explicit operator-maintained editing
policy and default deny (P4-EDIT-ADMISSION.md). Preserve the failing real-editor
regression; never weaken it to merely test the participant's own save.

SFTPGo's upload endpoints also have no conditional-create flag: their documented
behavior overwrites existing files. Serialize fdrive office creates by canonical
target path, check absence under that lock and immediately before upload, reject
observed collisions. External SFTP writers can still race that check; do not
advertise atomic no-overwrite across external clients or invent a client option
the upstream ignores. This limitation belongs in office setup documentation.

## Proof, versions and locking

Reconstruct proof URL from configured callback base plus original raw path/query,
never arbitrary Host or forwarded headers. Production requires explicit public
and callback URLs. Discovery comes from a configured trusted office URL; selected
iframe action origin must match configured public office origin. Refresh proof
keys once on a failed signature and on old-key verification. No proof bypass in
production or generic test configuration. Profile-specific exceptions require
documented evidence and equivalent request authentication.

Use the foundation lock repository's withFileLock around lock check plus upload
or rename. View Lock is 200 without inspecting/mutating an edit lock. Other view
mutations are 403. Nonempty unlocked PutFile is 409. Read-only GET remains allowed
while locked. Respect X-WOPI-MaxExpectedSize and bounded uploads (100 MiB default).

Do not trust HTTP Last-Modified seconds alone for cache identity. Hash the file
stream at session opening; use a validated index hash only when freshness is
proven. Saves update content hash/version; next open must observe external edits,
including equal-size same-second replacements. Streaming digest must be bounded
and must not buffer whole files in memory.

## Next worker chunks

1. Registry DB + mutation event hooks, separate from lock foundation.
2. Office tokens/host service/routes/contracts and focused tests.
3. ONLYOFFICE/Collabora deployment profiles and real office test fixture tooling.
4. Editor page, file menu, new document and conversion UI after contracts settle.

Official references:
- https://api.onlyoffice.com/docs/docs-api/using-wopi/key-concepts/
- https://api.onlyoffice.com/docs/docs-api/using-wopi/wopi-rest-api/putrelativefile/
- https://api.onlyoffice.com/docs/docs-api/using-wopi/wopi-rest-api/renamefile/
- https://raw.githubusercontent.com/drakkan/sftpgo/v2.7.5/openapi/openapi.yaml
- https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/scenarios/proofkeys

Deployment correction to verify against pinned image: current Docker entrypoint
overrides WOPI_PRIVATE_KEY/PUBLIC_KEY env names with files under DATA_DIR and
generates missing keys there. Inspect 9.4.0.1 before choosing mounts; do not assume
the original plan's PEM secret paths are honored. Persist generated deployment
keys and verify discovery uses their modulus. Never use the stock shared key.
