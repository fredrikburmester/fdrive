# fdrive — plan

A self-hosted Google Drive / Filestash replacement that runs **on top of an existing SFTPGo**.
It absorbs the `filesai` stack (index, search, OCR, embeddings, MCP) and adds a modern web UI,
tags, favorites, multi-account login, and ONLYOFFICE editing. One Docker Compose stack.

Status: plan v1, 2026-09-06. Progress: phase 0 and phase 1 done; phase 2 waves 1 and 2 merged (indexer, search, admin setup, System pages, OCR service, MCP with API tokens); phase 3 (tags, favorites, recents, rename tracking) merged on 2026-09-06 evening, API and web; thumbnail-only rebuild job merged; P2-CLEAR-JOBS implemented in the working tree (background clears, thumbnail controls consolidated, settings descriptions); phase 3 real SFTP rename validated (metadata propagation 2.39s); phase 4 complete in the working tree on 2026-09-07: WOPI host, registry, deployment, edit admission, and the opt-in real-editor suite (ONLYOFFICE 7/7, Collabora 4/4); phase 5 accounts, shares, provider-bound credentials, and the blocking performance harness integrated (search p95 budget still failing on this machine, see docs/workflow/STATUS.md); nothing committed since 1fe7388. Investigation notes that back this plan: filesai source read in
full; SFTPGo verified against the OpenAPI spec on `main` (v2.7.0) and Go source, stable release
v2.7.5; ONLYOFFICE verified against Document Server 9.4 docs and source, Microsoft WOPI spec, and oCIS.

---

## 1. Goals and non-goals

**Goals (v1)**

- Browse, upload (drag and drop, folders, many files), download, zip download, move, copy,
  rename, delete, mkdir. Feature parity with what you use Filestash for today.
- Previews: images, video, audio, PDF, text and code, markdown. Office via ONLYOFFICE.
- Search: hybrid semantic + full-text + filename, with snippets, scoped per user.
- Tags, favorites, recents. Survive renames made through SFTP, WebDAV, or any other client.
- Login with SFTPGo credentials only, no SFTPGo admin access needed. One app account can link
  several SFTPGo identities.
- MCP server for Claude with per-user tokens, same tool set as today.
- ONLYOFFICE editing over WOPI.
- Compose stack that points at an existing SFTPGo, or optionally bundles one.
- Performance, testability, coverage gates in CI (see §10).

**Original v1 non-goals**

The 2026-09-07 all-phases request schedules the recovery and second-provider items in Phase 6.
Other exclusions below remain unchanged; configurable embeddings remain separately deferred.

- Storage providers other than SFTPGo. The design leaves room (see §4.2) but ships none.
- Versioning / file history, trash, comments, real-time collaboration outside ONLYOFFICE.
- Mobile apps. The web UI is responsive but the desktop layout is the priority.
- Admin UI for SFTPGo users, quotas, and rules. SFTPGo's own WebAdmin stays for that.
- OIDC login. SFTPGo's OIDC only works for its own web UI; our login uses SFTPGo credentials.

---

## 2. What the investigation established

### 2.1 SFTPGo user API (verified)

| Need | What SFTPGo offers |
|---|---|
| Login | `GET /api/v2/user/token` with HTTP Basic (+ `X-SFTPGO-OTP`). JWT, default 20 min, **no refresh endpoint**, bound to caller IP by default. |
| Password-free access (not used, see §15) | Admin can mint a **user-scoped API key** (`POST /api/v2/apikeys`, `scope: 2`, `user`). Sent as `X-SFTPGO-API-KEY` on all `/api/v2/user/*` file endpoints. Requires `filters.allow_api_key_auth` on the user. Cannot call profile, logout, changepwd, TOTP. |
| List | `GET /user/dirs?path=` → `{name, size, mode, last_modified}[]`, no pagination, gzip. Dir if `mode & 0x80000000`, symlink if `mode & 0x08000000`. |
| Download | `GET /user/files?path=` streams with `Range`, `If-Range`, `Last-Modified`; **`HEAD` works as stat**. Always `Content-Disposition: attachment`. |
| Upload | `POST /user/files/upload?path=<full path>&mkdir_parents=1` raw streaming body, `X-SFTPGO-MTIME` header. Multipart variant exists. **No resumable or chunked upload.** |
| Mutations | `POST /user/file-actions/move`, `POST /user/file-actions/copy`, `POST /user/dirs`, `DELETE /user/dirs` (recursive), `DELETE /user/files`, `PATCH /user/files/metadata` (mtime). |
| Zip | `POST /user/streamzip` with a JSON array of paths. |
| Shares | Full CRUD under `/user/shares`, public endpoints under `/shares/{id}` with Range support. |
| User facts | `home_dir`, permissions map, quota, virtual folders, filesystem provider are **admin-only** (`GET /api/v2/users/{username}`). The user token exposes only web-client option flags. |
| Change events | Admin can create Event Manager rules via API: trigger Filesystem, `fs_events` (upload, delete, rename, mkdir, rmdir, copy…), HTTP action with a free-form templated body (`{{.Name}}`, `{{.Event}}`, `{{.VirtualPath}}`, `{{.VirtualTargetPath}}`, `{{.FsPath}}`, `{{.Protocol}}`…). |
| CORS | Off by default. We avoid it entirely by proxying through our API (same origin). |

**Consequences**

- We need a backend between the browser and SFTPGo anyway (no CORS, token refresh, scoping,
  metadata). The browser never talks to SFTPGo directly.
- Credential mode only (§5): fdrive never needs SFTPGo admin access. Home directory, permissions,
  and quota are therefore not readable; the plan works around each (§4.3, §6).
- Large uploads are single-shot. We get parallelism across files, not resumability within one.
- Listing is unpaginated. We virtualize on the client and cache on the server.

**Licensing.** SFTPGo is AGPL-3.0 with NOTICE terms asking external frontends for attribution
and a source link. This is a personal, non-commercial project, so the decision is simply: ship a
`LICENSE` of AGPL-3.0 and an About dialog that says "Built on SFTPGo" with a link to its source.
No further work.

### 2.2 filesai (read in full)

About 1,550 lines of Python plus a 64-line OCR shell script. Pieces and their fate:

