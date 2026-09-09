# P8 virtual folder index support (requested 2026-09-09)

Make SFTPGo virtual folders work with index-backed features (search, thumbnails, duplicates,
folder sizes, MCP), and stop an unmapped one from disabling those features for the whole
identity. Browsing already works and is out of scope. fdrive still performs no SFTPGo
administration: mappings are entered by an fdrive administrator, never discovered through
SFTPGo's admin API.

## Problem

A virtual folder mount is not a real directory on disk in the user's home (SFTPGo's design;
modelled in `packages/sftpgo/src/fake/server.ts:232`). `verifyMountDirectory` requires every
SFTP-visible entry to appear in the indexer's listing of the same physical directory, so an
unmapped mount reads as "SFTP entry missing from the index" and fails as `mismatch`
(`apps/api/src/scoping/directory-verify.test.ts:84`).

`verifyCandidates` records one failure across all candidate scopes
(`apps/api/src/scoping/resolver.ts`), so that single failure makes `verifiedIndexScopes`
unavailable, and every index-backed consumer is gated on it. Net effect: **one unmapped
virtual folder silently disables search across the identity's entire home**, and the status
reports only a bare `mismatch` with no indication of which entry caused it.

The dev seed already has this shape — `carol` has `/shared` -> `/srv/sftpgo/data/_folders/shared`
(`deploy/dev/sftpgo-seed.json`) and no stored override.

## Already working; do not rebuild

- Shadowing is handled: every index/event-derived path goes through `roundTripVirtualPath`
  (search, image search, MCP, events, office). No consumer uses a plain `toVirtualPath`.
- A shared folder inside an index root is indexed once and mapped per identity; no duplication.
- Per-user permission differences on a shared folder resolve at result time through
  `apps/api/src/scoping/read-authorizer.ts`, not at index time.
- `PUT /api/v1/account/identities/:id/scope` already validates and stores overrides
  (`apps/api/src/scoping/routes.ts`, admin + cookie + CSRF).

## Step 0 — reproduce before changing anything

On the dev stack, sign in as `carol` and confirm search/thumbnails are unavailable with reason
`mismatch`, and that `alice` (no virtual folder) is unaffected. Record the evidence in STATUS.
If carol's search is in fact available, stop and re-derive the analysis before proceeding.

## Design decisions

