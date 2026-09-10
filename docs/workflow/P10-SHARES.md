# P10 chunk D: fdrive-owned shares

Design: [P10-STORAGE-PROVIDERS.md](P10-STORAGE-PROVIDERS.md). Depends on A1; parallel with B.
Every provider without native shares gets shares implemented by fdrive. SFTPGo keeps its native
shares: no migration, passwords stay in SFTPGo, shares created in SFTPGo's own web client stay
visible, `allow_from` keeps working there.

## Seam

`ShareProvider` in the API (`shares/provider.ts`): `create`, `update`, `delete`, `get`, `list`
for the owner, and `publicAccess(shareId, password?)` returning `{ list, stat, download, zip?,
upload }`. Two implementations: `SftpgoShares` (the existing `shares/service.ts` code moved
behind the interface) and `OwnedShares` (new). `shares/routes.ts` dispatches on the share row's
`kind`; the public pages do not change.

## Database

Migration `0010_owned_shares` on `app.shares`: `kind text not null default 'sftpgo'`,
`sftpgo_share_id` nullable (unique with identity only when not null), `password_hash text`,
`max_downloads integer`, `used_downloads integer not null default 0`, `description text`,
`allowed_paths` stays `paths`. For owned rows these columns are authoritative; the upstream
re-fetch and delete-on-missing behaviour applies to `sftpgo` rows only.

## Owned shares

- Create validates paths against the owner identity's storage (`stat` each), stores canonical
  paths, scope (`read` or `write` for one folder), presentation, expiry, max downloads and a
  password hash (argon2id, existing dependency policy applies; `[**redacted**]` sentinel kept
  for updates).
- Public access resolves the owner identity's `StorageProvider` through the existing factory
  (stored credential, same model as API tokens), checks the requested path is one of the
  share's paths or under a shared folder, and streams `download` with Range. `list` and `stat`
  are the port calls. `upload` for write shares goes through `upload` with `overwrite: false`.
- Download counting: increment `used_downloads` when a file download starts; refuse when
  `max_downloads` is reached; thumbnails and archive peek never count, as today. Expiry and
  limits produce the same `unavailableReason` values the pages already render.
- Folder "Download all": stream a zip built from `list` plus `download` (extract the
  zip-building path of `archive/compress.ts` into `archive/zip-stream.ts`, deterministic entry
  order, bounded concurrency, no temp files). Used by owned shares regardless of the provider's
  `zip` capability; SFTPGo shares keep streamzip.
- The `shares` capability is true for every module whose `createShares` is absent (owned) or
  present (native). Context menu Share and the Shares page work identically for both kinds.
- If the owner's credential stops working, public access answers `unavailable` (503 body the
  page already handles), never a different identity.

## Rate limiting and secrets

The existing share limiter, sealed password cookie and public-path rate limits apply unchanged.
Password hashes never leave the API; `hasPassword` remains the only signal in contracts.

## Out of scope

Migrating SFTPGo shares to owned. IP allow lists. Share-level thumbnails for providers without
an index (they stay 404 as today).

## Checks

`application`, `integration`: owned shares end to end against the WebDAV container (create with
password, expiry, max downloads reached, write-share upload, folder zip contents, credential
revoked), SFTPGo shares regression (`shares-sftp.test.ts`). Browser `shares.spec.ts` on both
kinds; public page against a WebDAV-backed owned share. `workflow`.