| Piece | Today | In fdrive |
|---|---|---|
| `indexer.py` + `watcher.py` | Walk every 5 min plus inotify with rename-cookie pairing. Folder moves are one SQL update. Per-path locks so scan and watcher never double-index. | **Kept in Python**, moved to `services/indexer`, extended for multiple roots, thumbnails, and change events. |
| `extract.py` | pymupdf, tesseract, Tika, plain text; chunking 1200/200; e5 embeddings via TEI. | Kept. Also exposed over an internal HTTP endpoint for live extraction. |
| `db.py` schema | `files`, `chunks`, `scans`, `moves`. Path is unique and relative to one root. | Schema ownership moves to the TypeScript `db` package (Drizzle migrations). Python reads and writes; it no longer creates tables. `files` gains `root_id`. |
| `mcp_server.py` | FastMCP, bearer or token-in-path, hybrid RRF search, dedupe, similar, overview, gated writes. | **Rewritten in TypeScript** inside the API, on the same core search service the web UI uses. Per-user tokens. Same tool names. |
| `ocr/run.sh` | Nightly OCRmyPDF, keeps originals, refuses signed/encrypted. | Kept as-is in `services/ocr`. |
| Filestash | Web UI. | Replaced by fdrive. |
| Czkawka | Dedupe GUI. | Dropped from the stack; the index already knows exact duplicates and fdrive gets a duplicates view. Similar-image detection is deferred. |
| Raycast extension | Talks to MCP. | Repointed at fdrive's MCP with a per-user token; result URLs change to fdrive routes. |

Why the indexer stays Python: the inotify move detection depends on rename cookies, which no
maintained Node watcher exposes (`chokidar`, `@parcel/watcher` report delete+create; the `inotify`
npm package is unmaintained since 2022). Porting means re-implementing the ctypes binding with an
FFI library and re-earning the tuning already measured on your box. The service is small and gets
its own test suite and coverage gate.

---

## 3. Architecture

```
 browser ──► Caddy (TLS, one origin)
               ├── /            → web   (Next.js 16, React 19)
               ├── /api/*       → api   (Hono on Node 24)
               ├── /wopi/*      → api
               ├── /mcp         → api
               ├── /s/*        → web   (public share pages, §6.1)
               └── /onlyoffice/ → ONLYOFFICE Document Server (optional)

 api ──► SFTPGo REST API (user JWT, re-minted from stored credentials)  ← the only user-facing file I/O
 api ──► Postgres (app metadata + index, one DB, two schemas)
 api ──► TEI embeddings (query vectors)
 api ◄── ONLYOFFICE (WOPI callbacks)
 api ◄── indexer (change events via LISTEN/NOTIFY; live extraction over internal HTTP)

 indexer (Python) ──► disk roots (read-only bind mounts)  ──► Postgres index schema, thumbnail cache
 ocr     (Python) ──► disk roots (read-write), nightly
 tika, embed      internal only
 sftpgo           optional, `bundled` profile
```

**Boundaries**

- `packages/core` is pure TypeScript with no I/O. It defines ports (interfaces) for storage,
  metadata repositories, index queries, embeddings, clock, ids, and implements every use case
  against them. This is where the 99% function coverage lives naturally, because everything is a
  function of inputs and fakes.
- Adapters implement the ports: `packages/sftpgo` (HTTP client + in-memory fake that behaves like
  SFTPGo, used in tests), `packages/db` (Drizzle repositories), embeddings client, WOPI.
- `apps/api` wires adapters to core and exposes HTTP. Route handlers are thin: parse, call use
  case, serialize. Hono uses Web-standard Request/Response, so route tests run in-process with
  `app.request()` and no sockets.
- `apps/web` is UI only. It calls the API through a typed client generated from the same zod
  schemas (`packages/contracts`). No business rules in components.

**Why a separate API instead of Next.js route handlers.** Streaming multi-gigabyte downloads and
uploads, WOPI callbacks from another container, the MCP streamable-HTTP transport, and SSE all
fit better in a plain Node HTTP server than inside Next's runtime. It also keeps the API testable
without booting Next. Next.js stays for what it is good at: the UI, routing, RSC for the shell.

---

## 4. Domain model

### 4.1 App metadata (schema `app`)

| Table | Purpose |
|---|---|
| `providers` | A storage backend instance. v1: exactly one row of type `sftpgo` from env (base URL). The table exists so a second SFTPGo or another backend is a row, not a refactor. |
| `accounts` | An fdrive user. Created on first successful login. |
| `identities` | A login on a provider (`provider_id`, `external_username`). Belongs to one account. Each identity is a **mount** the account can browse. |
| `credentials` | Per identity: the SFTPGo password, envelope-encrypted with `FDRIVE_MASTER_KEY` (§5), plus the current cached JWT and its expiry. |
| `sessions` | Opaque server-side sessions (id hashed in DB, cookie carries the raw id). Holds `account_id`, active identity, expiry, UA/IP. |
| `api_tokens` | Long-lived per-account tokens for MCP and Raycast. Hashed. Scoped to an identity or the whole account. |
| `tags`, `file_tags` | Tags per account. `file_tags` keyed by (`identity_id`, `path`, `tag_id`). |
| `favorites`, `recents` | (`identity_id`, `path`) rows with timestamps. |
| `thumbnails` | Cache manifest: content key → file on disk, sizes, generated_at. |
| `wopi_locks` | WOPI lock state per file id (§8). |
| `office_files` | Durable office UUIDs per provider/root/path, retained across rename and independent of index clearing. Deleted paths are tombstoned; recreation gets a new UUID. |
| `shares` | fdrive's record of shares created through SFTPGo: SFTPGo share id, identity, paths, scope, expiry, whether a password is set, view counters. The public page (§6.1) reads this and proxies to SFTPGo. |
| `settings` | Key/value for things an admin might edit in the UI later (index rules, feature flags). |

**File identity for metadata is (`identity_id`, `path`).** Paths are the SFTPGo virtual paths for
that identity. Three mechanisms keep metadata attached across renames:

1. Moves made through fdrive update metadata in the same transaction as the SFTPGo call succeeds.
2. Moves seen by the indexer (SFTP, WebDAV, OCR, anything on disk) arrive as `moved(root, old,
   new)` events; the API maps the fs path to every identity whose scope contains it and rewrites
   `file_tags`, `favorites`, `recents` with one prefix update per table.
