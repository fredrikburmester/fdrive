# Storage port

The files folder ([`packages/local`](../packages/local/src/)) is fdrive's only storage. The API
reaches it through a small port in `packages/core/src/ports/`: `ProviderModule` configures,
authenticates and builds storage, and `StorageProvider` does the file operations. The port keeps
routes, the web app, the schema and the indexer off filesystem details and lets tests run on an
in-memory storage. It is an internal boundary, not a plugin system; WebDAV and S3 modules were
removed on 2026-11-13.

| Contract | Source |
| --- | --- |
| Module, fields, capabilities, instance and session | [provider port](../packages/core/src/ports/provider.ts) |
| File operations, streams and optional members | [storage port](../packages/core/src/ports/storage.ts) |
| The local module and its storage | [module](../packages/local/src/module.ts), [home storage](../packages/local/src/storage-provider.ts), [shared folders](../packages/local/src/shared.ts) |
| Registry | [registry](../apps/api/src/providers/registry.ts), [deployment modules](../apps/api/src/local/modules.ts) |
| Capabilities, seeding, admin view | [provider service](../apps/api/src/providers/service.ts) |
| Per-request storage and Trash | [storage factory](../apps/api/src/auth/storage-factory.ts) |

## Wiring

- `ProviderType` in [contracts](../packages/contracts/src/providers.ts) is `"local"`. The
  registry holds only the local module, present when `FDRIVE_STORAGE_ROOT` is set. Without it
  the deployment has no storage and setup refuses to complete with `bad_request`.
- The storage is one row in `app.providers`. Startup creates and pins it (`baseUrl` `local`),
  enables it, and unpins and disables any other pinned row. Rows left from WebDAV or S3 are
  disabled by migration 0019 and kept, since logins reference them; with no module, those
  logins do not appear.
- `GET /api/v1/admin/providers` lists the storage with a reachability probe.
  `PATCH /api/v1/admin/providers/:id` changes only its display label (trimmed, 1 to 120
  characters), shown on the login page and in Finder; System > General edits it.
- An identity is a login on that row; an account links identities. Per request the API
  resolves the identity's row and module, runs `admit`, calls `createStorage`, hides the backup
  namespace (`withoutBackupPaths`) and adds the Trash wrappers when Trash is on.

## ProviderModule

| Member | Local folder |
| --- | --- |
| `type`, `label` | `"local"`, "Local folder" until the row is renamed |
| `configFields`, `credentialFields` | None; `username` and `password`. Fields drive the login form and the API's validation (`validateFields` in [provider-fields.ts](../packages/core/src/provider-fields.ts)) |
| `capabilities` | All eight flags true (below) |
| `trash` | `"move"`: fdrive moves deletes into the Trash folder (`"none"` would mean no Trash) |
| `shares` | `"owned"`: fdrive keeps links in `app.shares` and serves them through this storage ([owned.ts](../apps/api/src/shares/owned.ts)) |
| `deploymentManaged` | True: the row comes from `FDRIVE_STORAGE_ROOT`; the API cannot create, re-address or remove it |
| `indexRootName` | The index root the folder is read under (`localIndexRoot`) |
| `probe` | The root is a folder the API can read, write and enter |
| `authenticate` | Checks the password against `app.local_users`: `unauthorized` when wrong, `forbidden` when disabled, and a credential naming another user than `ctx.expectedUsername` is refused |
| `admit` | Refuses a disabled or removed user on every request, not only at sign-in |
| `createStorage` | The home at `<root>/<username>`, plus `/Shared with me` from `app.local_grants` |

## Capabilities

The API combines the module's flags with configuration into each login's
`IdentitySummary.capabilities` (`capabilitiesFor`), and the web reads them through
`capabilitiesFor` and `anyLoginCan` in
[capabilities.ts](../apps/web/src/lib/identity/capabilities.ts). Nothing keys on a type name,
and the API refuses what a login lacks even when a stale client asks.

