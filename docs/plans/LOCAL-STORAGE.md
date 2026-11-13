# Local storage

Decided 2026-11-12. fdrive serves files from a folder on its own disk and keeps its own users.
SFTPGo is removed, and WebDAV and S3 storage followed on 2026-11-13. Builds on the
[storage port](../STORAGE-PROVIDERS.md) and [Owned shares](OWNED-SHARES.md).

## Outcome

A self-hoster runs fdrive with one mounted data folder. Each user's files are plain files under
`<root>/<username>`, the layout SFTPGo used, so backups, rsync, SMB and Syncthing keep working on
the host and an SFTPGo data folder is adopted in place. A local login gets search, thumbnails,
Office, share links, Trash, zip, kept modification times, atomic moves and safe Mac writes, and
users can share folders with each other. The files folder is fdrive's only storage.

## Why

Built on SFTPGo, fdrive could not share between users, could not create a file only when the
name is free, had to rescan to see changes, and needed a second server with its own users,
admin UI and upgrades.

## Decisions

- **Inside the API, in TypeScript.** Every byte already streams through the API; a second
  process would add a hop and a credential and run no faster. Never in `fdrive-ml`, which has no
  storage mounts on purpose.
- **A provider module behind the storage port.** `@fdrive/local` implements `StorageProvider` and
  `ProviderModule`. The seam grew where local needed it, not with type checks:
  `deploymentManaged` (rows come from the deployment, never a form), `admit` (a disabled user is
  stopped at once) and `indexRootName`.
- **The root is deployment-controlled.** `FDRIVE_STORAGE_ROOT` seeds and pins the provider. A
  path typed into a web form would let an administrator point the API at its own secrets.
- **fdrive owns local users.** `app.local_users`: username (unique in any case, since homes may
  sit on a case-insensitive disk), scrypt hash, disabled flag. The first user comes from setup,
  the rest from System > Users. Administrator rights stay on the account.
- **WebDAV and S3 storage are removed (2026-11-13).** They never gained search, thumbnails,
  shares or Office. `packages/webdav` and `packages/s3` are deleted and `ProviderType` is
  `"local"`. The storage port stays as a cheap internal boundary, not a plugin system.
  Migration 0019 disables leftover `webdav` and `s3` rows (`enabled = false`,
  `managed_by_env = false`) and keeps them, since logins reference them; those logins
  disappear with their modules. Without `FDRIVE_STORAGE_ROOT` setup refuses to complete.
  Backups to an S3 bucket stay.
- **SFTPGo is removed, its data is kept.** Migration 0017 turns the SFTPGo row the deployment
  pinned (else the setup owner's, else the oldest) into the local row in place, so logins and
  everything keyed by them carry over; renames the index root to `files`; turns SFTPGo share
  links into links fdrive serves (protected ones stay locked until their owner sets a password);
  and drops the virtual-folder settings. On first start the API carries passwords over from the
  sealed credentials: administrators can sign in at once, everyone else is added disabled.
- **Plain files stay authoritative.** No database of file contents; writers outside fdrive
  (OCR, rsync) remain allowed.
- **Sharing between users is a grant plus a path.** `app.local_grants` (owner, folder, grantee,
  read or write). The grantee's storage shows each grant at `/Shared with me/<name>` and reaches
  the owner's folder confined to it; a read-only grant refuses every change. Grants follow the
  owner's moves and deletes made through fdrive. Search, thumbnails and Office reach shared
  folders through extra index scopes.

## Storage semantics

- **Confinement.** Paths go through `normalizePath`, then join the home. Symlinks are followed
  only when their real path stays inside the home (or the shared folder). A shared folder must
  itself resolve inside its owner's home, so a share never reaches further than its owner can.
- **Atomic publish.** Uploads stream to a temporary file beside the target and `rename` over the
  name; `overwrite: false` publishes with `link`, a real create-if-absent.
- **Moves** are one `rename`, also between a user's files and a folder shared with them.
- **Copy** keeps timestamps; **zip** streams with `yazl`; **Trash** uses the generic `move`
  strategy (`<home>/.trash/.fdrive-move-v1`). Items SFTPGo's recycle rule left in `.trash` stay
  on disk but are not listed.
- **Ownership.** The API writes as `FDRIVE_RUN_AS_UID`, the uid the indexer and OCR use.

## Later

Feed indexer change events from the local provider's own writes, offer `withWriteLease` for Mac
writes, share single files with people, and drop the token-minting path of the provider port if
no backend needs it again.
