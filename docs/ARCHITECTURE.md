# Architecture

Current implementation reference. Unfinished work belongs in [plans](plans/README.md);
delivery evidence belongs in [workflow history](workflow/STATUS-history.md).

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
- SFTPGo and WebDAV storage adapters ship. SFTPGo stays independently administered;
  fdrive does not need WebAdmin access or read its database. The bundled SFTPGo overlay is opt-in.

## Accounts and storage

A provider row identifies a configured backend instance; an identity is a login on that row;
an account links identities. Sessions select an active identity. Credentials are encrypted
and bound to their identity and provider, including during retries and background jobs.
See [authentication](AUTH.md) and [adding providers](STORAGE-PROVIDERS.md).

Metadata uses identity plus canonical virtual path. Application moves and indexer events
propagate renames; index paths must be translated through the identity's scopes. A path
or content hash alone never grants another identity access. Provider-backed public shares
are proxied by fdrive; current share support is SFTPGo-specific. The upstream public share
API remains the authority for file access; never fall back to the owner's file credentials
when public access fails. Protected share metadata must not leak before authentication.
Share passwords are not persisted in the share database record; the public credential-cookie
flow has separate protections. See the API's [share implementation](../apps/api/src/shares/).

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
- The admin sidebar shows live processing activity and percentages only for fixed workloads.
  Lightweight worker snapshots and one shared poll drive it; see [System activity](SYSTEM-ACTIVITY.md).
- Search combines text/filename and available visual results, with separate failure states.
  Image similarity by perceptual hash is not the shipped text-to-image search feature.
- Folder view mode is pinned per identity/path in `app.folder_views`, with no inheritance.
  `fdrive.view` remains the browser default. Virtual listings use that default; moves/deletes
  update pins. The schema reserves sort state, but per-folder sort is not exposed.
- Use the existing UI tokens and components. Action labels omit ellipses; progress labels
  may use them. Keep transient failures from deleting persisted preferences.
- HEIC/HEIF files are stored as uploaded. The web client decodes them natively where the
  browser can (`<picture><source type="image/heic">`), shows the indexer's 1024px WebP
  thumbnail elsewhere, and decodes the full file in the browser on zoom or when no thumbnail
  exists (`heic-to/csp`, a wasm2js build that needs no CSP `eval` allowance), refusing files
  over 50 MiB before they are downloaded. A failed decode keeps the thumbnail on screen.

## Verification

[WORKING.md](../WORKING.md) defines required verification profiles. Executable coverage
thresholds and CI configuration are authoritative; do not copy historic phase targets.
[Performance](PERF.md) describes the blocking harness and budgets.

## Interface names and persistence

Public share `usedDownloads` is the provider's consumed transfer-token count;
`app.shares.views` is its legacy cached column name. Write shares count uploads;
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
