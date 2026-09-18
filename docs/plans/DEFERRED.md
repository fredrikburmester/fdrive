# Deferred work

These are not scheduled implementations.

## Configurable embedding provider/model

Explicitly deferred by the earlier product scope. Current model and dimension contracts
remain unchanged. A future proposal must cover index compatibility, re-embedding, settings,
resource requirements and unavailable states before enabling model changes.

## Office thumbnails

Office files currently use icons. Thumbnail generation was explicitly deferred; a future
implementation needs a bounded conversion path and the same live read authorization as
other cached previews.

## Setup-token delivery hardening

The deployment hardening review suggested delivering the claim token through a private
0600 file instead of logs. [Composition](../../apps/api/src/composition.ts) still logs the
token. This is an outstanding review recommendation, not an approved change to onboarding.
Resolve secure delivery and operator discovery together before implementation.

## Restoring an OCR original from the file browser

Kept originals are administered from System > Searchable PDFs, which is admin-only; see
[OCR](../OCR.md#kept-originals). Offering "Restore original" on the PDF itself, to the
person who owns it, needs virtual-path to root/fs-path resolution through the
[scoping resolver](../../apps/api/src/scoping/resolver.ts) plus live write authorization,
and would put a destructive action behind a non-admin surface. Deliberately not built with
the admin inventory; a future proposal must settle authorization before the UI.

Native mobile apps, OIDC, SFTPGo administration, comments and collaboration outside Office
remain outside the current product scope. Old alternative folder-view designs and the
application-owned Trash proposal were superseded, not deferred.

## Features on storage beside SFTPGo

fdrive is an SFTPGo client first. WebDAV and S3 get ordinary file management and
fdrive-performed Trash; search, thumbnails, embeddings, folder sizes, shares and Office stay
on SFTPGo because the indexer reads a mounted disk and share links are SFTPGo's own. Nothing
blocks adding them later: each is a capability flag the UI and API already honour, and the
storage note derives from the flags. The pieces, when wanted, are a remote index walker that
reads through the storage port instead of a disk root, with change detection by etag, size
and mtime plus periodic rescans; fdrive-served share links ([Owned shares](OWNED-SHARES.md));
Office admission for provider-bound locations; and server-side zip. Each lands per backend,
one flag at a time, after its full API and UI path works. Not scheduled.
