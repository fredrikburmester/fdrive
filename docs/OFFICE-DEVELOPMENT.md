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

Each write runs in one [write scope](../packages/db/src/repos/office-write-scope.ts), a
transaction holding the locks of the documents and names it touches until it commits: the
document's own (its file UUID, the key WOPI lock requests take too) and, for a new name, the
name's. Saves to one document wait for each other; saves to different documents run side by
side. Nested lock and registry work stays on the scope's connection. Metadata notifications run
after commit. Scope handles cannot escape their callback lifetime.

The scopes and the WOPI lock repository have a pool of their own. A save holds its document's
lock, and a connection, while its body streams in, and checks admission and records history on
the main pool meanwhile; nothing on the main pool waits for these locks, so a saturated pool
cannot deadlock. The registry's own lock is the exception, since registry and desktop
transactions on the main pool wait for it: a write ensures a registry row on its own
transaction, and a rename moves its row as its last step.

Re-resolve current registry paths under the document's lock so a queued save cannot resurrect a
renamed path. Saves stream into storage, which writes beside the document and renames into
place, so a body over the limit, an aborted request, or edit admission gone by the time the
body has arrived (checked again then) publishes nothing. Create, rename and non-overwriting
saves (`PutRelativeFile` without overwrite) pass `overwrite: false`, a real create-if-absent in
the files folder, and answer a taken name from the storage's `conflict`: 409, or 400 with
`X-WOPI-InvalidFileNameError` for a rename. `PutRelativeFile` still looks for a free suggested
name before it spends the body. Saves that replace a document pass `overwrite: true`.

## Callback proof and cache versions

Proof URLs derive from configured callback addresses and the original request path/query,
not arbitrary Host headers. Discovery and iframe origins are trusted configuration. Preserve
profile-specific authentication and real-editor checks; never introduce a generic proof bypass.

Versions come from the file's stamp (`contentStamp`: size, modification time, inode and change
time), so they cost no read of the document. Any write moves the change time and a publish
replaces the inode, so a same-size external replacement that keeps its modification time still
gets a new version. Office requires storage with stamps. Keep bounded streaming, upload limits,
lock conflict behavior and view-only mutation rejection.
