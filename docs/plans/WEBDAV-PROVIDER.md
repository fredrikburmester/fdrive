# WebDAV storage provider

Status: slices 1–4 implemented (PR #5, see [STATUS](../workflow/STATUS.md)); slices 2–5 open. Reviewed against source on 2026-09-11. Supersedes the WebDAV
section that lived in [ROADMAP](ROADMAP.md). Contracts and integration points are those in
[the provider guide](../STORAGE-PROVIDERS.md); nothing here changes the `ProviderModule` or
`StorageProvider` ports.

## Outcome

Administrators add a WebDAV server under **System > Storage** by endpoint URL. People log in
to it with a username and password, link it beside an SFTPGo login, and browse, upload,
download, rename, move, copy and delete through the ordinary file UI. Shares, Office, search,
thumbnails and scope mapping stay unavailable for WebDAV logins; the UI hides those controls
and the API refuses them, as it already does through capability flags.

Targets: any RFC 4918 class 1 server behind Basic authentication. Verified against a real
server in CI (SFTPGo's own WebDAV binding) and against a protocol fake in unit tests. Nextcloud,
ownCloud, Apache `mod_dav` and nginx `ngx_http_dav_module` are the intended real-world targets
but are not part of CI; see risks.

Non-goals for this plan: Digest or OAuth authentication, fdrive-owned shares, a remote index
walker, Office admission, server-side zip, WebDAV locking (`LOCK`/`UNLOCK`), and
`{username}` path templates (see deferred items).

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Package | `packages/webdav`, `@fdrive/webdav`, copied from `packages/sftpgo` configs | The guide's step 1; keeps protocol code, adapter and fake together and out of the API. |
| XML | `fast-xml-parser` 5.11.1 with `removeNSPrefix`, `ignoreAttributes: false`, `isArray` for `response`/`propstat` | Already pinned in the lockfile for Office discovery; prefix-neutral parsing handles `D:`, `d:` and default-namespace servers alike. |
| Authentication | Basic on every request from `session.getCredential()`; no `mint` | WebDAV has no token flow; the guide's Basic-auth path. No retry on 401: the credential itself is wrong or revoked. |
| `authenticate` | `PROPFIND` Depth 0 on the endpoint root with the credential | Proves the credential and that the root is a collection. 401 → `unauthorized`, 403 → `forbidden`, network/5xx → `upstream_unavailable`. |
| `probe` | `OPTIONS` on the endpoint; ok when 2xx with a `DAV` header containing class `1`, or 401/403 carrying `WWW-Authenticate` | Servers commonly refuse anonymous `OPTIONS`; a challenge still proves a reachable HTTP endpoint. Reuse SFTPGo's URL checks: http(s) only, no userinfo, no metadata hosts, 5 s timeout, 1 KiB body bound. |
| Config fields | none | Endpoint and label are row fields. Nothing else is needed for class 1 servers. |
| Credential fields | `username` (text, required, 255) and `password` (password, required) | Confirmation forms already render `password`; `ctx.expectedUsername` fills `username` on link/unlink. |
| Redirects | `redirect: "manual"`; any 3xx is an error (`upstream_unavailable`) | Never forward Basic credentials to a `Location` the server chose. Operators enter the final URL. |
| Capabilities | `zip` false, `setModifiedAt` false, `atomicMove` true, `shares` false, `office` false, `index` false, `scopeMapping` false, `trash` per slice 5 | Only `MOVE` is a native single operation. No standard mtime setter; `X-OC-Mtime` is sent on upload as best effort but not advertised. |
| Trash | `"move"` strategy in slice 5, `trash: false` until then | Generic move Trash exists in core and the storage factory; the missing piece is provider-aware copy in the Trash settings card, which today reads "SFTPGo recycle-bin rules". |
| Real backend in CI | SFTPGo's WebDAV binding, exposed by `startSftpgo` | No new image, already seeded users and files, one heavy container at a time. A second server is a follow-up. |

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

## Work slices

Each slice ends with its checks green and a STATUS note. Slices 1–3 are one cohesive change
in this checkout; 4 and 5 are separable follow-ups.

### 1. Package and protocol client

- `packages/webdav`: `package.json` (deps `@fdrive/core`, `fast-xml-parser`; dev
  `@fdrive/config`, `@fdrive/testkit`), `tsconfig*.json`, `vitest*.config.ts`, `src/index.ts`.
- `src/errors.ts`, `src/http.ts` (URL building, Basic header, safe fetch, signals, bounded
  body reads), `src/path.ts` (segment encoding, href resolution), `src/xml.ts` (propfind body,
  multistatus parsing), `src/client.ts` (raw DAV operations bound to one endpoint and one
  credential), `src/probe.ts`.
- `src/fake/server.ts`: in-memory class 1 server exposing `fetch`, with users, an optional
  path prefix, href style (absolute URL or path), `OPTIONS`/`PROPFIND`/`GET`/`HEAD`/`PUT`/
  `MKCOL`/`MOVE`/`COPY`/`DELETE`, `Range`/`If-Range`, `If-None-Match: *`, `Overwrite`,
  `Depth`, `X-OC-Mtime`, and toggles for redirect answers, missing `DAV` header and a
  read-only user. Lives in `src` so the API and web tests can import it; needs its own tests
  to hold the 99/95 coverage gates.
- Unit tests per module, including malformed and oversized XML, foreign-origin and
  out-of-prefix hrefs, literal-percent and Unicode names, redirect refusal, and every status
  in the error table.

Check: `verify.sh "$PWD" package @fdrive/webdav`.

### 2. Storage adapter and module

- `src/storage-provider.ts` implementing the table above; own-property methods (Trash
  wrappers spread the object); omit `zip`, `setModifiedAt` and `trash`.
- `src/module.ts`: `createWebdavModule({ clientFor? })` and `webdavModule`; `authenticate`
  honours `ctx.expectedUsername` and refuses a credential naming another user.
- `src/conformance.test.ts`: `describeStorageProvider` over the fake with
  `overwritesOnMove: true`, plus the fake with a path prefix and absolute-URL hrefs.
- Adapter tests beyond the suite: matching and stale `ifRange`, mid-stream abort, upload
  cancellation, `overwrite: false` race, permission mapping, `deleteFile` on a directory.

Check: `package @fdrive/webdav` again.

### 3. Registration, presentation and gates

- `packages/contracts/src/providers.ts`: `ProviderType` gains `"webdav"`.
- `apps/api/package.json` adds `@fdrive/webdav`; lockfile through
  `run-in-checkout.sh "$PWD" --lock -- pnpm install`; registry adds `webdav: webdavModule`.
- `apps/web`: `PROVIDER_TYPE_LABELS.webdav = "WebDAV"`, `ICONS.webdav = Globe`.
- Tests that enumerate types: `apps/api/src/providers/routes.test.ts` (`types` now
  `["sftpgo", "webdav"]`), `apps/web/src/lib/identity/provider-type.test.ts` (its unknown-type
  case uses the string `webdav`; pick another), plus whatever `application` coverage surfaces.
- Add an API route test that adds a WebDAV provider through `POST /admin/providers`, logs in
  against the fake, lists and uploads, and gets `unsupported` from shares, Office and
  scope-mapping routes. Add a same-path isolation test with SFTPGo and WebDAV linked on one
  account, following `provider-binding.test.ts`.
- Confirm the API image still builds (`docker build -f apps/api/Dockerfile .`): the Dockerfile
  builds every workspace dependency of the API, so no edit is expected.

Checks: `application`, `integration`, `browser e2e/login-providers.spec.ts
e2e/system-storage.spec.ts --workers=1`, `workflow`, and a real dev-app pass: add a WebDAV
row pointing at the dev SFTPGo's WebDAV port, log in, browse, upload, rename, delete.

### 4. Real server conformance

- `packages/testkit/src/containers/sftpgo.ts`: enable `SFTPGO_WEBDAVD__BINDINGS__0__PORT`
  (8081, address empty), expose it, return `webdavUrl` on `SftpgoContainer`; one assertion in
  `test/integration/containers.test.ts`.
- `packages/webdav/test/integration/container.contract.test.ts`: `describeStorageProvider`
  against `webdavUrl` as alice, plus the denied-permission case (bob writing at his root
  answers 403 → `forbidden`), redirect and out-of-prefix href handling, and a cross-identity
  same-path check.
- Browser: extend `e2e/system-storage.spec.ts` to add a WebDAV row against the e2e stack's
  SFTPGo WebDAV port and `e2e/login-providers.spec.ts` to sign in through it, browse and
  upload one file. Requires the e2e compose stack to publish that port.

Checks: `package @fdrive/testkit`, `integration`, the two browser specs.

### 5. Trash through generic move

- Module: `trash: "move"`, capability `trash: true`. The storage factory already wraps
  `withMoveToTrash` under `createRecycleFolderTrash` for that strategy.
- `apps/web/src/components/system/trash-settings-card.tsx`: copy keyed on the active
  provider's strategy. The settings endpoint already resolves the caller's active provider;
  expose the module's `trash` strategy through the Trash settings response (contract change in
  `packages/contracts/src/trash.ts`) so the card can say "fdrive moves deleted files into this
  folder" instead of asking for SFTPGo rules, and skip the rules-confirmed checkbox for
  `"move"` providers (the contract's `rulesConfirmed` refinement becomes strategy-aware).
- `docs/TRASH.md`: a section for providers where fdrive performs the move.
- Tests: a real round trip (delete, list, restore, purge, empty) on the SFTPGo WebDAV
  container, mirroring the generic-move test in the SFTPGo container suite; card tests for
  both copies.

Checks: `package @fdrive/contracts`, `application`, `integration`, `browser e2e/trash.spec.ts`.

## Documentation

- `docs/STORAGE-PROVIDERS.md`: WebDAV is registered; note its capability set and the SFTPGo
  WebDAV binding as the reference real backend.
- `docs/plans/README.md` and `ROADMAP.md`: this plan replaces the roadmap section; remove the
  plan when slices 1–4 land and move slice 5 to FOLLOWUPS if it is deferred.
- `docs/workflow/STATUS.md`: handoff notes per slice; evidence to history when complete.

## Risks and open questions

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
- **Locks**: a locked resource answers 423; mapped to `conflict`. fdrive never takes locks.
- **Second real server**: `hacdias/webdav` or Apache `mod_dav` in the integration profile
  would widen coverage. Deferred to keep one heavy container suite per run; revisit after
  slice 4.
