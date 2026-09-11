# Office implementation

Operator setup: [Office](OFFICE.md). Real-editor acceptance: [Office tests](OFFICE-TESTS.md).
Entry points: [service](../apps/api/src/office/service.ts),
[authentication](../apps/api/src/office/auth.ts),
[writes](../apps/api/src/office/writes.ts) and
[protocol](../apps/api/src/office/protocol/).

## File identity and authorization

`app.office_files` supplies stable UUIDs for provider/root/path locations, independent of
index rows. Moves preserve UUIDs; deletes tombstone them; recreation gets a new UUID.
Callbacks resolve the current location, current identity/session and current scope before
using that identity's storage. Neither a known UUID nor a matching content hash grants access.

Office tokens are purpose-separated and session-bound. Revoked or expired sessions fail
callbacks. Editing requires explicit administrator admission, including the provider-bound
editor allowlist and any advanced path policy. Browser edit intent is not authority: a
read-only coeditor can otherwise affect another writer's save. Keep the real-editor
regression that checks persisted content, not just the reader's own rejected upload.

## Writes and concurrency

The [write scope](../packages/db/src/repos/office-write-scope.ts) coordinates registry and
WOPI locks on one database transaction/connection. Nested lock work must not check out a
second connection: a small pool can deadlock when another writer waits on the provider gate.
Metadata notifications run after commit. Scope handles cannot escape their callback lifetime.

Re-resolve current registry paths inside writes so a queued save cannot resurrect a renamed
path. Check edit admission and destination conflicts under the relevant locks. SFTPGo lacks
an atomic conditional-create upload; an external writer can still race an absence check.
Do not claim cross-client atomic no-overwrite semantics.

## Callback proof and cache versions

Proof URLs derive from configured callback addresses and the original request path/query,
not arbitrary Host headers. Discovery and iframe origins are trusted configuration. Preserve
profile-specific authentication and real-editor checks; never introduce a generic proof bypass.

Content versions must detect same-size, same-second external replacements. Streaming hashes
and version tracking avoid relying solely on Last-Modified seconds. Keep bounded streaming,
upload limits, lock conflict behavior and view-only mutation rejection.