3. Optional webhook: if you configure an SFTPGo Event Manager rule by hand to POST rename and
   delete events to `/api/v1/hooks/sftpgo` with a shared secret, that becomes a second event
   source for an SFTPGo without a disk mount. Documented, never required.
4. Fallback: a tagged path that vanishes while an index row with the same sha256 appears elsewhere
   in the same scope is relinked.

### 4.2 Index (schema `idx`, shared with the Python indexer)

`files` as today plus `root_id`, unique on (`root_id`, `path`); `chunks`, `scans`, `moves`
unchanged; new `events` table (or NOTIFY channel) for `created | changed | deleted | moved`.

**Index roots** are configured, not discovered:

```yaml
FDRIVE_INDEX_ROOTS: |
  - name: sftpgo
    sftpgoPath: /srv/sftpgo/data      # how paths look in SFTPGo's home_dir / mapped_path
    indexerPath: /roots/sftpgo        # where the indexer container mounts the same directory
```

### 4.3 Scoping: the one function everything goes through

`scopeFor(identity) -> Scope[]`, where a scope is `{ rootId, fsPrefix, virtualPrefix }`.

- From `FDRIVE_HOME_TEMPLATE`, default `sftpgo:/{username}` (root name, then the path of the
  user's home inside that root). Per-identity overrides live in `settings` for users whose home
  or virtual folders do not follow the template; administrator-editable from the account page.
- If the identity's storage is not on a configured root (S3-backed SFTPGo user, remote SFTPGo),
  the scope is empty: browsing still works through SFTPGo, search and thumbnails are hidden.
- Correctness check on login: the API lists the identity's root through SFTPGo and compares entry
  names against the scope's directory on disk via the indexer. A mismatch disables index-backed
  features for that identity and shows a warning. This detects obvious mistakes, not identity:
  two different roots can contain identical names. Administrator-controlled mappings remain
  the authorization boundary; live per-path SFTP read checks additionally protect cached
  content from read-permission changes. See `docs/workflow/P5-SCOPES.md`.

Every index query (search, duplicates, similar, overview, thumbnails, live extraction) takes a
`Scope[]` and adds `WHERE (root_id, path) under any prefix`. Results are mapped back to virtual
paths before they leave core. Route handlers never see fs paths. This is also what fixes the
"Notes and keystore folders are searchable by anyone with the token" problem: a token belongs to
an identity, and the identity's scope is enforced in core.

Provider abstraction for later: `StorageProvider` port with `list`, `stat`, `read(range)`,
`write(stream)`, `mkdir`, `move`, `copy`, `delete`, `zip`. `SftpgoProvider` is the only
implementation. A future Drive or S3 provider implements the same port and gets its own
`identities` rows; the index needs a `changes since cursor` source per root, which the disk
watcher is one implementation of.

---

## 5. Authentication and sessions

**Login**: username + password (+ TOTP when SFTPGo demands it) → API calls
`GET /api/v2/user/token`. Success creates or finds the identity and account and stores the
password envelope-encrypted (per-row data key wrapped by `FDRIVE_MASTER_KEY`, AES-256-GCM). The
API re-mints a user JWT whenever the cached one is within 2 minutes of expiry, and on any 401 from
SFTPGo. No SFTPGo admin access is used anywhere.

Trade-offs, stated on the account page: fdrive holds your SFTPGo password at rest, encrypted;
changing the password in SFTPGo requires re-login here; SFTPGo permissions are discovered by
trying (a 403 becomes a disabled action, remembered per directory for the session); quota is not
shown because the user API does not expose it.

SFTPGo's token IP binding is fine because SFTPGo always sees the API container's IP.
`signing_passphrase` should be set on SFTPGo so its restarts do not invalidate tokens mid-request;
the API tolerates it either way by re-minting on 401.

**Sessions**: httpOnly, Secure, SameSite=Lax cookie with an opaque id; server-side row. Linking
another SFTPGo identity is the same login flow while signed in. The identity switcher changes the
session's active identity; cross-identity views (favorites, search) query all identities of the
account.

**MCP and Raycast**: `api_tokens`, created on the account page, shown once. Bearer header or
token-in-path, as today, because claude.ai connectors cannot set headers.

---

## 6. Files API and performance

All endpoints under `/api/v1`, JSON with zod schemas in `packages/contracts`.

| Endpoint | Notes |
|---|---|
| `GET /fs/list?identity&path` | Calls SFTPGo, normalizes entries (kind, size, mtime, ext, mime guess), merges tag/favorite flags in one query, returns an ETag from the entry set hash. 60 s server cache keyed by identity+path, invalidated by our own mutations and by indexer events. |
| `GET /fs/download?identity&path` | Streams from SFTPGo with `Range` passthrough; `Content-Disposition` inline for previewable types. |
| `GET /fs/zip` | Fans out to `streamzip`. |
| `POST /fs/upload?identity&path` | Raw body streamed straight to `POST /user/files/upload`, `X-SFTPGO-MTIME` from the client. No buffering in Node. |
| `POST /fs/mkdir`, `/fs/move`, `/fs/copy`, `/fs/delete`, `/fs/rename` | Thin. Move and rename also rewrite metadata transactionally. |
| `GET /fs/stat` | `HEAD` against SFTPGo for files, parent listing for dirs. |
| `GET /events` | SSE. Folder-scoped change notifications from our mutations and indexer events. |
| `GET /thumb?identity&path&size` | Scope check, then serve from the thumbnail cache by content key; on miss for images, generate on demand with sharp from the SFTPGo stream and cache. |
| `GET /preview/text?identity&path` | Extracted text via the indexer's internal endpoint (live), scoped. |

### 6.1 Public share pages

Shares are created through SFTPGo's user share API with the identity's JWT, recorded in `shares`,
and served by fdrive's own pages at `/s/:id`. SFTPGo may not be reachable from the internet, so
**all public traffic goes through fdrive**: the API proxies `GET /api/v2/shares/{id}/dirs`,
`/files` (with `Range`), the zip download, and uploads for write shares, sending the share
password as HTTP Basic when the share has one. Page features: folder browsing for directory
shares, previews using the same viewers as the app, zip download, password prompt, expiry and
download-limit messages, an upload drop zone for write shares. Share links are the only
unauthenticated routes in the app and are rate limited.

**Uploads from the browser**: a queue with 4–6 concurrent streams, per-file progress via
`XMLHttpRequest` upload events (fetch lacks upload progress in most browsers), folder drops walked
with `webkitGetAsEntry`, conflict prompts, pause and retry per file. No resumability inside one
file in v1 because SFTPGo has none; documented.

**Performance budgets** (measured in CI against the compose stack, informational at first,
gating once stable):

| Metric | Budget |
|---|---|
| List 1,000 entries, API p95 | < 100 ms warm, < 400 ms cold |
| List 10,000 entries, time to interactive in UI | < 500 ms after data (virtualized rows and grid) |
| Download throughput through the API | ≥ 90% of direct SFTPGo |
| 200 small files dropped | all uploaded < 30 s on LAN |
| Search over 25k files, p95 | < 300 ms |

Phase 5 has an optional zero-copy path: the API issues a short-lived signed URL and Caddy proxies
downloads straight to SFTPGo after an `auth_request`-style check. Only built if the ≥ 90% budget
fails.

---

## 7. Search, index, MCP

**Search service in core**: the same hybrid ranking as `mcp_server.search` today (semantic top 60,
full-text prefix `tsquery` top 60, filename word hits plus trigram similarity, reciprocal rank
fusion k=60), expressed as three parameterized SQL queries behind an `IndexQueries` port. Scope is
a mandatory argument. Same service backs the search page, the command palette, and MCP.

**Indexer changes** (Python, `services/indexer`):

- Multiple roots: `INDEX_ROOTS=sftpgo=/roots/sftpgo,photos=/roots/photos`; `root_id` on every
  row; watcher and scan per root.
- Thumbnails: images via Pillow (256 and 1024 px WebP), PDFs via pymupdf first page, video via
  ffmpeg frame; written to `/thumbs/<sha[:2]>/<sha>.<size>.webp`, manifest row upserted. The
  indexer already opens every file, so this is one extra step, not a second pass.
- Change events: after each apply, `NOTIFY idx_events` with a compact JSON payload, plus a row in
  `idx.events` for replay after API restarts (pruned after 7 days).
- Internal HTTP (bound to the compose network only): `GET /health`, `GET /stats`,
  `POST /extract` (live text for a root-relative path), `POST /reindex` (path or all).
- Schema is applied by the TS migrations; the indexer waits for the expected schema version.
- Maintenance clears run in background threads, with progress in `/stats` and shared
  admission with explicit thumbnail rebuilds. Index clear removes scoped file rows and
  their chunks/embeddings, preserving originals, app metadata, cache, and event history.
  Thumbnail clear removes the shared preview cache and manifest, preserving text/index
  data; unsafe paths and failed deletions are retained and reported. Neither action pauses
  normal scans or on-demand generation, so derived data can subsequently reappear.
- Prefix rules (`TEXT_EXCLUDE_PREFIXES`, `OCR_IMAGE_PREFIXES`) become per-root globs, still env
  driven in v1, editable in `settings` later.

**MCP in TypeScript** (`apps/api/src/mcp`): `@modelcontextprotocol/sdk` streamable HTTP, stateless,
JSON responses. Tools with identical names and argument shapes to today: `search`, `find_files`,
`list_directory` (live via SFTPGo, not disk), `read_file_text`, `file_info`, `find_duplicates`,
`similar_files`, `folder_overview`, `index_stats`, and gated `create_folder`, `move_path`,
`recent_moves`. Writes go through SFTPGo with the token's identity, so SFTPGo permissions and
events apply. Result `url`s point at fdrive routes.

---

## 8. ONLYOFFICE over WOPI

Verified against ONLYOFFICE's WOPI docs, the Document Server source (`wopiClient.js`,
`wopiUtils.js`), the Docker image entrypoint, Microsoft's WOPI spec, and oCIS's `collaboration`
service, which drives both ONLYOFFICE and Collabora through one WOPI host in production.