**Unmapped mounts keep failing closed.** Do not auto-exclude SFTP-visible names that are absent
from disk. That direction is the load-bearing signal for a wrong mapping (a mapping pointing at
another user's directory also shows as "my files are not on disk there"); the opposite direction
is already tolerated as hidden-file filtering. The fix is precise reporting plus a way to enter
the mapping, not a looser check.

**An unindexed escape hatch is required.** An administrator may have a virtual folder whose
physical location is outside every index root. Without an escape hatch that identity can never
satisfy verification and loses search permanently. Add per-identity `unindexedPrefixes`: virtual
prefixes the administrator has explicitly acknowledged as present-but-not-indexed. They feed
`shadowedChildNames` exclusions and nothing else — they grant no read access, map to no root,
and never become candidate scopes.

**Degrade per scope.** One failing override must not take down the home scope.

## Contract (agree before parallel work; owned by VF-1, consumed by VF-2)

In `packages/contracts/src/scopes.ts`:

- `IdentityScopeReason` gains `"unmapped_mount"`, reported in preference to `"mismatch"` when
  every offending entry is a mount candidate.
- `IdentityScopeStatusShape` gains, visible to both roles (these are virtual paths; the existing
  redaction rule hides physical prefixes only):
  - `unmappedMounts`, up to 64 entries of
    `z.strictObject({ virtualPath: ScopeCanonicalPath, kind: z.enum(["file", "dir"]) })`
  - `unverifiedPrefixes: z.array(z.string()).max(MAX_SCOPE_MAPPINGS)` — virtual prefixes dropped
    from the verified set while others survived.
- `SetIdentityScopeRequest` gains an optional
  `unindexedPrefixes: z.array(ScopeCanonicalPath).max(MAX_SCOPE_MAPPINGS)`, defaulting to
  `[]`; values must be unique and must not collide with any
  `scopes[].virtualPrefix`.

Store `unindexedPrefixes` in the same `identity_scope:<identityId>` override record; bump its
stored `version` and keep reading version 1 records as `unindexedPrefixes: []`. Include it in
`buildVerificationCacheKey` so a change invalidates verification immediately.

## VF-1 — API and scoping

Owns `apps/api/src/scoping/**`, `packages/contracts/src/scopes.ts`, `apps/api/src/search/scopes.ts`.

- `verifyMountDirectory` returns the offending entries rather than a bare reason: distinguish
  `missing` (SFTP-visible, absent from the index listing — a mount candidate) from `kind_mismatch`
  (present with a different kind — a genuine inconsistency). Keep both failing.
- `verifyCandidates` verifies each candidate independently. Survivors are returned as the
  verified scope set; failures are reported per scope. `available: true` when at least one scope
  survives; `available: false` with the most severe reason when none do. Severity order:
  `indexer_unreachable` > `overflow` > `mismatch` > `unmapped_mount`.
- `shadowedChildNames` additionally excludes names claimed by the identity's `unindexedPrefixes`.
- `status` reports `unmappedMounts` (virtual paths, built from the failing entries' names joined
  onto the scope's `virtualPrefix`) and `unverifiedPrefixes`.
- Delete `usableScopesFor` from `apps/api/src/search/scopes.ts` and its tests: it builds scopes
  with no overrides, is unreferenced in production, and would silently drop virtual folders for
  whoever picks it up next. Keep `dateFromMtimeNs` and `toIndexRelativePath`.
- Tests: pure functions at the existing gate; resolver tests for one unmapped mount (home scope
  unverified, reason `unmapped_mount`, mount named), for a mapped mount (home verifies through
  shadow exclusion, both scopes in the verified set), for an `unindexedPrefixes` acknowledgement,
  for a failing override alongside a healthy home scope (home survives, prefix reported
  unverified), and for kind mismatch still reporting `mismatch`. Extend the real
  SFTPGo + indexer integration test with a two-identity virtual folder case.
- Checks: `application` and `integration`.

## VF-2 — Account mapping editor

Owns `apps/web/src/components/account/**` and its query module in `apps/web/src/lib/api/`.
Depends only on the contract above; may start in parallel against it.

- On the account page, an identity card shows index status for every identity, and for an
  administrator a mapping editor. Non-administrators see virtual prefixes, status, and any
  unmapped mounts — never physical prefixes or root names.
- Unmapped mounts are the entry point: list each one as a prompt ("`/shared` is not indexed"),
  with actions **Map it** (choose a configured root, enter the physical prefix) and **Not
  indexed** (adds to `unindexedPrefixes`). Do not present three blank fields as the primary path.
- Save issues the `PUT` and renders the returned status, which already reflects the change; no
  follow-up `GET`. Show the standing `warning` text verbatim next to the editor: an
  administrator-controlled mapping is an authorization boundary, not proof of identical storage.
- Validation errors from the route map to field-level messages; unknown root, shadowing
  collision, and duplicate prefix each read as their own sentence.
- Design per WORKING.md: shadcn/ui primitives, `globals.css` tokens, one-line field descriptions.
- Tests: unit tests for the candidate list, the two actions, and error mapping; a Playwright
  spec mapping a virtual folder end to end and seeing search return a file from inside it.
- Checks: `application` plus the affected `browser` tests and real dev app verification.

## VF-3 — Documentation and dev fixture

Owns `docs/**` and `tools/dev/**`. Independent of VF-1 and VF-2.

- Document the deployment constraint: a virtual folder's SFTPGo `mapped_path` must sit inside a
  configured `FDRIVE_INDEX_ROOTS` root, or it needs its own root plus an indexer mount. Dev
  satisfies this by putting folders under `_folders/` inside `/srv/sftpgo/data`; production
  deployments do not get this for free. Place it with the roots/indexer material in
  `deploy/REFERENCE.md` and link it from the account-mapping docs.
- State plainly that fdrive cannot read a folder's `mapped_path` (SFTPGo admin API only), so the
  physical prefix is always supplied by a human.
- Optional: have `tools/dev/generate-seed.ts` also store carol's override so the dev stack
  demonstrates a working mapped virtual folder. Coordinate with VF-1 on the record shape, and
  keep at least one identity with an *unmapped* mount so the broken path stays visible in dev.
- Checks: `workflow`.

## Acceptance

1. An identity with an unmapped virtual folder keeps index-backed features for every scope that
   verifies, and its status names the unmapped mount instead of reporting a bare `mismatch`.
2. An administrator can map that folder from the account page and search then returns files from
   inside it, for two identities sharing it, each filtered by their own SFTPGo permissions.
3. An administrator can mark a folder unindexed; the identity keeps search over its home.
4. A genuinely wrong mapping (kind mismatch, or a divergent-root home template) still fails
   closed and still disables index-backed features for the affected scope.
5. No consumer reads scopes without overrides; `usableScopesFor` is gone.

## Sequencing

VF-1 and VF-2 run in parallel against the pinned contract; VF-3 is independent. VF-2's Playwright
spec and acceptance items 1-3 need VF-1 integrated, so verify the integrated result in one
checkout after transfer rather than in the worker copies.
