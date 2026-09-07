# P5-IDENTITY-DB

Implementer; read P5-DESIGN.md, PLAN §5, WORKING. Separate worktree assigned at
launch. Never stash, Git state changes or delegation. Other workers own office
API/web; preserve theirs. Own packages/db/src/repos/identity-links*.ts,
packages/db/src/index.ts, packages/db/vitest.config.ts,
packages/db/test/integration/identity-links*.test.ts. Existing schema suffices;
no migration/schema changes, no Repos expansion, no other package edits.

Export standalone createIdentityLinksRepo(db), IdentityLinksRepo and typed inputs/
results/errors. Credentials are already verified by upstream BEFORE this repo is
called; this repository never accepts an unverified identity ID as link proof.

Methods:
- linkVerified({accountId,providerId,username,at,sealCredential}): Promise<Identity>.
  sealCredential(identityId) synchronously returns {ciphertext:Uint8Array,keyId}.
  Determine/create identity inside transaction, call sealCredential for its actual
  UUID, store credentials and clear stale cached token, update lastLoginAt. Existing
  same-account link idempotent apart from credential refresh. New identity joins
  existing account. Foreign-account identity transfers ONLY that identity, retains
  favorites/recents/shares, remaps its used tags into target account by exact name
  (reuse target color if name exists), leaves unrelated source data untouched.
  Revoke source sessions whose activeIdentityId is transferred identity and API
  tokens scoped to it. No privileges/admin flags or API tokens migrate. Existing
  source account remains. Target account/provider must exist.
- unlink({accountId,identityId,at}): Promise<{identity:Identity,
  remainingIdentityId:string}>. Require ownership and at least one other identity.
  Create fresh account with displayName=username, isAdmin=false; transfer selected
  identity/its metadata as above; keep encrypted credential AAD valid (identity UUID
  unchanged). Revoke affected identity tokens. Source account sessions currently
  using removed identity switch to deterministic remaining identity (old account
  remains accessible); office tokens still fail because ownership changed.
- switchActive({accountId,sessionIdHash,identityId,at}): Promise<void>. Require
  nonexpired session owned by account and target identity owned by account, then
  persist activeIdentityId. Never extend expiry or alter other sessions.

Use typed error discriminants missing_account/provider/identity, forbidden,
last_identity, invalid_session; reject invalid identifiers/dates before IO. API
layer will translate, no Hono or contracts dependency. Strict UUID inputs and
bounded username matching existing auth conventions.

Atomicity: concurrent link of same provider/username cannot create duplicate
identity/accounts or partial credentials; concurrent transfer/unlink/switch must
recheck ownership under transaction locks. Consistent lock ordering avoids
deadlocks. Tag remapping is SQL-bounded; no per-file parameter list for large
identities. Failure rolls back credentials, ownership, tag remap and revocations.
No deletion of files or original source-account tag definitions.

Tests with real DB/two pools: create link, credential refresh/idempotence; foreign
transfer with tagged/favorited/recent/shared files and overlapping tag names;
unrelated source identity/session/token/tag unchanged; affected tokens revoked;
unlink creates nonadmin independent account and preserves metadata; last-identity
and foreign unlink denied; switch expired/foreign session denied; concurrent link
and transfer races; sealCredential throw rollback; thousands of file tags remap
with bounded SQL. Validate exported pure input functions under coverage; SQL IO
may follow existing integration-only exclusions. No runtime memory adapter needed.

Run DB unit coverage/typecheck/full integration/Biome changed files. Report public
interfaces first, files/gate output/gaps, branch and absolute checkout.