**Decision: WOPI, not the native Docs API.** One host implementation serves ONLYOFFICE, Collabora,
and Microsoft 365. What WOPI gives up on ONLYOFFICE is tolerable for a file manager: no strict
(paragraph-lock) co-editing mode, no plugins or toolbar customisation, no `changesurl` history, no
JWT-gated access to the editor itself. What matters is reachable: real-time co-editing, autosave,
force save, save-as, rename, PDF forms, and conversion of legacy formats.

**Facts that shape the implementation**

| Topic | Verified detail |
|---|---|
| Version | Document Server 9.4.0 (2026-05-19), docker `onlyoffice/documentserver:9.4.0.1`. 9.4 **removed the 20-connection limit** in the Community build. Community still has mobile view only, no mobile edit. |
| Enabling | WOPI is off by default. `WOPI_ENABLED=true` in the container. `wopi.wopiZone` must be `external-https` when served over TLS. |
| Proof keys | Pinned Docker startup uses `/var/www/onlyoffice/Data/wopi_private.key` and `wopi_public.key`, ignoring similarly named path env overrides. Our wrapper generates a private deployment key with restrictive permissions and persists it. The host verifies `X-WOPI-Proof` / `X-WOPI-ProofOld` with RSA-SHA256, rejects timestamps older than20min or more than5min ahead, and refreshes discovery for rotation. The full proof URL comes from configured callback base plus raw path/query, never arbitrary forwarded headers. |
| Discovery | `GET {DS}/hosting/discovery`. ONLYOFFICE lists `view` before `edit` for the same extension, so action selection matches on `@ext` **and** `@name`. Placeholders `<name=VALUE&>` are stripped or filled; we fill `ui`, `rs`, `thm`, `dchat`, and append `WOPISrc`. Cache 12 h. |
| Host page | Form POST into the iframe with `access_token` and `access_token_ttl`. The TTL is an **absolute epoch in milliseconds**, not a duration. ONLYOFFICE also accepts a `docs_api_config` form field, the only way to pass `customization.forcesave` and similar options over WOPI. |
| Endpoints ONLYOFFICE calls | CheckFileInfo, GetFile, Lock, RefreshLock (every 10 min), Unlock, PutFile, PutRelativeFile (save-as and conversion), RenameFile. It never calls GetLock or UnlockAndRelock, but we implement them because Collabora and the WOPI validator do. |
| CheckFileInfo | Required by ONLYOFFICE: `BaseFileName`, `Size`, `Version`. Microsoft adds `OwnerId`, `UserId`. We send all five plus `UserFriendlyName`, `LastModifiedTime` (Collabora only), `UserCanWrite`, `UserCanRename`, `SupportsLocks`, `SupportsUpdate`, `SupportsRename`, `ReadOnly`, `Breadcrumb*`, `CloseUrl`, `PostMessageOrigin`, `FileNameMaxLength`. |
| Sessions and cache | Edit sessions are keyed by the **file id alone**, so all editors of one file share one session. Our `Version` is `mtime_ns:size:sha256-prefix`, hashing a bounded live upstream stream. ONLYOFFICE prioritizes optional `LastModifiedTime` over `Version` for viewer cache keys, so omit that field for ONLYOFFICE and retain it for Collabora. This makes same-size, same-timestamp external writes change the viewer cache key even without an indexer. |
| Locks | Deterministic lock id (the sanitized file id). 30-minute expiry, refreshed. 409 with `X-WOPI-Lock` on mismatch. ONLYOFFICE sends Lock even for read-only opens and shows an error dialog on 409, so **Lock returns 200 for read-only sessions** (oCIS fix). Locks are not user-owned: Unlock with a matching lock id from another user succeeds. |
| Empty files | `Size: 0` makes ONLYOFFICE substitute a locale template. For 0-byte `docx/xlsx/pptx` that is what we want for "new document"; for `odt/ods/odp` the `Size` field is omitted instead. |
| Save path | PutFile arrives on autosave, force save, and exit save, with `X-LOOL-WOPI-IsModifiedByUser`, `IsAutosave`, `IsExitSave`, `Timestamp` headers. On an unlocked file only a 0-byte target is accepted, else 409. Behind the scenes the API streams the body to SFTPGo's upload endpoint, then refreshes `Version`. |
| Networking | Enable private-IP callbacks for the internal API; metadata-IP access stays disabled. Persist an explicit `JWT_SECRET`. Public proxy forwarding must preserve the configured office origin/prefix. Default file limit100MiB. Do not bind-mount `local.json`; startup rewrites it. Health check on `/hosting/discovery`. |
| Formats | Edit: docx dotx docm odt txt, xlsx xltx xlsm ods csv, pptx potx pptm odp, pdf. View plus `convert` action: doc rtf html epub pages…, xls numbers…, ppt key…, djvu xps. `md` is not in any default list; we add it to `wopi.wordView` for viewing. Legacy formats are not converted implicitly: the UI offers "Convert and edit", which runs the `convert` action and lands in PutRelativeFile with `X-WOPI-FileConversion: true`. |
| Access control | WOPI cannot restrict who reaches the editor; the access token and our CheckFileInfo do that. Optionally `services.CoAuthoring.ipfilter` to restrict which hosts Document Server will fetch from. |

