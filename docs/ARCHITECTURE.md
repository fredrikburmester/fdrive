# Architecture

Current implementation reference. Unfinished work belongs in [plans](plans/README.md).

## Boundaries

- Caddy serves one browser origin: Next.js UI, Hono API, MCP and optional Office integration.
  Deployment and network configuration live in [deploy](../deploy/README.md).
- `packages/core` defines storage/repository ports and shared domain operations. Provider
  adapters perform upstream I/O; `apps/api` constructs them and handles authentication,
  authorization, HTTP, events and jobs. The UI uses the typed contracts client.
- `packages/db` owns Drizzle migrations for PostgreSQL's `app` metadata and `idx` index
  schemas. Python services consume those schemas; they do not independently migrate them.
- The Python indexer scans mounted roots, extracts content and builds thumbnails/embeddings.
  OCR may write to mounted originals. Browser file operations use provider credentials.
  See [indexer](INDEXER.md), [OCR](OCR.md) and [search](SEARCH-AND-AI.md).
- Optional AI organize calls Claude or an OpenAI-compatible server from the API with read-only
  tools and returns suggestions the person applies through `fs/move-many`. See [AI](AI.md).
- fdrive is an SFTPGo client first. SFTPGo, WebDAV and S3 storage adapters ship, and every
  login carries capability flags (`ProviderCapabilities`) that decide what the UI offers and
  the API accepts; nothing keys on a type name. Search, thumbnails, folder sizes, shares and
  Office are built on SFTPGo today: only its files sit on a disk the indexer reads, and only
  it has native share links. WebDAV and S3 get ordinary file management plus what fdrive
  performs itself (Trash), and the UI names the features each lacks where a storage is added
  or picked. A feature reaches another backend by flipping its flag once its API and UI paths
  work there, so the split is the current state, not a rule. SFTPGo stays independently
  administered; fdrive does not need WebAdmin access, read its database or modify it.

## Accounts and storage

The optional [native macOS companion](MACOS.md) exposes File Provider domains, read-only by
default with explicitly granted writes on qualified storage. Each domain binds one
server/account/storage identity. Its versioned desktop API uses separate identity-bound
credentials; browser identity selection and MCP tokens cannot retarget these domains.

A provider row identifies a configured backend instance; an identity is a login on that row;
an account links identities. Sessions select an active identity. Credentials are encrypted
and bound to their identity and provider, including during retries and background jobs.
See [authentication](AUTH.md) and [adding providers](STORAGE-PROVIDERS.md).

Metadata uses identity plus canonical virtual path. Application moves and indexer events
propagate renames; index paths must be translated through the identity's scopes. A path
or content hash alone never grants another identity access. Provider-backed public shares
are proxied by fdrive; only a module whose share strategy is `native` (SFTPGo) has them
today. For a native share the upstream public share API remains the authority for file
access; never fall back to the owner's file credentials when public access fails. For an
owned share (a module whose strategy is `owned`) the owner's stored credential is the only
way to the bytes, so the share reaches storage only through the identity storage factory,
only inside its paths, and only for the operations its scope allows. Protected share metadata must not leak before authentication.
Share passwords are never stored in clear: a native row holds nothing (SFTPGo keeps the
password), an owned row holds only a hash in `password_hash`, which no share record
projection returns; the public credential-cookie flow has separate protections. See the API's [share implementation](../apps/api/src/shares/).

Linking an already-owned identity transfers that login and its metadata, not the source
account's administrator rights or API tokens. Re-authentication and session revocation
rules in the authentication guide supersede the original account-linking briefs.

## Index authorization

Use [scoping](SCOPING.md) when touching search, thumbnails, metadata events, Office paths
or MCP. Trusted configuration, directory consistency checks and live read authorization
are separate requirements. Never substitute a guessed username/home template for verified
index scopes. Providers without a supported local mapping retain ordinary provider operations,
including explicitly scoped [MCP file tools](MCP.md).

## Office and recovery

Office uses durable file UUIDs, session-bound tokens, callback verification and explicit
edit admission. See [Office implementation](OFFICE-DEVELOPMENT.md) and [setup](OFFICE.md).
Trash is a provider capability, not application-owned snapshot history. Current integration
and provider-specific limits are described in [Trash](TRASH.md) and the provider guide.

