# Adding a storage provider

This guide describes the implemented provider extension points. SFTPGo, WebDAV and S3 are the
registered backends; fdrive-owned shares are not implemented. Start with a provider that
supports ordinary file operations; enable additional features only after their complete API and
UI paths work. WebDAV is the reference for a Basic-auth backend with basic file operations and
fdrive-performed Trash: see [`packages/webdav`](../packages/webdav/src/module.ts) and
[WEBDAV.md](WEBDAV.md) for its decisions and protocol mapping. S3 is the reference for a
request-signing backend over an SDK and for directories emulated on a flat key space: see
[`packages/s3`](../packages/s3/src/module.ts) and [S3.md](S3.md).

For environment setup, see [Development](DEVELOPMENT.md). Follow [AGENTS.md](../AGENTS.md)
for repository workflow and the required checks.

## Architecture and reference code

A **provider type** is a module supplied by a package. A **provider instance** is an
administrator-configured row in `app.providers`: an id, type, endpoint, label, string-valued
configuration, enabled state and environment-management flag. Several instances can use the
same type; rows are unique by `(type, baseUrl)`, not arbitrary config such as a bucket name.
An **identity** belongs to an instance and an external username; accounts link
identities rather than giving a credential access to every instance of a type.

The request path is:

1. The API resolves the identity's provider row and registered module.
2. It creates a `StorageSession` for that identity, owning credential decryption and token caching.
3. `module.createStorage(instance, session, { fetch })` returns a `StorageProvider`.
4. The storage factory applies configured Trash wrappers; file operations use that bound object.

| Contract or reference | Source |
| --- | --- |
| Module, field metadata, instance and session types | [core provider port](../packages/core/src/ports/provider.ts) |
| File operations, streams and optional methods | [core storage port](../packages/core/src/ports/storage.ts) |
| Working module and injectable client factory | [SFTPGo module](../packages/sftpgo/src/module.ts), [WebDAV module](../packages/webdav/src/module.ts), [S3 module](../packages/s3/src/module.ts) |
| Adapter and error translation | [SFTPGo storage adapter](../packages/sftpgo/src/storage-provider.ts), [WebDAV storage adapter](../packages/webdav/src/storage-provider.ts), [S3 storage adapter](../packages/s3/src/storage-provider.ts) |
| Instance resolution, config validation and capabilities | [provider service](../apps/api/src/providers/service.ts) |
| Per-request storage and Trash composition | [storage factory](../apps/api/src/auth/storage-factory.ts) |
| Credential validation and post-login binding checks | [credential verification](../apps/api/src/accounts/credentials.ts) |
| Credential decryption and token caching | [token source](../apps/api/src/auth/token-source.ts) |

### Display names

Initial setup collects **Storage name**. Administrators can rename an existing instance at
**System → Storage → Edit → Name**, including environment-managed instances whose address is
deployment-controlled. The existing `label` is shared by all logins on that provider. Names
are trimmed and must contain 1–120 characters; labels render as plain text. Equal names never
combine provider or identity IDs. Usernames remain visible beside or beneath the name.

Logins list the username first and the storage name beneath it. Provider types whose
`username` credential is an access key rather than a person's name (S3) are listed the other
way round, storage name first and key beneath, so the switcher, Logins card and unlink
confirmation never headline an opaque key ID. The web side decides this per provider type in
[`login-display.ts`](../apps/web/src/lib/identity/login-display.ts); add a new key-based
type to `KEY_LOGIN_TYPES` there.