**Design**

- `OfficeProvider` port in core: `describe(fileId, user, mode) -> { actionUrl, formFields }`,
  `capabilities(ext) -> view | edit | convert`. Implementations: `WopiOfficeProvider` with a
  product profile (`onlyoffice`, `collabora`) for the quirks above. Discovery parsing, action
  selection, proof verification, lock state machine, and `Version` derivation are pure functions
  with fixtures from real discovery XML and Microsoft's proof-key test vectors.
- WOPI file id: durable opaque UUID in `app.office_files`, keyed by provider/root/path,
  shared across users of the same mapped file. Renames preserve the UUID and update
  its location. Index clearing cannot reset it. This corrects the earlier signed
  identity/path design, which would split co-editing sessions and violate stable-ID
  requirements. Every callback independently checks current identity scope and storage
  access; knowing a file UUID grants no authority. See `docs/workflow/P4-HOST-DESIGN.md`.
- Access token: short JWT (8 h absolute TTL) bound to session id, identity, file id, and
  permissions. Every WOPI request re-validates the session and the SFTPGo permission for the path.
  Tokens use the hashed session ID, expire no later than that session, and distinguish
  view from edit authority. SFTPGo's credential-only user API does not expose a
  per-path write-permission map. Real coediting testing disproved the earlier
  edit-intent assumption: another writer can save a read-only participant's changes.
  Denying that participant's own PutFile is insufficient. Preserve credential-only
  authentication with an explicit server-side operator policy, default deny. Rules
  bind provider UUID, exact username and virtual paths; operators grant only a subset
  of SFTPGo overwrite rights and close office sessions when rights change. This is
  trusted configuration, not automatic permission discovery. No write probes: even
  a zero-byte SFTP open/close can rename/delete originals through upload hooks.
  See `docs/workflow/P4-EDIT-ADMISSION.md`; Phase4 incomplete until guard and regression pass.
- Proof URLs use an explicitly configured callback base and the raw request path/query;
  arbitrary Host and forwarded headers cannot choose the signed origin.
- `wopi_locks` table: file id, lock id, expires_at. Refreshed by RefreshLock, purged by a sweep.
- `GetFile` streams from SFTPGo with the identity's credentials; `PutFile` streams to SFTPGo,
  sets mtime from the response, refreshes the cached listing, and emits an SSE change event.
- Editor route `/office/:identity/*path?mode=edit|view` renders the host page: a form POST into a
  sandboxed iframe with `Cache-Control: no-store`. Close and breadcrumb links come back to the
  browser route.
- New document: create a 0-byte `docx/xlsx/pptx` through SFTPGo, then open with `edit`
  (ONLYOFFICE fills a template); for ODF we write a real blank file from bundled templates.
- Thumbnails for Office files: deferred (icons). Revisit with `/lool/convert-to` after phase 4.

**Compose**

```yaml
onlyoffice:
  image: onlyoffice/documentserver:9.4.0.1
  profiles: [office]
  environment:
    WOPI_ENABLED: "true"
    JWT_ENABLED: "true"
    JWT_SECRET: ${ONLYOFFICE_JWT_SECRET}
    ALLOW_PRIVATE_IP_ADDRESS: "true"
    ALLOW_META_IP_ADDRESS: "false"
  volumes:
    - office_onlyoffice_data:/var/www/onlyoffice/Data
  healthcheck: { test: ["CMD", "curl", "-fs", "http://localhost/hosting/discovery"] }
```

The proxy exposes Document Server under `/onlyoffice/` on the same origin with
`X-Forwarded-Proto`. Document Server reaches the API at `http://api:3001/wopi/...` inside the
compose network, so `WOPISrc` uses that explicitly configured internal callback base.
Concrete overlays, persisted proof-key setup and the distroless Collabora profile
are documented in `docs/OFFICE.md`. Dev profiles bind loopback58090/58091.

