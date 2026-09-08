# UI-managed setup and optional features

Status: implemented and verified in the working tree, 2026-09-08. Owner: primary agent.
User selected bundled workers with inactive models/processing until enabled.

## Goal

A server owner starts fdrive with minimal deployment configuration, opens a resumable
walkthrough, connects SFTPGo, verifies access, and chooses optional features. Every choice
remains editable under System. Enabling supported features requires no Compose edits or
environment changes after initial deployment.

## Baseline before this implementation

- `apps/web/src/components/system/setup-wizard.tsx` provides token, connection, home
  template, and account steps. Setup is considered complete when a connection exists.
- `apps/api/src/setup/service.ts` persists the connection before testing account login.
  Failed login can therefore leave setup considered complete without its intended owner.
- Connection settings persist in `app.settings`; `SFTPGO_URL` currently locks the URL.
- Indexer/OCR settings partially support runtime updates, but service addresses, roots,
  and some processing policies come from environment configuration.
- `deploy/compose.yaml` puts processing services in the `index` profile. Image embeddings
  load on startup; TEI starts with its model. Removing profiles alone would activate work
  and consume model resources before the owner chooses features.

## Walkthrough

1. **Claim this server.** One-time bootstrap token; explain where to obtain it. Persist
   setup progress independently of provider existence. No public user list or diagnostics.
2. **Connect SFTPGo.** URL, server-side reachability and API checks, clear DNS/TLS/auth
   diagnostics. Test candidate configuration without replacing the active provider.
3. **Choose the owner and inspect users.** Authenticate a normal SFTPGo user, including
   its existing OTP flow, to establish the fdrive owner. Optional SFTPGo administrative
   credentials enable a paginated, read-only user inventory. Explain that SFTPGo admin
   and file-user accounts differ. Without administrative access, show the verified user
   and explain the inventory limitation; do not imply all users were discovered.
4. **Verify storage.** Show browsing access separately from local indexing access. Map
   SFTPGo paths to approved mounted roots, validate permissions and scope correspondence,
   and show which features each root supports. Remote/unmounted storage can still browse.
5. **Choose features.** Present one step/card per feature, with Enable/Skip, dependencies,
   expected processing/storage cost, and a short description. Allow skipping all extras.
6. **Review and finish.** Show selected features and unresolved prerequisites. Finish into
   the file browser while selected background preparation continues. Provide progress,
   retry, and a link to System > Features. Optional failures never prevent browsing.

Returning installations get an administrator-only walkthrough entry; existing users are
not redirected through fresh-install claiming. System uses the same configuration API.

## Features and dependencies

| Feature | Behavior | Requires |
| --- | --- | --- |
| Thumbnails | Image/PDF previews | Verified local roots for current indexed cache |
| Full-text search | Extract and index document text | Verified roots, extraction worker |
| Searchable OCR | Extract text from scans without rewriting source files | Text indexing, OCR extraction support |
| Semantic search | Search by meaning | Text indexing, text embedding model |
| Image search | Search images by description | Thumbnail generation, image embedding model |
| Searchable PDF conversion | Scheduled OCR that writes PDF text layers | Explicit opt-in, writable approved roots, original retention |

Proposed defaults: offer thumbnails and full-text search as recommended; require an explicit
selection before any processing. AI and PDF conversion start off. Show dependency changes
before applying them. Turning off thumbnail presentation must not silently break an enabled
image-search pipeline; distinguish its internal preview generation dependency.

Retain the existing text and image models initially. Arbitrary model/dimension changes need
versioned indexes and controlled re-embedding and are outside this walkthrough's first release.

## Deployment decision

Selected: ship a fixed stack containing lightweight service controllers. Disabled
processors do no scans, OCR, embedding, or model downloads. Controllers start/stop their
own processing subprocesses when persisted desired state changes; fdrive needs no Docker
socket. Containers/images still occupy disk and controllers have a measurable idle cost.

This requires lifecycle work for TEI, Tika, image embedding, indexer, and OCR; merely hiding
UI controls or removing Compose profiles does not meet the goal. Separate liveness from
feature readiness so intentionally disabled workers remain healthy. Models load lazily,
cache persistently, and release processing resources on disable. Verify supported CPU
architectures, including the existing ARM deployment alternative.

Not selected: provision optional containers through a privileged deployment component. This
can avoid installing unused images but adds a host-control interface and operational scope.
Keep this as a separate architecture choice, not an implicit Docker socket mount.

