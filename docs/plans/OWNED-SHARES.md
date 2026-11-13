# fdrive-owned shares

## Status (2026-11-13)

Owned shares are the only shares. SFTPGo is gone, so `ShareStrategy` is `"owned" | "none"`,
the local folder (`packages/local`) declares `owned`, and the native path is deleted:
SFTPGo share objects, `sftpgo_share_id`, the password form of the credential cookie, the
thumbnail password cache and the suffix-range peek adapter. Migration `0017_local_storage`
kept every SFTPGo link at its address as an owned row; a protected one holds the hash
`locked$sftpgo`, which matches no password, so it stays locked until its owner sets a new one.

Steps 1 to 6 of the original plan are done, with one change: archives use the storage's own `zip` instead
of a new walk over `yazl`. An archive counts one download and is held to two at a time per
link, an hour, and `FDRIVE_JOB_MAX_BYTES` (`apps/api/src/shares/zip-limits.ts`). It is
refused when the storage has no `zip`, when the owner's Trash lies inside a shared folder,
and when two shared paths would land on the same name; new multi-path shares are refused
on that last rule too.

Steps 7 and 8 of that plan (2026-09-18), owned shares on S3 and WebDAV, were dropped
when that storage was removed on 2026-11-13; the plan is in git history. One item is open.

## Open: gallery on unindexed storage

A login without `index` (its root is not indexed) has no thumbnails, yet a share
row can hold `presentation: "gallery"`, `auto` resolves to gallery on the client when every
entry is an image, and a page is 200 tiles, each a 404 thumb plus a full download, against a
120-per-minute limit. HEIC and camera raw tiles fall back to an icon.

Recommended: enforce it server-side, not just hidden. `publicMetadata` downgrades the
presentation to `list` for such a login (or `PublicShare` gains `thumbnails: false` and the
client resolves from it), and the share dialog offers gallery only when the login has `index`.
On-demand resizing with a small disk cache is a follow-up, not part of this.

Complete when a share from a login without `index` never renders as a gallery, with an API test
for the downgrade and a web test for the dialog.