**Testing**

- Pure functions: discovery parsing against saved ONLYOFFICE and Collabora XML; proof verification
  with Microsoft's published vectors and with signatures generated from our own test key; lock
  state machine as a table of (state, request) → (status, headers, new state); `Version`
  derivation.
- Route tests: the full WOPI surface with a signing helper that impersonates Document Server.
- End-to-end (nightly, optional locally): compose with the `office` profile, Playwright opens a
  docx, types, waits for PutFile, reopens, asserts content; a second user hits the lock; a Collabora
  container runs the same flow to prove the host is product-neutral.

---

## 9. Web UI

Next.js 16 app router, React 19, Tailwind 4, shadcn/ui, TanStack Query, TanStack Virtual,
`dnd-kit` for internal drag and drop, native HTML5 drop for OS files, `cmdk` for the palette,
zustand for selection and the upload queue.

**UI component rule (hard constraint).** Every visible control comes from the latest shadcn/ui
registry, added through the shadcn CLI into `src/components/ui`. No hand-rolled buttons, inputs,
menus, dialogs, sheets, tables, or tooltips, and no other component library. Composition of
shadcn primitives into fdrive-specific components (file row, breadcrumb bar, upload queue) is
expected; reimplementing a primitive that shadcn already ships is not. When a shadcn component
needs a behaviour it lacks, extend it in place following shadcn's own patterns rather than
replacing it. The current scaffold is shadcn's Base UI based generation (`base-nova` style), and
that is what "latest" means here.

**Design language: Apple-like.** Calm, quiet surfaces with generous whitespace, a restrained
neutral palette with one accent, system font stack (SF Pro on Apple platforms via
`-apple-system`), subtle depth through translucency and hairline borders rather than heavy
shadows, rounded corners consistent with shadcn's radius tokens, motion that is brief and eased,
and typography hierarchy carried by weight and size rather than colour. Sidebar plus content
layout in the spirit of Finder and iCloud Drive: sidebar for locations and tags, toolbar for view
and sort, details in a trailing inspector pane. Dark mode is first-class, not an afterthought.
Icons from lucide, thin stroke, never filled. Theme tokens live in `globals.css` and are the only
place colours are defined.

Screens: login; browser (list and grid, virtualized, multi-select, keyboard navigation, context
menu, breadcrumbs, details pane with tags, favorites, duplicates, similar files); a folder tree in
the sidebar (lazy-loaded, expands on demand, drag targets for moves, keeps in sync with the
listing); search results with snippets and filters (folder, type, date); favorites; recents; tags;
account page (identities, API tokens, scope override); public share page; About with SFTPGo
attribution. Previews as a route so the back button works. Text, code, and markdown files are
editable in place (CodeMirror 6 inside a shadcn shell, markdown with a side-by-side or toggled
preview, save through the upload endpoint with a modified-time check so a concurrent change is
never silently overwritten). Saving is explicit (Save button and Cmd+S) with a dirty indicator
and an unsaved-changes guard; a debounced autosave is a later opt-in preference, not the default,
because every save is an upload that the indexer re-extracts and re-embeds. Office files open in an
ONLYOFFICE route.

**Duplicate, compress, extract.** Duplicate copies an entry next to itself with a unique name
("report copy.pdf", "report copy 2.pdf"). Compress builds an archive from the selection in one of
`zip`, `tar.gz`, or `tar.zst` and writes it beside the selection (name and destination editable);
Extract unpacks `zip`, `tar`, `tar.gz`, `tgz`, `tar.zst`, and `gz` into a folder named after the
archive (destination editable). SFTPGo has no server-side archiving, so the API does the work:
it streams the sources from SFTPGo, spools to a temp file where the format needs random access
(zip extraction), and uploads the result. These are long-running, so they run as jobs: `POST`
returns a job id, progress arrives over the existing SSE stream as `job` events, and the Activity
panel (the upload panel, generalised) shows them with cancel. Zip-slip is prevented by normalising
every entry path and refusing anything that escapes the destination. Temp space is configurable
(`FDRIVE_TMP_DIR`) and capped per job.

**Search bar (phase 2).** A top-right search field opens a command-palette style panel, not a
plain result list: sections for Folders, Files, Content matches (with snippet and highlighted
terms), Recent, and Tags; thumbnails for images and PDFs, icons otherwise; keyboard navigation;
Enter opens, Cmd+Enter reveals in folder; filters as chips (folder, type, date, tag). Powered by
the hybrid search service, results scoped per identity.

**Setup and administration (phase 2).** The SFTPGo connection is configured either by
environment (`SFTPGO_URL`, `FDRIVE_HOME_TEMPLATE`) or through a first-run `/setup` page shown
while no provider exists: it asks for the SFTPGo URL, tests the connection, sets the home
template, and stores the result in the `settings` table. The page is protected by a one-time
setup token printed to the API log at start, so a fresh install cannot be claimed by a stranger.
The account that completes setup becomes the administrator; `FDRIVE_ADMIN_USERS` can name more
SFTPGo usernames. Administrators see the System sidebar section (connection, home template,
sidecar pages below, later ONLYOFFICE). The login page says "Sign in with your SFTPGo account"
and shows the server host from a public config endpoint, never "fdrive account".

**Sidecar settings in the sidebar (phase 2).** A "System" sidebar section with one page per
sidecar: Indexer (roots, scan interval, watcher status, queue depth, last scan, errors, reindex
actions), Search and embeddings (model, dimension, chunks embedded, embedding server health,
re-embed), OCR (schedule, languages, excluded folders, last run, processed and skipped counts,
originals location, run now), Thumbnails (cache size, scoped rebuild, force regenerate,
clear cache, job progress), and later ONLYOFFICE
(reachability, WOPI discovery status). Each page reads live status over the internal HTTP
endpoints of the services and writes options to the `settings` table, which the services pick
up on their next cycle. Thumbnail controls belong only on Thumbnails; Indexer owns
reindex and scoped clear-index controls. Clear actions require confirmation explaining
their effects and eventual regeneration. Each Indexer setting has a one-line description.
All of it is controlled from fdrive web; nothing needs a shell.

Components are covered by Playwright end-to-end tests and a small number of component tests;
hooks and pure UI helpers (sorting, formatting, selection logic, upload planning) live in
`packages/core` or `apps/web/src/lib` and are unit tested to the same gate.

