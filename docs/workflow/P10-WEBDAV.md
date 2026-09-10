# P10 chunk B: WebDAV provider

Design: [P10-STORAGE-PROVIDERS.md](P10-STORAGE-PROVIDERS.md). Depends on A1. The first provider
that is not SFTPGo; its purpose is to prove that a provider is a package plus one registry line.
Targets: Nextcloud, ownCloud, Synology, Hetzner Storage Box, Apache and nginx DAV, rclone serve.

## Package `packages/provider-webdav`

- `module.ts` exports the `ProviderModule`. `type: "webdav"`, `label: "WebDAV"`,
  `configSchema = { url, label? }`, `credentialSchema = { username, password }`, no `mint`,
  `trash: "move"`, capabilities: `zip false`, `setModifiedAt false` (a later option may send
  `X-OC-Mtime` when the server advertises it), `atomicMove true`, `trash true`, `shares true`
  (owned, from D), `office false`, `index false`, `scopeMapping false`.
- `client.ts`: PROPFIND depth 1 for `list` (limit response body and entry count; namespace-aware
  parsing; `href` must resolve under the configured URL prefix; percent-decode segments and
  reject `..` or NUL), PROPFIND depth 0 for `stat` (kind from `resourcetype`), GET with `Range`
  and `If-Range` for `download`, PUT for `upload` (`mkdirParents` walks MKCOL from the top),
  MKCOL, MOVE and COPY with `Overwrite: F` unless `overwrite`, DELETE. Basic auth on every
  request; no Digest in v1. Follow redirects only to the same origin and same prefix, never
  forwarding the Authorization header elsewhere. Map 401 to `unauthorized`, 403 to `forbidden`,
  404 to `not_found`, 412 and 423 to `conflict`, 507 to `payload_too_large`, 5xx and network to
  `upstream_unavailable`. Abort signals propagate to `fetch`.
- `authenticate`: PROPFIND depth 0 on the root with the credentials; 401 is `unauthorized`,
  success returns `externalUsername = username`.
- `probe`: OPTIONS on the URL, requires a `DAV` header with class 1; reports version and whether
  class 2 (locking) is present.
- `fake/`: an in-memory DAV server (Node HTTP handler) covering the methods above, used by the
  package's own tests and the conformance suite.
- `apps/api/src/providers/registry.ts` gains `webdav: webdavModule`. Contracts `ProviderType`
  gains `"webdav"`. No other API or web change.

## Trash

`withMoveToTrash` from A1 with the provider's trash setting (`config.trash = { enabled, path }`,
default `/.fdrive-trash`, validated absent or owned on enable, never reused if it exists with
foreign content, matching the P6 recovery rule). Restore, purge and empty use the existing
recycle-folder core unchanged.

## Testkit

`containers/webdav.ts`: a disposable DAV container (Apache `bytemark/webdav` or `hacdias/webdav`,
pinned) seeded with the testkit file layout, including Unicode and literal-percent names, a
read-only directory and a denied directory. `describeStorageProvider` runs against the fake
(unit) and the container (integration).

## Checks

`package provider-webdav` (99% functions and lines like core), `integration` with the WebDAV
container: conformance, login and link a WebDAV identity next to an SFTPGo identity, same path
on both providers isolated, trash round trip, cancellation mid-download, redirect to another
origin refused. Browser: log in with a WebDAV provider from the fixture API, browse, upload,
rename, delete to trash, restore; zip, Share (until D), Office, thumbnails and Map it absent.
`workflow`.
