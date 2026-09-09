# P8 folder-level mappings and mapping suggestions (requested 2026-09-09)

Follow-up to [P8-VIRTUAL-FOLDERS.md](P8-VIRTUAL-FOLDERS.md). Two changes, decided together:

1. **Folder-level mappings.** One stored mapping per mounted virtual path applies to every login
   that actually shows that mount, instead of one override per login.
2. **Suggestions.** For an unmapped mount, fdrive proposes physical locations whose indexed
   content matches the mount's live SFTP listing. The administrator still confirms.

fdrive still performs no SFTPGo administration; `mapped_path` is never read.

## Folder-level mappings

- Stored once, globally, under settings key `mount_mappings`:
  `{ version: 1, mappings: [{ virtualPath, rootName, fsPrefix }] }`, unique `virtualPath`,
  canonical paths, `virtualPath !== "/"`, `rootName` in the known roots.
- **Applicability is per login and evidence-based.** A folder mapping is adopted for a login only
  when verification finds an *unmapped mount* at exactly that `virtualPath`: SFTP shows the entry,
  the index lacks it at the enclosing scope's physical location. A real directory of the same name
  in someone's home is on disk, so it is never adopted. Adoption is recomputed with verification
  (same cache, same TTL); a mount that disappears stops being mapped.
- Adopted scopes behave like overrides everywhere: they join `verifiedIndexScopes`, and
  `configuredMappings` (Office, indexer events) includes them so the shared folder works there too.
  When the indexer is unreachable nothing can be adopted; base scopes are unchanged.
- Per-login overrides still exist and win over a folder mapping at the same `virtualPath`.
- API: `GET/PUT /api/v1/system/mount-mappings` (admin). Admin scope status gains
  `adoptedMappings` (the folder mappings in effect for that login).

## Suggestions

- `GET /api/v1/account/identities/:id/scope/suggestions` (admin, owned identity). For every
  unmapped `dir` mount: list it over SFTP; find indexed directories whose direct files include every
  file name at the mount's top level (new `IndexQueries.directoriesWithFiles`); confirm each
  candidate against the indexer's directory listing with `verifyMountDirectory`. At most 5 per
  mount. A mount with no top-level files yields no suggestion (nothing to match on).
- A suggestion is a hint, not a grant: the mapping only exists once the administrator saves it.

## UI

- Account page, **Map it**: suggestion chips prefill root and prefix. A checkbox
  "Apply to every login that mounts this folder" (on by default) saves a folder mapping; off saves a
  per-login override as before. Adopted mappings are listed read-only with "shared folder mapping".
- System > Connection: **Shared folders** card lists folder mappings with Remove.

## Checks

`application`, `integration` (DB query and scope engine), affected `browser`, dev app pass.