---

## 10. Testing and quality gates

| Layer | Tooling | Gate |
|---|---|---|
| `packages/core` | Vitest, fast-check for path normalization, scoping, and ranking properties | functions 100%, lines ≥ 99%, branches ≥ 95% |
| `packages/sftpgo` | Vitest against the in-memory fake and against a real `drakkan/sftpgo` container via testcontainers with seeded users, permissions, and virtual folders | functions ≥ 99% |
| `packages/db` | Vitest against Postgres via testcontainers, migration up/down tests | functions ≥ 99% |
| `apps/api` | Route tests with `app.request()` and fakes; integration tests against the compose test stack (SFTPGo + Postgres + TEI) | functions ≥ 99% |
| `services/indexer` | pytest + coverage, tmp dirs, real Postgres via testcontainers; inotify tests run in Docker (Linux only) | lines ≥ 99% |
| `apps/web` | Vitest for hooks and lib, Playwright for flows: login, browse, upload via drop, move via drag, tag, search, open in ONLYOFFICE | lib functions ≥ 99%; components excluded from the function gate |
| Contracts | zod schemas are the single source; OpenAPI generated from them and diffed in CI | no drift |
| Static | TypeScript strict, `noUncheckedIndexedAccess`, Biome (lint + format), ruff + mypy strict for Python | zero warnings |
| Security | Path traversal property tests, scope enforcement tests for every index query, dependency audit | blocking |
| Perf | k6 scripts against the compose stack, budgets from §6 | informational → blocking in phase 5 |

Coverage is enforced per package in `vitest.config.ts` thresholds and in CI; a package cannot
merge below its gate. Tests run in GitHub Actions on Linux with Docker available.

---

## 11. Repository layout

```
fdrive/
  apps/
    web/                 Next.js UI
    api/                 Hono API: REST, SSE, WOPI, MCP
  packages/
    core/                domain, ports, use cases (pure)
    contracts/           zod schemas + generated OpenAPI + typed client
    sftpgo/              SFTPGo REST client + in-memory fake
    db/                  Drizzle schema (app + idx), migrations, repositories
  services/
    indexer/             Python: walk, watch, extract, embed, thumbnails, internal HTTP
    ocr/                 OCRmyPDF nightly job (unchanged)
  deploy/
    compose.yaml         core stack, expects external SFTPGo
    compose.office.yaml  adds ONLYOFFICE
    compose.sftpgo.yaml  opt-in, only for people without an SFTPGo
    Caddyfile
    .env.example
    unraid/              notes for compose.manager and appdata layout
  docs/
  raycast/               existing extension, repointed
```

Tooling: pnpm workspaces, Turborepo, Node 24, TypeScript 5.x strict, Biome, Changesets not needed
(single deployable), Docker multi-stage images published to GHCR.

---

## 12. Compose stack

| Service | Image | Notes |
|---|---|---|
| `proxy` | Caddy | Single origin, TLS optional (behind your NPM it stays HTTP). Large bodies, websockets for ONLYOFFICE. |
| `web` | fdrive-web | Next standalone output. |
| `api` | fdrive-api | Node 24, non-root. Env: SFTPGo URL, master key, DB URL, roots, home template, ONLYOFFICE URL + secret. |
| `db` | pgvector/pgvector:pg17 | App and index schemas. Own volume. Never SFTPGo's DB. |
| `indexer` | fdrive-indexer | Roots bind-mounted read-only at `/roots/<name>`; thumbnail volume read-write. |
| `ocr` | fdrive-ocr | Roots read-write, nightly. Optional profile `ocr`. |
| `tika` | apache/tika | Internal. |
| `embed` | TEI CPU, `intfloat/multilingual-e5-small` | Internal. Same model, so the existing index migrates without re-embedding. |
| `onlyoffice` | onlyoffice/documentserver:9.4.0.1 | Profile `office`. WOPI enabled, own proof keys, private IPs allowed. See §8. |
| `sftpgo` | drakkan/sftpgo | **Not in the main compose file.** A separate `compose.sftpgo.yaml` exists for people starting from nothing, used with `-f`. |

On your Unraid: same rsync and compose.manager flow as filesai, project name `fdrive`, appdata at
`/mnt/cache/appdata/fdrive`. The existing pgdata cannot be reused as-is because of the `root_id`
migration and schema split; the first start runs a one-shot import that copies `files` and
`chunks` from the old filesai database so nothing is re-extracted or re-embedded.

---

## 13. Phases

Each phase ends green in CI with its gates and is deployable on its own. Sizes are relative.

**Phase 0 — Foundation (S)**
Monorepo, packages, CI with coverage gates, Biome, Drizzle migrations, compose skeleton, SFTPGo
test container with seeded users (one with virtual folders, one with restricted permissions), TEI
and Postgres testcontainers. `packages/sftpgo` client and fake with contract tests proving the
fake matches the real container for every endpoint we use.
Done when: an empty API and web boot in compose; the SFTPGo client passes contract tests against
both fake and container.

**Phase 1 — Browse and transfer (L)**
Login, encrypted credential store, token re-minting, sessions, sidebar folder tree, list, download with Range, zip, upload queue with drop and
folder drop, mkdir, rename, move, copy, delete, previews for image/video/audio/PDF/text/markdown,
list and grid views, virtualization, keyboard navigation, context menus, SSE for our own
mutations, in-place editing of text, code, and markdown files, duplicate, compress, and extract as
jobs with progress. About page with SFTPGo attribution.
Done when: daily use no longer needs Filestash; Playwright covers every action; perf budgets for
list and download measured.

**Phase 2 — Index and search (M)**
Indexer moved in, multi-root, thumbnails, events, internal HTTP; migrations own the schema;
one-shot import from the filesai DB; search service in core with scoping; the sectioned search
panel with thumbnails (§9); the System sidebar section with settings and stats pages for the
indexer, embeddings, OCR, and thumbnails (§9); duplicates and similar-files panels; MCP in
TypeScript with per-account tokens; Raycast repointed. filesai stack retired on the box.
Done when: search results match the old MCP for the same queries; a second SFTPGo user only ever
sees their own scope in every index-backed endpoint (tested).

