# P10 storage providers (design, decided 2026-09-10)

fdrive grows from an SFTPGo frontend into a multi-provider file manager. One instance serves
several providers at once; an account links one identity per provider it uses and the existing
login switcher moves between them. Adding a provider must be a contribution: one package, one
exported module, a shared conformance suite, one registry line, and no changes to routes, web
components, migrations or the indexer.

Investigation summary (2026-09-10): the `StorageProvider` port in `packages/core/src/ports/storage.ts`
is already the seam. File routes, archives, thumbnails, Office GetFile/PutFile, MCP writes and
the recycle-folder trash program against it; the SFTPGo adapter is 198 lines with one
construction point (`apps/api/src/auth/storage-factory.ts`). What blocks a second provider is
concentrated: the connection singleton (`connection/store.ts`, key `connection.sftpgo`) and the
seven call sites that compare an identity's provider base URL against it; login that verifies and
mints a JWT in one call; shares owned by SFTPGo; the indexer reading a bind-mounted disk. The rest
is copy in about 30 web files. The web hides almost nothing today: only Trash, search modes and
Office are gated, so an S3 login would show Download as zip, Share and Compress and each would fail.

## Decisions

1. WebDAV is the first provider. S3-compatible (AWS, B2, MinIO, R2) is designed for and built
   later. Local disk, OAuth cloud drives, SMB, FTP are not planned. A second SFTPGo falls out of
   providers becoming rows.
2. Operators configure endpoints; users supply credentials only. A provider row is an
   admin-configured endpoint (for S3: endpoint plus bucket). Login and link forms never accept a
   URL from a user. Credentials stay envelope-encrypted and bound to the provider row.
3. Remote providers ship without thumbnails, search, folder size, virtual folder mapping or
   Office in the first version. The scope engine already reports these identities as `no_roots`;
   the capability list hides the remaining controls. The remote indexing walker and Office for
   remote providers are later work.
