# WebDAV provider

`packages/webdav` (`@fdrive/webdav`) is a registered storage backend: any RFC 4918
class 1 server behind Basic authentication. Administrators add one under **System > Storage**
by endpoint URL; people log in with a username and password, link it beside an SFTPGo login,
and browse, upload, download, rename, move, copy and delete through the ordinary file UI.
Deleted files go to fdrive's own recycle folder when Trash is enabled for the row. Shares,
Office, search, thumbnails and scope mapping stay unavailable for WebDAV logins; the UI hides
those controls and the API refuses them through capability flags. WebDAV is files-only storage
beside SFTPGo, and the UI states that where it is added or picked; see
[Files-only storage](STORAGE-PROVIDERS.md#files-only-storage).

Verified against a real server in CI (SFTPGo's own WebDAV binding, see
`packages/webdav/test/integration`) and against an in-memory protocol fake in unit tests
(`src/fake/server.ts`, also used by API and web tests). Nextcloud, ownCloud, Apache `mod_dav`
and nginx `ngx_http_dav_module` are intended targets but not part of CI; see the limitations.

Not implemented: Digest or OAuth authentication, fdrive-owned shares, a remote index walker,
Office admission, server-side zip, general-purpose WebDAV locking, and `{username}` path
templates. The extension points are those in [the provider guide](STORAGE-PROVIDERS.md).

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Package | `packages/webdav`, `@fdrive/webdav`, copied from `packages/sftpgo` configs | The guide's step 1; keeps protocol code, adapter and fake together and out of the API. |
| XML | `fast-xml-parser` 5.11.1 with `removeNSPrefix`, `ignoreAttributes: false`, `isArray` for `response`/`propstat` | Already pinned in the lockfile for Office discovery; prefix-neutral parsing handles `D:`, `d:` and default-namespace servers alike. |
| Authentication | Basic on every request from `session.getCredential()`; no `mint` | WebDAV has no token flow; the guide's Basic-auth path. No retry on 401: the credential itself is wrong or revoked. |
| `authenticate` | `PROPFIND` Depth 0 on the endpoint root with the credential | Proves the credential and that the root is a collection. 401 → `unauthorized`, 403 → `forbidden`, network/5xx → `upstream_unavailable`. |
| `probe` | `OPTIONS` on the endpoint; ok when 2xx with a `DAV` header containing class `1`, or 401/403 carrying `WWW-Authenticate` | Servers commonly refuse anonymous `OPTIONS`; a challenge still proves a reachable HTTP endpoint. Reuse SFTPGo's URL checks: http(s) only, no userinfo, no metadata hosts, 5 s timeout, 1 KiB body bound. |
| Config fields | optional `desktopWriteMode` ("Write locking") | Blank publishes Mac writes under fdrive's own serialization like every other storage; `apache-webdav-exclusive` uses Apache's DAV locks instead. |
| Credential fields | `username` (text, required, 255) and `password` (password, required) | Confirmation forms already render `password`; `ctx.expectedUsername` fills `username` on link/unlink. |
| Redirects | `redirect: "manual"`; only a stat PROPFIND 301/308 to the exact same URL plus `/` is retried | Other redirects fail as `upstream_unavailable`. The one retry uses a locally constructed same-origin collection URL; operators enter the final endpoint URL. |
| Capabilities | `zip` false, `setModifiedAt` false, `atomicMove` true, `trash` true, `shares` false, `office` false, `index` false, `scopeMapping` false | Only `MOVE` is a native single operation. No standard mtime setter; `X-OC-Mtime` is sent on upload as best effort but not advertised. |
| Trash | `"move"` strategy | WebDAV has no recycle bin, so the API storage factory moves deleted files into the configured folder itself (`withMoveToTrash`) and the recycle-folder view lists, restores and purges them. See [Trash](TRASH.md). |
| Real backend in CI | SFTPGo's WebDAV binding plus Apache `httpd:2.4` | Provider conformance and a real collection-redirect regression; credentials/data are test-only. |

## Protocol mapping

Paths are provider-relative, normalized with core `normalizePath` at the adapter boundary.
Request URLs are always `buildUrl(baseUrl, path)`: each segment `encodeURIComponent`-encoded
(a literal `%41` becomes `%2541`), joined under the endpoint's own path prefix, never from a
server-supplied href. Directory requests carry a trailing slash.

| Port method | Request | Notes |
| --- | --- | --- |
| `list` | `PROPFIND` Depth 1 | Self entry must be a collection, else `bad_request` (the suite requires it; a file answers 207 with one entry). Children: href resolved as below, name is the last decoded segment, kind from `resourcetype/collection`, size from `getcontentlength` (0 when absent), `modifiedAt` from `getlastmodified` (invalid → epoch 0, never a crash). |
| `stat` | `PROPFIND` Depth 0 | 404 → `not_found`. `contentType` from `getcontenttype`. |
| `statFile` | `stat` | Collection → `bad_request`. |
| `probeDirectoryRead` | `PROPFIND` Depth 1, body discarded within bounds | A live listing read, not a stat. |
| `download` | `GET` with `Range`/`If-Range` | Accept 200/206 only; pass headers through. Caller's `AbortSignal` only, no timeout. |
| `upload` | `PUT` | `Content-Length` when known, `duplex: "half"` for streams. `overwrite: false` → `If-None-Match: *` (412 → `conflict`). `mkdirParents` → ensure the parent chain with `mkdir(parent, { parents: true })` first; a `PUT` cannot be replayed after a 409. `modifiedAt` → `X-OC-Mtime` seconds, best effort. |
| `mkdir` | `MKCOL` | 405 existing: `conflict`, except with `parents` where an existing collection is success. 409 missing parent: with `parents`, create the parent recursively and retry once; else `not_found`. |
| `move` | `MOVE` with `Destination` (absolute URL under the endpoint) and `Overwrite: T` unless `overwrite === false` | 412 → `conflict`, 404 → `not_found`, 409 (missing target parent) → `not_found`. |
| `copy` | `COPY`, `Depth: infinity`, same headers | Same mapping as `move`. |
| `deleteFile` | `PROPFIND` Depth 0 then `DELETE` | Refuse a collection with `bad_request` so a file delete can never remove a tree. |
| `deleteDir` | `PROPFIND` Depth 0 then `DELETE` | Refuse a file with `bad_request`. `DELETE` on a collection is recursive by RFC. |

Href resolution (list and stat): `new URL(href, baseUrl)`; refuse a different origin; require
the path to start with the endpoint's path prefix; strip it; percent-decode each segment
(malformed encoding → keep the raw segment); drop a trailing slash. Entries outside the
requested directory (a server that returns extra rows) are ignored, never followed.

Error mapping (`WebdavError` → `StorageError`): 400/416 `bad_request`; 401 `unauthorized`; 403
`forbidden`; 404 `not_found`; 405/409/412/423 `conflict`; 413/507 `payload_too_large`; 429
`rate_limited`; 3xx/5xx/network `upstream_unavailable`; anything else `internal`. Details keep
the status and a 500-character body excerpt with no credentials.

Bounds: 30 s timeout on non-streaming calls; multistatus bodies capped at 32 MiB and 100 000
`response` elements (over either: `internal` with a clear detail, body cancelled); probe and
error bodies capped at 1 KiB and 4 KiB.

## Known limitations

- **Servers that ignore `Range`** answer 200 to a range request. The adapter passes the
  status through; the API's range handling already treats 200 as a full body. The conformance
  suite requires 206, so a server without ranges fails the suite but still works in the app.
- **`getlastmodified` formats** vary (RFC 1123 is required, some servers send ISO 8601).
  Parse with `Date`; a value that does not parse becomes the epoch, and `list` never throws
  for it.
- **`MKCOL` on an existing collection** is 405 on most servers but some answer 409 or 403.
  The `parents` path stats on any of those and succeeds when a collection exists.
- **Nextcloud and ownCloud** put the username in their canonical DAV path
  (`/remote.php/dav/files/<user>/`). The legacy `/remote.php/webdav/` endpoint maps to the
  authenticated user and works with a fixed endpoint. A `pathTemplate` config field with
  `{username}` is the deferred alternative; it must never accept a template that escapes the
  endpoint prefix.
- **Large listings** are buffered before parsing; the 32 MiB / 100 000-entry bounds keep
  memory predictable. A streaming multistatus parser is not planned.
- **Digest authentication** is refused (`unauthorized` with a clear detail when the challenge
  has no `Basic` scheme). Operators enable Basic over HTTPS.
- **Locks**: a locked resource answers 423; mapped to `conflict`. Native writes can take an exclusive root lock in the explicitly qualified Apache configuration; see [macOS writes](MACOS.md#write-configuration-and-recovery). Other DAV operations still respect the upstream lock.
- **Second real server**: `hacdias/webdav` or Apache `mod_dav` in the integration profile
  would widen coverage. Deferred to keep one heavy container suite per run.