**Phase 3 — Metadata (M)**
Tags, favorites, recents, details pane, tag filters, rename tracking through all three sources,
sha256 relink fallback, optional SFTPGo webhook receiver.
Done when: a folder renamed over SFTP keeps its tags within seconds; tested with the real
container.

**Phase 4 — ONLYOFFICE (M)**
WOPI host: discovery client, proof-key verification, CheckFileInfo, GetFile, PutFile, Lock family,
PutRelativeFile, RenameFile; lock table; editor route with host page; new document; convert-and-edit
for legacy formats; SSE event on save; product profiles for ONLYOFFICE and Collabora.
Done when: open, edit, save, and reopen a docx/xlsx/pptx as two users in one session; a read-only
user can open a locked file; save-as and rename from inside the editor land in SFTPGo; an external
edit over SFTP invalidates the editor cache on next open; the same host passes a Collabora smoke test.

**Phase 5 — Accounts and polish (M)**
Link multiple identities, identity switcher, cross-identity favorites and search, shares through
SFTPGo's share API with fdrive's own public pages proxied through the app (§6.1), API token
management, zero-copy download path if the budget demands it, perf budgets become blocking.

**Phase 6 — Recovery and extensions (scheduled 2026-09-07)**
Trash, snapshot versions, similar-image comparison/dedupe, admin settings UI for index rules,
and a WebDAV storage provider. Scheduled by the latest all-phases instruction; architectural
contract and sequencing: `docs/workflow/P6-DESIGN.md`. Configurable embeddings remain deferred.
Done when: owned recovery/restore, image comparison, rules and second-provider browse/transfer
flows pass real storage integration, browser acceptance and required quality gates.

---

## 14. Decisions taken in this plan

1. SFTPGo stays external and untouched; fdrive never reads its database.
2. Indexer remains Python; everything user-facing is TypeScript.
3. Separate Hono API next to Next.js, one origin via Caddy.
4. One Postgres for fdrive with `app` and `idx` schemas, migrations owned by the TS `db` package.
5. Metadata keyed by identity + virtual path, with layered rename tracking.
6. Scope enforcement lives in core and is mandatory on every index query.
7. Credential mode only: encrypted SFTPGo password at rest, JWT re-minted as needed. No SFTPGo
   admin access, no API keys.
8. AGPL-3.0 licence file and a "Built on SFTPGo" attribution; nothing more, personal project.
9. Czkawka and Filestash leave the stack; OCR stays.
10. SFTPGo is never in the default compose file; an opt-in `compose.sftpgo.yaml` exists.
11. Office thumbnails are icons in v1.
12. Public share pages are fdrive's own, and all share traffic is proxied through fdrive because
    SFTPGo may not be internet-facing.
13. Same index and OCR policy for every SFTPGo home (2026-09-07): the indexer and OCR see the
    whole SFTPGo root; per-user isolation comes from scope verification, not from narrowing
    what is indexed. The indexer runs as SFTPGo's uid so mode-700 folders stay indexable.
14. No ellipsis on action labels (2026-09-07): menu items, buttons, tooltips and dialog titles
    read "Compress", "Restore to", "Manage tags"; the user reads "…" as truncation. Only
    progress text ("Saving…", "Loading…") keeps it.
15. Authentication stays with the storage provider (2026-09-07): fdrive forwards SFTPGo's own
    login, including its one-time code, and never builds its own credential, second factor or
    session-extension scheme. Provider limits such as TOTP-for-HTTP re-login are documented,
    not worked around.
16. Image search by content (2026-09-07): a CLIP-family sidecar embeds the thumbnails the indexer
    already generates, and the same vector space embeds the typed query, so "blue chair" finds the
    picture. The model is `google/siglip2-large-patch16-256` (1024-dimensional, multilingual),
    chosen by the user for quality over speed; the one-off backfill cost is accepted. The sidecar
    is optional, in the `index` compose profile, and a deployment without it reports image search
    as not configured rather than failing. Public share thumbnails (2026-09-07) come from the same
    index cache and never consume a share's download budget, because they never pass through
    SFTPGo's share download.

17. Agent workflow (2026-09-08): keep shared rules and model selection in `WORKING.md`;
    repeatable recipes in `docs/workflow/COMMANDS.md`, backed by tested shell helpers in
    `tools/orchestration/`. Helpers select Node 24 and pinned pnpm, prepare isolated checkouts,
    and run named verification profiles under per-checkout locks. Implementation lessons live in
    `docs/workflow/PITFALLS.md`. Codex orchestrates; all new implementation/test workers run
    through `tools/orchestration/worker.sh` and headless `agy`, pinned to Gemini 3.8 Flash
    (`gemini-3.8-flash-high`) and high reasoning. No native GPT worker fallback. Reuse role instructions from
    `.codex/agents/`, ignoring native model fields. Preserve existing workers until finished.
    Process success requires independent diff/test review before integration. Worktree permissions
    are configured through explicit `worker.sh setup`; start/followup register the checkout with
    `--add-dir` and never change global settings. Preserve existing ask/deny rules and use scoped
    locked-helper command grants.

## 15. Resolved questions (2026-09-06)

1. Auth: credential mode only, no admin-assisted API keys.
2. Licence: does not matter for this personal project; AGPL-3.0 file plus attribution.
3. SFTPGo is not in the default compose file.
4. Office thumbnails skipped in v1.
5. Share pages are fdrive's own and proxied through the app.

## 16. Risks

- Passwords at rest. Mitigated by envelope encryption with a master key kept out of the DB, and
  by documenting that a dedicated SFTPGo user per person is the intended setup.
- Wrong home template leaking another user's index rows. Mitigated by the login-time scope check
  in §4.3 and by scope tests on every index query.
- No resumable uploads. Mitigated by per-file retry; large single files over flaky links remain a
  weak spot until SFTPGo grows chunked upload or we add a server-side assembly endpoint.
- Unpaginated listings on very large folders. Mitigated by server cache and virtualization;
  a 100k-entry folder will still be slow at SFTPGo's end.
- Two languages in one repo. Mitigated by the schema living in one place and contract tests.
- ONLYOFFICE's WOPI is younger than its native API; oCIS's issue history (private-IP fetch
  failures, lock dialogs on read-only, viewers not seeing live edits) is the expected sharp edges.
  Mitigated by product profiles and the nightly end-to-end run against a real Document Server.
- ONLYOFFICE Community has no mobile editing over WOPI, only mobile view.