4. Sharing is in the first version for every provider: fdrive-owned shares behind a
   `ShareProvider` seam. SFTPGo logins keep native shares (no migration, passwords stay in
   SFTPGo, shares made in SFTPGo's web client stay visible).
5. Features have generic defaults in core; providers override only what is native. No
   per-feature connector layer. Trash by move, owned shares and archive jobs work over the port
   for any provider. A module declares capabilities and may supply a native implementation where
   one exists (SFTPGo shares, SFTPGo's server-side trash rule). Later native overrides fit the
   same hook: Nextcloud's DAV trash bin, S3 bucket versioning as trash.
6. Design-for-S3 constraints on the groundwork: an identity may have no username (the module
   returns the `externalUsername` it wants stored, an access key id or a label); a credential
   schema is not password-shaped; `atomicMove` and `setModifiedAt` are capability flags; `zip`
   and `setModifiedAt` become optional on the port.
7. The connection singleton is folded into provider rows. `SFTPGO_URL` seeds the first row and
   pins its endpoint (`managedByEnv`), as it pins `baseUrl` today.
8. One package per provider: `packages/sftpgo` (existing, gains the module) and
   `packages/provider-webdav`. Each has its own coverage gate and an in-package fake.

## Architecture

### Provider module

```ts
// packages/core/src/ports/provider.ts
interface ProviderModule<Config, Credential> {
  type: ProviderType;                   // "sftpgo" | "webdav"; contracts own the enum
  label: string;                        // "SFTPGo", "WebDAV"
  attribution?: { name: string; url: string };   // About page; SFTPGo keeps its AGPL notice
  configSchema: ZodType<Config>;        // admin-set; field metadata drives the admin form
  credentialSchema: ZodType<Credential>;// user-set at login/link; field metadata drives the form
  capabilities: Capabilities;           // see below
  trash: "native" | "move" | "none";    // how deleted files reach the recycle folder
  probe(config, fetch): Promise<ProbeResult>;
  authenticate(config, credential, fetch): Promise<{ externalUsername: string }>;
  mint?(config, credential, fetch): Promise<{ token: string; expiresAt: Date }>;
  createStorage(config, auth: { credential; token?: string }, fetch): StorageProvider;
  createShares?(...): ShareProvider;    // only SFTPGo; everyone else gets owned shares
}
```

`mint` is optional. When present the existing token cache (`credentials.cached_token`,
`auth/token-source.ts`) and the retry-once-on-unauthorized logic stay, now generic. When absent
the storage signs every request from the credential (WebDAV Basic, S3 SigV4).

### Registry and capabilities

`apps/api/src/providers/registry.ts` maps `ProviderType` to module and is the only place that
imports provider packages besides `composition.ts`. A type-level check keeps the registry and the
contracts enum in step.

```ts
Capabilities = { zip, setModifiedAt, atomicMove, trash, shares, office, index, scopeMapping }
```

`IdentitySummary.capabilities` carries the active values per linked login (module flags combined
with configuration: `trash` also needs the provider's trash setting on; `index` and
`scopeMapping` also need an index root mapping; `office` also needs Office enabled). The web
reads it through one helper; the API enforces the same flags on zip, share, Office and scope
routes with a typed `unsupported` error.

### Data model

- `app.providers`: keep `id`, `type`, `base_url`, `created_at`; add `label text`, `config jsonb`
  (validated by `configSchema`; for SFTPGo holds `homeTemplate`), `enabled boolean`,
  `managed_by_env boolean`. Unique `(type, base_url)` stays.
- `connection.sftpgo` settings key is migrated into the SFTPGo provider row at startup and
  removed. `ConnectionStore` is deleted; its seven consumers resolve the identity's provider row.
- `app.credentials` unchanged: the ciphertext is the module's credential JSON.
- `app.shares` per [P10-SHARES.md](P10-SHARES.md).

### Contracts

- `ProviderType = z.enum(["sftpgo", "webdav"])`; `IdentitySummary.providerType` uses it and gains
  `capabilities`; `providerLabel` comes from the row label.
- `PublicProvider { id, type, label, credentialFields[] }` on a public `GET /api/v1/providers`
  (enabled rows only, for the login page) and `MeResponse`.
- `LoginRequest { providerId?, credential: object }`; `providerId` defaults to the only enabled
  provider. `LinkIdentityRequest { providerId, credential, currentCredential }`. Server validates
  `credential` against the module schema. fdrive is pre-release; no compatibility shape.
- Admin: `GET/POST /admin/providers`, `PATCH/DELETE /admin/providers/:id`,
  `POST /admin/providers/:id/test`. `/admin/connection` and `AdminConnection*` are removed.
- `AboutResponse.builtOn` becomes a list, one entry per configured provider with attribution.
- `SystemFeaturesResponse.roots[].sftpgoPath` becomes `providerPath`.

### Web

One helper `lib/identity/capabilities.ts` (in the style of `officeModesFor`) and one
`capabilities` prop to the toolbar, context menu and keyboard map, replacing `hideArchive`,
`hideMoveCopy` and `trashAvailable`. Sidebar Shares and Trash use the union across linked logins.
Login and link forms render fields from `credentialFields` and show a provider picker only when
more than one provider is enabled. The identity scope card renders only with `scopeMapping`.
System > General's connection card becomes System > Storage: a provider list with type, label,
endpoint, reachability and capability chips; the setup wizard still creates an SFTPGo provider.
Login switcher shows the provider label. About lists every provider's attribution.

### Testing

`@fdrive/testkit` exports `describeStorageProvider(factory, options)`: one behavioural suite run
against the memory fake, the SFTPGo fake, the real SFTPGo container, the WebDAV fake and the real
WebDAV container. It covers listing, stat kind, Range and `ifRange`, conflicts and the overwrite
option, Unicode and literal-percent names, cancellation, error kinds, and the optional methods
by capability. The two memory fakes (`apps/api/test/fixtures/memory-storage.ts`,
`packages/core/test/fixtures/memory-storage.ts`) merge into one in testkit.

## Chunks

| Chunk | Spec | Depends on |
| --- | --- | --- |
| A1 registry, providers table, generic auth, port cleanup, conformance suite, contracts | [P10-REGISTRY-API.md](P10-REGISTRY-API.md) | none |
| A2 capabilities in the web, provider forms, System > Storage, About | [P10-CAPABILITIES-WEB.md](P10-CAPABILITIES-WEB.md) | A1 contracts agreed |
| B WebDAV provider package | [P10-WEBDAV.md](P10-WEBDAV.md) | A1 |
| D fdrive-owned shares | [P10-SHARES.md](P10-SHARES.md) | A1; parallel with B |

S3 is not a chunk yet. Later: Office for remote providers (registry key without a disk root,
provider-neutral edit admission), streamed zip for `fs/zip` on providers without server zip, the
remote indexing walker.

## Checks

Per chunk. Whole feature: `application`, `integration` (both real containers), browser specs
that assert an identity with a capability removed loses the matching controls, `workflow`.
Existing SFTPGo behaviour and deployment defaults unchanged; `SFTPGO_URL` deployments start
without operator action.
