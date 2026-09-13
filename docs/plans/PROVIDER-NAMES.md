# Friendly storage provider names

Status: planned for a later session; no implementation requested in this handoff.

## Outcome

People should recognize storage by a name such as **Home storage**, with the username beneath
it, when choosing a login or connecting FDrive for Mac. The motivating pairing screen showed
`192.168.1.105:8085` and `fredrik`, which looked like the Mac would connect to a LAN address.
The Mac actually uses the entered fdrive HTTPS server; only that server accesses the provider.

Use one administrator-managed name per provider instance, shared across its storage logins.
Naming must not change the endpoint, provider/identity IDs, credentials or access rights.
“Home storage” is an example, not an instruction to rename the production provider now.

## Existing implementation

- Provider rows already have `label`, separate from `baseUrl`. Create/update contracts support
  it, with a 1–120 character limit: `packages/contracts/src/providers.ts`.
- `apps/web/src/components/system/provider-dialog.tsx` already exposes **Name** for adding and
  editing providers. Submission trims the value and sends only changed fields. Reuse this UI
  and the existing admin update endpoint rather than adding another naming system.
- Initial setup does not collect a provider name; `apps/api/src/setup/service.ts` creates an
  empty label. `apps/api/src/providers/service.ts` falls back to the endpoint host for empty
  labels. Check environment-managed provider initialization as well.
- Web identities use `providerLabel` from `apps/api/src/auth/service.ts`; the desktop approval
  screen renders that field in `apps/web/src/app/desktop/connect/desktop-connect.tsx`.
- `apps/api/src/desktop/pairing.ts` returns the provider name as `location.displayName`.
  The Mac persists it in `SavedLocation`; `refreshLocations` in
  `apps/macos/App/FdriveApp.swift` currently discards the fresh `client.location()` response.
  Existing native locations can therefore retain an old name after a provider rename.

## Work for the next session

1. Confirm the current System provider-edit navigation and make **Name** easy to discover.
   Add concise help: “Shown when choosing storage and in Finder.” Keep the technical address
   in the administrator connection settings. Renaming an environment-managed provider should
   remain possible while its deployment-controlled address stays locked.
2. Add a provider-name field to initial setup, using the same trimming and length validation.
   Preserve compatibility with existing setup clients and unnamed providers; let administrators
   name those through the existing edit form. Preserve existing nonempty names on restart.
3. Verify rename propagation through provider pickers, linked logins, desktop approval and new
   native connections. Refresh/invalidate cached identity/provider data after saving the name.
   Keep usernames visible; duplicate display names must never merge distinct provider IDs.
4. Update saved native display metadata on refresh and rename the existing Finder domain using
   the supported macOS API. Keep the domain ID, catalog and Keychain token. Validate returned
   account/identity/provider IDs before applying metadata; never retarget a saved connection.
   Confirm the in-place rename behavior on macOS before committing to an implementation.

## Completion and verification

- A provider can be named during setup and renamed later; blank/whitespace-only and overlong
  names fail clearly. Existing unnamed providers remain usable and can be named without
  recreating their logins. Labels render as plain text.
- Rename to “Home storage”: web login selection and Mac approval show that name plus the
  username; an already connected Mac/Finder location updates on refresh without reconnecting
  or losing cached files. Offline refresh retains the last known name.
- A label-only update leaves endpoint, identity binding, token grants and other providers
  unchanged. Ordinary users cannot rename providers through the admin endpoint.
- Follow `WORKING.md`: local `application`, `integration`, affected browser tests plus real
  web UI verification; `verify-macos.sh` and a signed Finder rename check for native changes;
  `workflow` for docs/tools. Add focused regressions for rename propagation and isolation.
- GitHub Actions remains disabled for cost control. Do not enable it or alter the live provider
  as part of implementing this plan. A server deployment and local app rebuild will be needed
  to exercise the completed change together.

Start from current repository state and read [WORKING](../../WORKING.md),
[architecture](../ARCHITECTURE.md), [provider guide](../STORAGE-PROVIDERS.md),
[Mac guide](../MACOS.md) and [STATUS](../workflow/STATUS.md).
