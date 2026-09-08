# Bundled ONLYOFFICE onboarding

User explicitly chose bundling ONLYOFFICE in the default stack and enabling through
onboarding. Repository/local fixtures only; never access the owner's deployment.

## Interfaces and behavior

- Six processing choices, Trash, ONLYOFFICE, review. Office index 7, review index 8,
  total 12 steps. Persist progress; skip/off completes normally. Keep all settings
  available in System > Features. Do not add Office to the six processing flags.
- Contracts: `OfficeSettings` / `OfficeSettingsUpdateRequest`:
  `{ revision: nonnegative integer, enabled: boolean, appUrl: string|null,
  editingEnabled: boolean, editingProviderId: UUID|null, editorUsernames: string[] }`. `appUrl` is an HTTP(S) origin with no credentials,
  query, fragment or path (except `/`, normalize it away); required when enabled.
  Defaults off, null URL, editing false, null editing provider, no editor usernames.
  Editing requires a provider-bound explicit username allowlist: admitting arbitrary readers
  to shared editor sessions can bypass their own upload restrictions via another writer.
  PUT rejects enabled editing for a different active provider. Recheck allowlist and enabled
  state on callbacks; injected/test admission and existing explicit edit rules may narrow it.
- `SystemOfficeResponse`: `{ configuration: OfficeSettings,
  product: 'onlyoffice'|'collabora', activeProviderId: UUID|null, status: 'off'|'starting'|'ready'|'unavailable' }`.
  Admin GET/PUT `/api/v1/system/office`, revision CAS; client `systemOffice()` /
  `systemUpdateOffice(input)`. Persist using existing settings table; no migration
  or environment activation fallback. Infrastructure endpoint overrides may remain
  for existing alternate-provider/dev deployments; enabling is always a UI setting.
- Worker-authenticated GET `/api/v1/internal/office`: `{ version: 1, revision,
  enabled }`. Use existing x-fdrive-worker-token secret. `enabled` true only when
  persisted setting enabled and configured product is ONLYOFFICE. No user credentials.
- Standard stack bundles pinned Document Server, no profile/overlay selection.
  Small controller stays healthy while off; starts/stops the editor on authenticated
  desired state. No Docker socket. Verify actual daemon shutdown, not just shell PID.
  Reuse persisted proof keys; generate/persist JWT secret automatically. Fixed proxy
  `/onlyoffice` on the fdrive origin avoids browser CSP rebuild/user env edits.
- Backend resolves current Office settings and discovery coherently per operation;
  defaults server URL http://onlyoffice, callback URL http://api:3001/wopi, browser
  URL appUrl + /onlyoffice. Preserve proof verification, identity/provider binding,
  scope mapping, locks, limits, session checks, and write admission. Disabling prevents
  new opens; UI warns to close documents before disabling. Editing permission changes
  must apply to callbacks, not only future browser opens.
- UI pre-fills appUrl from browser origin, lets owner correct it, exposes separate
  editing permission, and reports readiness without blocking setup while starting.
  Explain documents stay in SFTPGo and no processing storage mount is required.

## Ownership

- Backend worker: apps/api/**, packages/contracts/**. Parent owns frontend/docs and
  integration transfer. Coordinate any out-of-scope fixture adjustments.
- Deployment worker: deploy/** (except README.md/REFERENCE.md), services/runtime/**,
  tools/deploy/**. Parent handles docs. Worker may add Office-specific controller/tests
  under deploy/office if that is safer than adapting the generic subprocess controller.
- Parent: apps/web/**, docs/**, PLAN.md, README.md, shared spec, remaining test fixtures.

## Verification

Focused checks first. Parent coordinates heavy Docker checks (one at a time), then
application/integration/browser/workflow gates and a real editor path. Deployment must
prove off -> startup/discovery -> off without leftover editor daemons using local fixtures.
Mocked readiness is not proof of successful document editing. Preserve Collabora support.
