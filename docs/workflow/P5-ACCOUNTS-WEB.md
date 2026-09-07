# P5-ACCOUNTS-WEB

Goal: Phase 5 account linking, switching, and account-wide favorites/search UI on existing reviewed contracts. Primary owns architecture; worker implements only, no recursive delegation or Git mutations/stash.

## Ownership

apps/web/src/components/account/**, lib/account/**; components/shell/app-sidebar.tsx and its tests; lib/api/auth-queries.ts/tests and keys.ts/tests; components/metadata/favorites-page.tsx plus new account-favorites helpers/components; components/search/** and lib/search/**; new account-focused e2e spec under apps/web/e2e and fixture changes only if explicitly requested. No API/contracts/db/deploy/office files. Reuse shadcn components; no dependencies/new primitives. Ask before expanding paths.

## Fixed behavior

- Existing Account > Identities: Link login dialog username/password/optional one-time code with field descriptions, bounded contract inputs, pending/error feedback. Password only transient component state; clear on close/success, never URL/log/storage/cache. Link endpoint returns rotated session cookie and MeResponse.
- Unlink action confirms identity by displayed username/provider. Explain files remain and login becomes separate account; last identity cannot be removed. Show server conflict/errors. Disable duplicate mutations.
- Sidebar account dropdown: identity entries username/provider, active indicator, switch action. Successful link/unlink/switch cancels in-flight queries, clears identity-sensitive cache and seeds fresh auth.me before routing /files (or deliberate target). No prior user's listing/sidebar/search remains visible; response arriving after mutation cannot reseed old cache. Existing uploads already have captured identity: inspect before deciding any store change, report gaps to primary. Do not silently retarget uploads.
- Favorites page combines accountFavorites results, shows identity label per row, collisions keyed identityId+path. Partial failure identifies unavailable login, successful rows remain. Open/reveal first switchIdentity if needed, then navigate using existing safe path helpers. Avoid downloading/thumbnails using wrong active identity. A missing single favorite is not silently removed from another identity. Existing sidebar per-active favorites can remain.
- Global Search panel offers Current login / All linked logins when >1 identity. Current remains default. All mode calls accountSearch and displays identity labels, sectioned results and partial-unavailable feedback. Identity+path keys ensure collisions. Open/reveal switches then navigates. No thumbnail request with wrong identity (use icons for account mode unless explicitly identity-qualified existing API). Recent search entries must not leak across identity/account; preserve existing behavior only when scoped correctly.
- Keep API tokens card functional; existing management already implemented, validate relevant regressions.

## Validation

Read WORKING and relevant PLAN/STATUS plus shadcn skill. Node24/pnpm10.11 paths from parent. Unit tests for mutation/cache ordering, identity-aware navigation, duplicate paths, partial unavailable, secret clearing where meaningful. Existing web coverage threshold and typecheck/lint must pass. Add browser test through real accounts when feasible; parent owns integrated full browser/container gates. Do not run Turbo concurrently with Playwright in same checkout. Report exact files, gates, limitations and read-only Git branch/root output.
