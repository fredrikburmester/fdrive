# P10 chunk A1: provider registry, generic auth, port cleanup (API, db, contracts, core)

Design: [P10-STORAGE-PROVIDERS.md](P10-STORAGE-PROVIDERS.md). No new provider in this chunk.
SFTPGo becomes the first registered module and every existing behaviour stays byte-for-byte.

## Core

- `packages/core/src/ports/provider.ts`: `ProviderModule`, `Capabilities`, `ProbeResult`,
  `ProviderType` re-exported from contracts (or a string type narrowed by the registry).
- `packages/core/src/ports/storage.ts`: `zip` and `setModifiedAt` become optional; `download`
  options gain `ifRange`; new `stat(path): { kind, size, modifiedAt, contentType }` replaces the
  "statFile throws bad_request means directory" convention (`fs/routes.ts` `statEntry`,
  `auth/storage-factory.ts`, `events/indexer-listener.ts`, `fs/archive-routes.ts`,
  `archive/compress.ts`); `move`, `copy`, `upload` take `{ overwrite?: boolean }` and providers
  that cannot refuse overwrites document it via `atomicMove`/conformance options. Keep
  `statFile` as a thin wrapper during the chunk if it shortens the diff; remove at the end.
- `packages/core/src/trash/move-to-trash.ts`: `withMoveToTrash(storage, trashPath, clock)` wraps
  `deleteFile`/`deleteDir` to move into `<trashPath>/<origDir>/<name>/<nanoTimestamp>`, the layout
  `recycle-folder.ts` already parses. Used when `module.trash === "move"`. Not used for SFTPGo.

## Database

- Migration `0009_providers`: `label`, `config jsonb not null default '{}'`, `enabled boolean
  not null default true`, `managed_by_env boolean not null default false` on `app.providers`.
- Startup seed in composition: if `SFTPGO_URL` is set and no row exists, create it, pinned and
  enabled, with `FDRIVE_HOME_TEMPLATE` as its home template. Idempotent. No data migration:
  fdrive is pre-release and the old `connection.sftpgo` setting is simply ignored.
- `ProviderRepo`: `list`, `get`, `create`, `update`, `delete` (refused while identities reference
  it), `ensure` stays for the env seed.

## API

- `providers/registry.ts`: `{ sftpgo: sftpgoModule }` now; type-checked against `ProviderType`.
- `packages/sftpgo/src/module.ts`: the SFTPGo `ProviderModule`. `apps/api/src/storage/sftpgo-provider.ts`
  moves next to it. `configSchema = { homeTemplate }`, `credentialSchema = { username, password,
  otp? }`, `authenticate` = current `client.login`, `mint` = the same call, `probe` = current
  `connection/probe.ts`, capabilities all true except `atomicMove: true`, `trash: "native"`.
- Delete `connection/store.ts`, `connection/lazy-sftpgo-client.ts`, `auth/provider-client.ts`.
  `auth/token-source.ts` takes the module: cache and retry stay, `mint` is `module.mint` when
  present, otherwise `withToken` runs the call with no token. `auth/storage-factory.ts` resolves
  identity to provider row to module, builds storage with `module.createStorage`, applies
  `withMoveToTrash` when `module.trash === "move"` and trash is enabled for that provider, keeps
  the SFTPGo recycle-folder wrapper as today.
- `accounts/credentials.ts`: `verifyCredentials(providerId, credential)` validates against
  `module.credentialSchema`, calls `module.authenticate`, returns `externalUsername`; rate limiter
  keyed by provider and username as today. `auth/service.ts` `me()` reads label and type from the
  row and fills `capabilities`. `office/storage.ts` uses the factory's eager option instead of
  building its own client. `scoping/resolver.ts` reads `homeTemplate` from the SFTPGo row config
  and yields `no_roots` for any other type. `shares/service.ts` keeps requiring an SFTPGo row
  until [P10-SHARES.md](P10-SHARES.md).
- Routes: public `GET /api/v1/providers`; admin `GET/POST /admin/providers`,
  `PATCH/DELETE /admin/providers/:id`, `POST /admin/providers/:id/test` (probe with unsaved
  config); remove `/admin/connection`. Setup `POST /setup/test` and `/setup/complete` create the
  SFTPGo row. Zip, share, Office and scope routes check the identity's capabilities and return
  `ApiHttpError(400, "unsupported")` with `details.capability`.
- Events: settings-save events for provider create/update/delete.

## Contracts

`ProviderType`, `Capabilities`, `PublicProvider` with `credentialFields[] { name, label, kind:
"text" | "password" | "otp", required }`, `IdentitySummary` changes, `LoginRequest`,
`LinkIdentityRequest` (`currentCredential`), admin provider schemas, `AboutResponse.builtOn[]`,
`SystemFeaturesResponse.roots[].providerPath`, `unsupported` error code. Agree these with A2
before either starts.

## Testkit

`describeStorageProvider(factory, { capabilities, overwriteOnMove })` and the single
`MemoryStorage`. Run against memory, the SFTPGo fake (unit) and the real SFTPGo container
(integration). Existing `sftpgo-provider.test.ts` cases fold into it.

## Deployment

`SFTPGO_URL` unchanged. `deploy/README.md` and `tools/deploy/deploy-keys.ts` describe it as
"seeds and pins the SFTPGo provider". No new env keys.

## Out of scope

Web (A2), WebDAV (B), owned shares (D), any S3 code. No change to the indexer.

## Checks

`application`, `integration` (auth, provider-binding, scopes, shares, Office with the migrated
row), `package sftpgo`, `package core`, `package testkit`. Provider-binding test extended: two
provider rows of the same type, identity A never reaches row B. `workflow`.

## As implemented (2026-09-10)

- Field metadata is a plain `ProviderField[]` (`configFields`, `credentialFields`) validated by
  `validateFields` in core, not zod schemas on the module: no zod dependency for provider
  packages and the same list renders the web form. Transient fields (one-time codes) are
  stripped before sealing; the sealed credential is the full field record (`{ username,
  password }` for SFTPGo), and `sameCredential` decides whether a login replaced it.
- `StorageProvider.stat` was added and `statFile` kept; `statEntry` and the trash mkdir shim
  use `stat`. The "statFile throws bad_request for a directory" clause stays a documented
  contract rule checked by the conformance suite rather than being removed.
- `ProviderModule.mint` is optional; the SFTPGo module's storage does its own 401 retry
  through the `StorageSession`. `TokenSource.withToken` is gone; shares keep an SFTPGo-specific
  retry of their own.
- `createSftpgoModule({ clientFor })` exists so tests can share one client; production uses
  `sftpgoModule`. `ProviderServiceDeps.modules` overrides the registry for the same reason.
- `verifyCredentials` re-resolves the provider after the upstream login and refuses with
  `unauthorized` when the row was disabled meanwhile, matching the old connection-change rule.
  Re-addressing a provider that logins use is refused with `conflict`; env-managed rows refuse
  address changes and deletion.
- `AdminProvider` carries `reachable`/`checkedAt` from a probe taken when the view is built, so
  System > General keeps its reachability badge without a second request.
- Not done here: `SystemFeaturesResponse.roots[].sftpgoPath` keeps its name (index roots are
  SFTPGo-specific configuration); the two memory fakes are merged into `@fdrive/testkit` except
  for core's private copy, because core cannot depend on testkit. A `general` log subsystem
  records provider changes; no page shows it yet (A2).