## UI and runtime decisions

- Feature activation is persisted through onboarding/System settings. Optional processing
  begins disabled; runtime controllers expose starting, ready and failed states.
- System pages are installation-wide and independent of the active login; Storage is the one
  page with per-server settings (each provider row carries its own Trash), and every page header
  states its scope.
- The admin sidebar shows live processing activity and percentages only for fixed workloads.
  Lightweight worker snapshots and one shared poll drive it; see [System activity](SYSTEM-ACTIVITY.md).
- Search combines text/filename and available visual results, with separate failure states.
  Image similarity by perceptual hash is not the shipped text-to-image search feature.
- Folder view mode and sort are pinned per identity/path in `app.folder_views`, with no
  inheritance and independently of each other (`mode` is null for a sort-only pin; a pin with
  neither part is deleted). `fdrive.view` and `fdrive.sort` remain the browser defaults.
  Virtual listings use those defaults; moves/deletes update pins.
- Browser preferences live under `fdrive.*` localStorage keys, are read through
  `useSyncExternalStore` hooks so every mounted consumer and other tabs update together, and
  are set on the Account page or in the View menu: row click (`fdrive.list.rowClick`: select,
  toggle selection, highlight or open; highlight moves the focus ring and range anchor without
  changing the selection; modified clicks, Enter and double-click keep their meaning), list
  density (`fdrive.list.density`), size units (`fdrive.format.sizes`), date style
  (`fdrive.format.dates`) and clock (`fdrive.format.clock`). Components render sizes and dates
  through `useFormatters`, never the bare formatters, so a preference applies everywhere.
- Use the existing UI tokens and components. Action labels omit ellipses; progress labels
  may use them. Keep transient failures from deleting persisted preferences.
- HEIC/HEIF files are stored as uploaded. The web client decodes them natively where the
  browser can (`<picture><source type="image/heic">`), shows the indexer's 1024px WebP
  thumbnail elsewhere, and decodes the full file in the browser on zoom or when no thumbnail
  exists (`heic-to/csp`, a wasm2js build that needs no CSP `eval` allowance), refusing files
  over 50 MiB before they are downloaded. A failed decode keeps the thumbnail on screen.
- Camera raw files (Sony ARW, Canon CR2/CR3, Nikon NEF, DNG and other LibRaw formats) are
  thumbnail-only. The indexer reads the JPEG preview the camera embeds through `rawpy`
  (LibRaw), developing the sensor data at half size only when no preview covers 1024px, and
  writes the usual WebP sizes. Raw extensions are `RAW_EXTS` in the indexer and
  `RAW_IMAGE_EXTENSIONS` in `@fdrive/contracts`; they never enter text extraction or OCR. No
  browser decodes raw, so grids, the inspector, the viewer and public galleries show the
  thumbnail and offer the original as a download; the file itself is never fetched to render.

## Verification

[AGENTS.md](../AGENTS.md) lists the required checks. Executable coverage
thresholds and CI configuration are authoritative; do not copy historic phase targets.
[Performance](PERF.md) describes the blocking harness and budgets.

## Interface names and persistence

Public share `usedDownloads` is the provider's consumed transfer-token count for a native
share and fdrive's own counter for an owned one; `app.shares.views` is the legacy column
name for both. Write shares count uploads;
read shares count downloads and full-size previews. Thumbnail views do not consume
that budget. Names remain compatible with existing clients and stored data.

A `TrashEntry.id` is an opaque provider entry identifier; the recycle-folder adapter
uses its path relative to the trash root. Public System logs merge internal
`SystemEvent` rows with worker history. Share permission `scope` and index path
scopes are separate typed concepts.

WOPI locks accept opaque text file IDs and have a 30-minute TTL. The Office routes
resolve and authorize a durable Office file before accessing its lock; the generic
lock repository therefore has no UUID foreign key. Lock reads/writes prune up to
100 expired rows using the expiry index and skip rows another transaction holds.
The five migration-created search indexes are also declared in Drizzle so schema
comparison preserves them; migration 0005 registers existing indexes idempotently.