Keep deployment-only configuration to persistent storage, host mounts/UID permissions,
network/port/TLS topology, and bootstrap secrets. Internal URLs and standard paths belong
to shipped defaults. Generate secrets once into persistent protected storage or support
secret-file inputs; never regenerate encryption keys on restart. Ship a short quick-start
environment example and a separate advanced reference.

The UI may select subdirectories within already mounted roots; it cannot expose arbitrary
host directories to a running container. Adding a new mount or GPU remains a deployment
operation and must be explained honestly. Fresh installs without local storage must boot.

## Configuration and lifecycle contract

- Store versioned desired settings, setup progress, and feature selections in the database.
  Track observed state separately: off, preparing, ready, blocked, failed, stopping.
- Centralize validation, defaults, dependencies, revision control, and secret redaction.
  API, workers, search admission, and System pages consume the same effective settings.
- Workers acknowledge revisions and reconcile after restart. Bound retries and surface
  actionable errors; a saved setting is not proof a service is ready.
- Disable rejects new feature work immediately, drains/cancels at a safe file boundary,
  and preserves existing cache/index data. Data deletion remains a separate explicit action.
- Re-enable resumes missing/stale work without duplicating jobs or rebuilding everything.
- Do not start any source-writing OCR job until explicitly selected; retain originals by
  default and explain its storage cost separately from read-only searchable OCR.
- Migrate existing installations without changing enabled behavior. Preserve current
  environment overrides initially and label them as deployment-managed; offer an explicit
  migration path to database ownership. Fresh-install examples contain no feature overrides.

## Ownership, connection, and discovery boundaries

- Make bootstrap claim and owner assignment concurrency-safe. A failed login or restart
  leaves setup resumable; two requests cannot both claim the server. Invalidate bootstrap
  access after owner establishment; remaining steps require that administrator's session.
- Credential validation uses the candidate provider without persisting it prematurely.
  Finalize provider binding/owner state together, or use an explicit recoverable pending
  state when external authentication cannot share the database transaction.
- Normal file access continues to use each user's credentials and live scope authorization.
  Optional directory discovery never grants file access or imports user credentials.
- Administrative inventory is an explicit narrow exception to PLAN's current prohibition
  on SFTPGo admin access. Use only read endpoints and version-appropriate permissions;
  display only username/status and necessary mapping information, never raw user payloads.
  Keep secrets server-side, redact logs/responses, and discard discovery credentials after
  setup by default. Persist only if the owner elects ongoing discovery, encrypted at rest.
- User creation, password changes, quotas, and rules stay in SFTPGo WebAdmin.
- Provider replacement must preserve immutable provider/identity isolation: never forward
  old passwords, cached tokens, queued jobs, or indexed scopes to a new server URL.
- Probes are authenticated, rate-limited, bounded, and restrict redirects/credential
  forwarding. Private SFTPGo addresses are legitimate; prohibit unintended metadata access.

## Delivery slices and acceptance

1. **Configuration foundation and resumable ownership.** Versioned settings/capabilities,
   migration rules, race-safe claim, retry after failed account verification.
2. **Worker lifecycle and deployment.** Actual enable/disable for every supported feature,
   lazy models, dependency reconciliation, minimal fresh-install Compose/env defaults.
3. **Connection and storage diagnostics.** Candidate validation, optional read-only user
   discovery, verified roots, actionable missing-mount/access guidance.
4. **Walkthrough and System UI.** Resumable steps, dependency choices, live progress,
   edit-after-setup, upgrade entry, accessible desktop/mobile flow.
5. **Integrated verification.** Fresh install, upgrade, restart mid-setup, concurrent claim,
   failed login, unavailable SFTPGo, denied admin inventory, missing/read-only roots,
   model failure/retry, disable during jobs, re-enable, and cross-provider isolation.

Required gates: workflow; application; integration; Python for affected services; affected
Playwright flows and a real dev-app smoke. Verify the production Compose boot path, model
loading only after selection, and no worker activity while disabled. No live owner SFTPGo
connection is needed for implementation; use isolated fixtures.

## External references

- [Docker Compose profiles](https://docs.docker.com/compose/how-tos/profiles/): deployment
  service selection, distinct from runtime feature configuration.
- [SFTPGo REST API](https://docs.sftpgo.com/enterprise/rest-api/): separate user/admin
  authentication. Validate discovery endpoints/permissions against the deployed community
  version's pinned OpenAPI before implementing; enterprise docs are not that contract.