| Flag | Meaning | Per login also needs |
| --- | --- | --- |
| `zip` | `storage.zip` streams an archive | |
| `setModifiedAt` | Uploads keep a supplied modification time | |
| `atomicMove` | `move` is one operation | |
| `trash` | A Trash folder can exist | Trash on in its settings |
| `shares` | Share links; equals `shares !== "none"`, checked by a registry test | |
| `office` | Office can be offered | Office's own runtime and permission checks |
| `shareWithPeople` | Folders shared between users under `/Shared with me` | |
| `index` | Search, thumbnails and folder sizes | `indexRootName` naming a root in `FDRIVE_INDEX_ROOTS` ([scoping](SCOPING.md)) |

## StorageProvider

Required: `list`, `stat`, `statFile`, `download`, `upload`, `mkdir`, `move`, `copy`,
`deleteFile`, `deleteDir`. Optional members are absent, never throwing, and agree with the
flags: `probeDirectoryRead` and `probeFileRead` (live read proofs), `setModifiedAt`, `zip` and
`trash`. Three more, `withWriteLease`, `maxPublishBytes` and `movesDirectoriesByCopy`, describe
backends that need a write lease, cap publication or move folders by copying; the files folder
sets none of them, and the Mac write path still honours them.

Paths are the storage's own, already resolved from a scope. `statFile` throws `bad_request` on a
directory and `not_found` on a missing path. `move`, `copy` and `upload` overwrite unless
`overwrite: false`. `download` honours `range` with a 206 and `Content-Range`, and `ifRange`.
Failures are `StorageError`s from core.

How the files folder implements it:

- **Confinement.** Paths are normalized and joined to the home; a symlink is followed only when
  its real path stays inside the home or the shared folder ([home.ts](../packages/local/src/home.ts)).
- **Atomic publish.** Uploads and copies write a temporary file beside the target and `rename`
  it over the name; `overwrite: false` publishes with `link`, a real create-if-absent.
- **Moves** are one `rename`, also between a user's files and a writable shared folder.
- **Spelling.** On a disk that ignores case or accent encoding, `stat` reports the stored
  spelling as `path`, so links and lookups land on the name listings show.
- **Downloads** send `Last-Modified` and no ETag; `ifRange` applies when it names the file's
  current second.
- **Read proofs** open nothing: `probeFileRead` asks `access(R_OK)` and then checks for a
  regular file, the checks `download` makes, and fails with the kinds `download` would.
- **Zip** streams with `yazl`.
- **Trash.** The storage factory wraps the storage with core's `withMoveToTrash` and
  `createRecycleFolderTrash`; deleted items live in `<trash folder>/.fdrive-move-v1`. Settings
  are `trash.configuration.<providerId>` in `app.settings`, disabled at `/.trash` by default,
  read and written through `/api/v1/system/trash?providerId=` ([Trash](TRASH.md)).
- **Ownership.** The API writes as `FDRIVE_RUN_AS_UID`, the uid the indexer and OCR use.
- **Changes for the indexer.** Storage reports each change once it succeeds (`onChange`, a
  `DiskChange` by absolute path; [changes.ts](../packages/local/src/changes.ts)): an upload,
  copy, delete or new modification time is `changed`, a move is `moved`, and `mkdir` reports
  nothing. An upload's change carries the sha256 of the bytes written, the size,
  `mtimeNs` and inode of the file before it is published, and the change time once it is;
  when the published name no longer holds that inode, the change carries no content.
  Hashing runs only while something listens. The module turns these into paths under the index root (`onIndexChange`), and the
  API queues them in `idx.work` (`createIndexWorkQueue`) only when a configured root's
  `storagePath` is the files folder itself (`indexWorkRoot`). A failed write is logged, never
  failing the request; see [how changes arrive](INDEXER.md#how-changes-arrive).

## Tests

`describeStorageProvider(name, factory, options)` from `@fdrive/testkit` is the shared
conformance suite; [the local suite](../packages/local/src/conformance.test.ts) runs it over a
temporary directory. `createMemoryStorage` from `@fdrive/core/testing` is the application fake;
do not add another. API tests reuse the
[provider fixtures](../apps/api/src/providers/test-fixtures/index.ts) and inject modules through
`ProviderServiceDeps.modules`.