Older setup clients may omit `label`. Unnamed instances retain their existing fallback labels
and can be named later; environment initialization preserves saved nonempty labels.
A label-only update changes no endpoint, credentials, identity binding or token grants.
It invalidates web provider/identity caches; desktop approval also refreshes identity data on
focus. New desktop connections receive the current name, and existing Mac connections update
on refresh as described in [the Mac guide](MACOS.md#display-name-refresh).

The Mac connects to the entered fdrive server. Only that server accesses the provider endpoint;
the technical address belongs in administrator connection settings.

## 1. Create a workspace package

Use `packages/provider-example` with package name `@fdrive/provider-example`, replacing
`example` with the backend name. Copy the build and test configuration pattern from
[packages/sftpgo](../packages/sftpgo/package.json), including its TypeScript configs and Vitest
unit/integration configs. Keep protocol-specific client code, adapters and fakes in this package.

Expose the module from `src/index.ts`. Match the existing conditional exports: `types` and
`development` resolve to `src/index.ts`, while `default` resolves to `dist/index.js`.
Depend on `@fdrive/core`; use `@fdrive/config` and `@fdrive/testkit` as development dependencies.
The module does not need database access, API imports, React or Zod.

Provide the existing script names: `build`, `typecheck`, `test`, `test:coverage` and
`test:integration`. Workspace discovery already includes `packages/*`. Add
`"@fdrive/provider-example": "workspace:*"` to `apps/api/package.json`, then let pnpm update
its lockfile:

```bash
pnpm install
```

Do not hand-edit the lockfile. The API Dockerfile already copies the packages directory;
verify that the new dependency builds and is included in the deployed API dependency graph.

## 2. Implement ProviderModule

Export a module with `type`, `label`, `configFields`, `credentialFields`, all eight capability
flags, a Trash strategy, a share strategy, `probe`, `authenticate` and `createStorage`.
Optional members are `indexRootName` and `mint`. There is no `attribution`, `configSchema`, `credentialSchema` or
`createShares` member: `/about` names the connected provider, not its upstream project.

This compilable wiring skeleton uses injected protocol implementations. It does not implement
an example backend: the driver must supply the three real operations before registration.

```ts
import type { ProviderModule } from "@fdrive/core";

export type ExampleDriver = Pick<
  ProviderModule,
  "probe" | "authenticate" | "createStorage"
>;

export function createExampleModule(driver: ExampleDriver): ProviderModule {
  return {
    type: "example",
    label: "Example Storage",
    configFields: [],
    credentialFields: [
      { name: "username", label: "Username", kind: "text", required: true, maxLength: 255 },
      { name: "password", label: "Password", kind: "password", required: true },
    ],
    capabilities: {
      zip: false,
      setModifiedAt: false,
      atomicMove: false,
      trash: false,
      shares: false,
      office: false,
      index: false,
      scopeMapping: false,
    },
    trash: "none",
    shares: "none",
    probe: (instance, ctx) => driver.probe(instance, ctx),
    authenticate: (instance, credential, ctx) => driver.authenticate(instance, credential, ctx),
    createStorage: (instance, session, ctx) => driver.createStorage(instance, session, ctx),
  };
}
```

Use `ctx.fetch` for network requests so tests can inject a fake. Keep the endpoint and identity
bound to the supplied `instance` and `session`; avoid shared mutable clients that switch servers
or users. Return an object with its storage methods as own properties: the existing Trash
wrappers spread that object, so prototype-only class methods would be lost.

### Configuration and form fields

The endpoint and label are already separate fields on the provider row. Do not ask users to
enter the endpoint as part of their login credential. `baseUrl` must be an HTTP(S) URL accepted
by the [contracts](../packages/contracts/src/providers.ts).

`configFields` and `credentialFields` are arrays of `ProviderField`. Supported kinds are `text`,
`password`, `otp` and `url`; optional metadata includes `help`, `maxLength` and `transient`.
All submitted values are strings. The [shared validator](../packages/core/src/provider-fields.ts)
rejects unknown keys, missing required values, NUL and excessive length (default 4096). Field
kind controls rendering; it does not implement protocol-specific validation, numeric parsing or
URL validation for arbitrary config fields.

Parse provider-specific settings at the module/client boundary and test malformed values.
There is no generic custom-config-validation callback; SFTPGo's home-template validation has an
explicit check in the provider service. If a new setting needs validation before saving, extend
that boundary deliberately rather than assuming the module can provide a schema hook.

Config is stored in provider JSON and returned to administrators, not envelope-encrypted like
credentials. Put login secrets in `credentialFields`; a password-shaped config input does not
make its value encrypted. The admin form trims config values and omits blanks; credential values
are not trimmed. Mark one-time codes `transient: true` so the API removes them before sealing.

### Authentication and refresh

- `probe(instance, ctx)` checks reachability and backend identity without a user's credential;
  return `{ ok, detail }`. Bound response sizes, network time and parsing work. The SFTPGo probe
  is a reference for bounded requests and response handling.
- `authenticate(instance, credential, ctx)` must verify credentials upstream and return a stable
  `externalUsername`, optionally with `{ token, expiresAt: Date }` for the token cache.
- Respect `ctx.expectedUsername` during link/unlink confirmation. Refuse a credential for another
  user. The API fills a missing field named `username` from this expected username; it does not
  invent other required identifier fields.
- Confirmation forms currently render only `password` and `otp` fields, with password/code copy.
  A backend requiring another identifier, an API-key-specific confirmation flow or OAuth needs
  explicit form/verification work; field metadata alone does not supply those flows.
- For Basic auth or request signing, omit `mint` and use `await session.getCredential()` when
  making authenticated requests. `session.getToken()` returns `null` without `mint`.
- For expiring tokens, implement `mint(instance, { externalUsername, credential }, ctx)` and use
  `session.getToken()`. The API caches tokens, but storage retry is the adapter's responsibility:
  SFTPGo invalidates and retries once on unauthorized. Avoid unlimited retries and unsafe replay
  of consumed upload streams. Refresh must work without a stored transient one-time code.

Translate protocol errors to `StorageError` from core. Authentication uses `unauthorized` for
wrong credentials, `forbidden` for refused access and `upstream_unavailable` for backend/network
failure. File operations additionally use `not_found`, `conflict`, `payload_too_large`,
`rate_limited`, `bad_request` and `internal`. Keep messages/details free of credentials.
`unsupported` is an API error kind, not a `StorageErrorKind`.

## 3. Implement the storage contract

Implement every required method in the [storage port](../packages/core/src/ports/storage.ts):
`list`, `stat`, `statFile`, `download`, `upload`, `mkdir`, `move`, `copy`, `deleteFile`, `deleteDir`.
The optional methods are `probeDirectoryRead`, `setModifiedAt`, `zip`, and the `trash` interface.

- Paths are provider-relative absolute paths, not local filesystem paths. Normalize at the
  adapter boundary; keep Unicode and literal-percent names intact. Encode URL segments without
  treating a literal `%41` filename as `A`. Confine protocol responses/redirects to the configured
  endpoint and path prefix; never forward credentials to an unrelated server.
- `list` returns core `FileEntry` values. `stat` handles files and directories; `statFile` must
  throw `bad_request` for a directory and `not_found` for a missing path.
- `download` returns a Web `ReadableStream<Uint8Array>` with status 200/206 and response metadata.
  Honour `range`, `ifRange`, and cancellation. Pass upload cancellation through too; stream large
  bodies instead of buffering them in memory.
- Support recursive directory copy/move/delete and requested parent creation. Document actual
  overwrite behaviour. SFTPGo overwrites by default; some backends can reject an existing target
  with `conflict`. Honour `overwrite: false` where supported. API pre-checks do not make a
  backend's non-atomic operation atomic.
- Omit unsupported optional methods rather than exposing methods that always throw. Keep their
  presence consistent with capabilities. `probeDirectoryRead`, if supplied, proves live read
  access rather than returning cached permissions or a stat result.

## 4. Register the type and presentation

The current integration checklist has more than one registry edit:

1. Add the type string to `ProviderType` in
   [contracts/providers.ts](../packages/contracts/src/providers.ts).
2. Import the exported module and add it to `PROVIDER_MODULES` in the
   [API registry](../apps/api/src/providers/registry.ts). The API package dependency from step 1
   must exist for this import to work.
3. Add a product label to
   [PROVIDER_TYPE_LABELS](../apps/web/src/lib/identity/provider-type.ts) and an icon to
   [ProviderIcon's ICONS map](../apps/web/src/components/identity/provider-icon.tsx).
   Both maps are exhaustive over `ProviderType`, despite their runtime fallbacks.
4. Update tests that enumerate provider types, credential fields or product names. Test the
   generic login, account and System > Storage forms using the new module's metadata.

For basic storage there should be no need for a new database schema or provider-specific file
routes. Configured instances are added through **System > Storage**. The current setup wizard
and `SFTPGO_URL` bootstrap remain SFTPGo-specific; registering another module does not change them.

## 5. Enable only supported features

The [provider service](../apps/api/src/providers/service.ts) combines module flags with instance
configuration for `IdentitySummary.capabilities`. System > Storage's chips show type-level
capabilities; a particular login can have fewer features. Office also has separate runtime and
permission checks; the capability is not proof that an Office server is configured.

| Flag | Current behaviour and integration requirement |
| --- | --- |
| `zip` | Requires `storage.zip`. Without it, multi-download downloads individual files and skips directories; folder-only selections cannot download. |
| `setModifiedAt` | Requires support for supplied mtimes and the optional setter. The Inspector shows an upload-time note when false. |
| `atomicMove` | Describes the backend operation. False adds caution copy for folder moves/renames; it does not create a progress job. |
| `trash` | Also requires `trash !== "none"` and enabled per-provider Trash settings. See below. |
| `shares` | Must equal `shares !== "none"`; a registry test checks every module. Keep `"none"` for a new backend: only `"native"` is served today. See below. |
| `office` | Keep false until storage admission, provider-bound locations and the full Office flow work for the new backend. |
| `index` | Also requires `indexRootName(instance)` to name a configured root. The scope resolver currently admits SFTPGo only, so a new remote backend needs more than this callback. |
| `scopeMapping` | Same root restriction; keep false until the scope resolver can safely map that backend. |

### Files-only storage

SFTPGo is the main storage. A type with `index`, `shares` and `office` all false is
**files only** (`isFilesOnly` in
[capabilities.ts](../apps/web/src/lib/identity/capabilities.ts)), which today is WebDAV and
S3. Hidden controls are not enough: people must read the limit before they miss a feature.
The same one-line note (`FILES_ONLY_NOTE`) therefore appears on the login form and the Add
login dialog once such a storage is chosen, under its login on the Account page, in the Add
provider dialog, and on its System > Storage row, where a **Not available** chip row lists
every capability the type lacks beside **Supports**. Search says "not available for this
login" with what it needs, rather than a generic failure, when the scope reason is
`no_roots`. The Shares page does the same: with a login whose storage cannot share it names
the login, says which storage can, and never asks the API for the list, since the sidebar
shows Shares whenever any linked login can share. All of it is driven by flags, never by a
type name, so a new backend gets the copy by keeping its flags honest.

The public provider list carries the type's flags (`PublicProvider.capabilities`) so the
note can show before sign-in. They are constants of the type and reveal nothing about the
row; what a login really gets stays `IdentitySummary.capabilities`.

The web reads flags through [capabilitiesFor/anyLoginCan](../apps/web/src/lib/identity/capabilities.ts)
and uses [planDownload](../apps/web/src/lib/files/download.ts) for downloads. There is no
`browserActions` helper. Shares and Trash sidebar visibility is the union across linked logins.
Test server-side refusals as well as hidden controls; a stale client can still make requests.

### Trash

`trash: "native"` means the backend moves deletes into the supported recycle-folder layout;
`"move"` asks the API storage factory to apply core's `withMoveToTrash`; `"none"` disables it.
The factory then attaches `createRecycleFolderTrash` for listing, restore, purge and empty.
Do not apply these wrappers a second time in the module.

Native SFTPGo directory deletes create one ordinary timestamp file leaf for each nested file.
Generic `"move"` providers use a separate `.fdrive-move-v1` namespace. Alternating structural
markers and raw path segments keep long, numeric, Unicode and literal-percent names reversible
without expanding a provider filename. File and directory leaves also occupy separate branches,
so a whole-directory move cannot merge with ordinary file-leaf scaffolding. Legacy generic
entries outside this namespace are not inferred automatically; in particular, an unmarked
timestamp directory is never treated as a deleted directory. Restores and purges may leave empty
path containers under the recycle root; Trash listing ignores them and **Empty Trash** removes
them. This preserves empty directories without an unsafe list-then-recursive-delete cleanup.
A recycle root belongs to one configured provider strategy; do not share it between native
and generic move layouts. Native providers reserve no original filename for the generic layout.

### Shares

`shares: "native"` means the backend keeps its own public share objects and API: the share
service creates and edits them with the owner's token and proxies the public share API to
visitors (SFTPGo). `"none"` means no share links: the management routes refuse with
`unsupported` and `capability: "shares"`, and the web states the limit. `"owned"`, where
fdrive keeps the share in `app.shares` and serves the link through the module's storage, is
the planned path for files-only backends ([Owned shares](plans/OWNED-SHARES.md)) and is
refused like `"none"` until that store exists. The share code reads the strategy, never the
provider type: the public routes are handed a `PublicShareAccess` (`list`, `download`, `zip`,
`upload` and a neutral view of the share, in
[access.ts](../apps/api/src/shares/access.ts)) whose implementation maps its backend's
failures to API errors, and the adapter over SFTPGo's public share API is the only one today.

Settings live under `trash.configuration.<providerId>` in `app.settings`, not in
`provider.config.trash`. They default to disabled with path `/.trash`. The native layout is
`<trashPath>/<original directory>/<original filename>/<nanosecond timestamp>`; deleting inside
the trash permanently deletes so purge/empty work. The native option is not an arbitrary
upstream recycle-bin API hook.

`GET /api/v1/system/trash?providerId=` and the PUT body name the row explicitly; the routes
never follow the caller's login. The response (`TrashSettings` in contracts) carries that
provider module's strategy next to the stored configuration, and the
[Trash settings form](../apps/web/src/components/system/trash-settings-card.tsx), rendered on
each server's row under System > Storage, keys its copy on it: `native` asks operators to configure and confirm the SFTPGo rule, `move` explains that
fdrive performs the move and needs no confirmation, `none` cannot be enabled. The strategy is
never stored; the service reads it from the module on every request, refuses an update whose
strategy no longer matches, and reads a stored row as disabled when the module's current
strategy would not allow it. A new `"move"` backend needs a real round-trip test on its server
(see the WebDAV container suite). The old proposal for automatic trash-folder ownership
validation is not an implemented guarantee.

## Isolation and lifecycle requirements

Preserve these behaviours when integrating a provider:

- Credentials are encrypted by the API and bound to the row that verified them. Login/link
  re-resolves the row after upstream authentication; database persistence locks and rechecks
  type, endpoint and enabled state. Do not bypass these checks or write identities directly
  from the module.
- Changing an endpoint is refused for environment-managed rows or rows already used by logins.
  Do not add mutable config that silently sends stored credentials to a different server.
  Create another instance for another server. Deletion is refused while identities reference
  the row; labels/configuration/enabled state have their own update paths.
- Environment administrator names apply only to the configured SFTPGo endpoint, not matching
  usernames on another provider. Other providers use persisted account administrator status.
  Environment endpoint matching ignores trailing slashes; seeding reuses the pinned row and
  preserves its stored address, identity bindings and an administrator's disabled state.
- Missing/blank SFTPGo home templates mean no index mapping. Only setup/environment seeding
  supply their default; a remote row must never inherit access to a local index root.
- Disabling a provider blocks its storage operations without invalidating the whole session:
  account/admin routes, logout and identity switching remain available. `setup.initialized.v1`
  records initialization independently of provider availability; pending owner claims retain
  precedence. Disabling the last provider must not reopen setup.
- The public provider list exposes the administrator's label or an empty string and the
  type's constant capability flags, never the endpoint host. Keep endpoint details and config out of anonymous discovery and error messages.

Use [provider-binding integration tests](../apps/api/test/integration/provider-binding.test.ts)
and [identity-link repository tests](../packages/db/test/integration/identity-links.test.ts)
as references for concurrent login/update, linked-account and cross-provider boundaries.

## 6. Test the fake, backend and full application

Run `describeStorageProvider(name, factory, options)` from `@fdrive/testkit` against both a
protocol fake and a disposable real backend. See the
[fake suite](../packages/sftpgo/src/conformance.test.ts) and
[container suite](../packages/sftpgo/test/integration/container.contract.test.ts).
The factory returns `{ storage, cleanup? }` for each test. Options are `overwritesOnMove`
(default false), `workspace` (otherwise a unique directory), and `probe` (false skips the
optional live-read probe). There is no capabilities option; optional methods are detected on
the storage object.

The shared suite covers basic file operations, byte ranges, already-aborted downloads,
Unicode/percent names and optional methods. Add backend tests for gaps: matching/stale `ifRange`,
mid-stream aborts, upload cancellation, no-overwrite races, permission/error mapping, malformed
or oversized responses, safe redirects, credential refresh/retry and transient-field handling.
Keep fake and real-server assertions consistent; a passing memory test is not a backend test.

`createMemoryStorage` is available from `@fdrive/core/testing`, re-exported by `@fdrive/testkit`.
It is the canonical application fake; do not add another generic memory storage implementation.
For API tests, reuse [provider fixtures](../apps/api/src/providers/test-fixtures/index.ts) and
`ProviderServiceDeps.modules` injection. A new type must still be present in the contracts enum.

Run one full path early: register the type, add an instance, log in, browse, upload, rename and
delete against the real fixture server. Also link it beside SFTPGo, put the same path on both,
and prove reads/writes, API tokens and queued operations cannot cross identities. Exercise
invalid credentials, revocation, disabled-provider recovery and unsupported controls/API calls.

From the checkout root (replace the example package and add the new backend's browser spec):

```bash
pnpm --filter @fdrive/provider-example typecheck
pnpm --filter @fdrive/provider-example test:coverage
pnpm lint && pnpm typecheck && pnpm test:coverage
pnpm test:integration
pnpm test:e2e e2e/login-providers.spec.ts e2e/system-storage.spec.ts --workers=1
```

Also verify the affected flows in the real dev app. These commands retain the repository's
lint, type and coverage gates; integration requires Docker. Keep one heavy container suite
running at a time. Report fake versus real-backend checks separately.

## Current limits

A new module does not implement a remote index walker, provider-neutral Office admission,
fdrive-owned shares, an OAuth login flow, a non-atomic move job, or an arbitrary native Trash
API. Extend those application boundaries explicitly when needed; keep corresponding flags
false until that work is complete. The index-root configuration still uses `sftpgoPath`.
Provider changes emit `general` system events, but there is no dedicated UI page for that log.
