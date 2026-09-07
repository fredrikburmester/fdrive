# Office editing over WOPI

Office servers are optional. Normal `pnpm dev:env` and the core production compose
file do not start them. Select ONLYOFFICE or Collabora for one API deployment.

## Development

From the repository root, with Node 24, pnpm 10 and Docker running:

```sh
pnpm exec tsx tools/office/setup.ts onlyoffice
docker compose --env-file .env.office.onlyoffice.dev -f deploy/compose.office.dev.yaml --profile office up -d --wait
```

For Collabora instead:

```sh
pnpm exec tsx tools/office/setup.ts collabora
docker compose --env-file .env.office.collabora.dev -f deploy/compose.office.dev.yaml --profile collabora up -d --build --wait
```

The setup helper creates a mode-0600, Git-ignored `.env.office.<product>.dev` file.
It generates a fixed random JWT secret once, never overwrites the file, and never
prints its contents. It does not edit the API's existing `.env.dev`. Export the
new file's settings before starting the host-run API, or copy its office settings
into your local API environment. Restart the API after changing the product.
Use `http://localhost:3002` for the web app so the configured frame origin matches.

| API setting | Development value |
| --- | --- |
| `FDRIVE_OFFICE_PRODUCT` | `onlyoffice` or `collabora` |
| `FDRIVE_OFFICE_URL` | `http://localhost:58090` or `http://localhost:58091` |
| `FDRIVE_OFFICE_PUBLIC_URL` | Same as the development discovery URL |
| `FDRIVE_WOPI_URL` | `http://host.docker.internal:3001/wopi` |
| `FDRIVE_PUBLIC_URL` | `http://localhost:3002` |
| `FDRIVE_OFFICE_MAX_BYTES` | `104857600` |
| `FDRIVE_OFFICE_EDIT_RULES` | `[]`, view-only until explicit grants are configured |

ONLYOFFICE binds `127.0.0.1:58090`; Collabora binds `127.0.0.1:58091`. Neither binds
all host interfaces. Containers use `host.docker.internal` for the host-run API;
Linux uses Docker's `host-gateway` mapping. The API must listen on an interface
reachable through that gateway. Both services can run together for testing, but
the API selects one product.

The compose project is `fdrive-office-dev`. Its named volumes are
`fdrive-office-dev_office_onlyoffice_data` and
`fdrive-office-dev_office_collabora_keys`. Stop the companion without deleting
its keys:

```sh
docker compose --env-file .env.office.onlyoffice.dev -f deploy/compose.office.dev.yaml --profile office --profile collabora down
```

Do not add `-v` when keeping a deployment. It removes keys and changes the identity
of the document server. Preserve the environment file as well as the volumes.

## Production

The supplied proxy overlays expect TLS termination at the operator's edge proxy.
Route the configured public hostname to the existing fdrive proxy's HTTP port.
The edge must support WebSocket upgrades and suitable document-save timeouts.
Caddy's `reverse_proxy` handles WebSocket upgrades and streams payloads.
Do not expose the internal API, database or office ports to the internet.

Set `FDRIVE_PUBLIC_URL=https://drive.example.test` in the existing operator
environment. For ONLYOFFICE also supply `ONLYOFFICE_JWT_SECRET`: at least 32
letters, digits, underscores or hyphens. `openssl rand -hex 32` generates a suitable
value; store it privately. The entrypoint rejects characters the upstream script
cannot safely interpolate. Never put the secret in a tracked compose file.

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.office.yaml --profile office config --quiet
docker compose -f deploy/compose.yaml -f deploy/compose.office.yaml --profile office up -d --wait
```

This sets internal discovery to `http://onlyoffice`, public office URL to
`${FDRIVE_PUBLIC_URL}/onlyoffice`, and callbacks to `http://api:3001/wopi`.
The proxy strips `/onlyoffice`, forwards the public host plus that base path, and
sets `X-Forwarded-Proto: https`. The server uses WOPI zone `external-https`.
The browser receives the public URL; callbacks remain on the Docker network.

For Collabora, use its overlay instead of the ONLYOFFICE overlay. Set
`FDRIVE_COLLABORA_HOST=office.example.test` and route that second HTTPS hostname
to the same proxy port:

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.office.collabora.yaml --profile collabora config --quiet
docker compose -f deploy/compose.yaml -f deploy/compose.office.collabora.yaml --profile collabora up -d --build --wait
```

This sets internal discovery to `http://collabora:9980`, public office URL to
`https://${FDRIVE_COLLABORA_HOST}`, and callbacks to `http://api:3001/wopi`.
Collabora's allowed WOPI host is exactly that callback origin. Its frame-ancestor
policy permits the configured fdrive origin. TLS terminates at the edge; outbound
TLS certificate verification and document sandboxing remain enabled. `MKNOD` is
the only added capability. Mounting jail trees is disabled so `SYS_ADMIN` and
privileged mode are unnecessary.

Production overlays enable API office settings when included. Include the
matching profile on every `up`; to turn office off, omit the entire overlay and
recreate the API and proxy. Do not combine both product overlays.

## Proof keys and image pins

The compose files pin image versions and immutable image-index digests:

| Image | Digest |
| --- | --- |
| `onlyoffice/documentserver:9.4.0.1` | `sha256:3ab6ebc7c605e5a32b7ae3ff19daed4925090245acc8100ce2230bd766c88212` |
| `collabora/code:26.04.3.2.1` | `sha256:379b8f1fc955dd6d01ba24adf61d1b177048ddaae179ae8c1e6a6342daccb282` |
| `node:24.20.0-bookworm-slim` key initializer | `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e` |

All three selected native `linux/arm64` images on the development Mac. No emulation
or privileged container was required.

ONLYOFFICE's pinned `/app/ds/run-document-server.sh` overrides the similarly named
`WOPI_PRIVATE_KEY` and `WOPI_PUBLIC_KEY` environment variables. It reads
`/var/www/onlyoffice/Data/wopi_private.key` and derives `wopi_public.key` in
Microsoft PUBLICKEYBLOB format. The wrapper generates a fresh RSA-2048 private
key with mode 0600 in the dedicated Data volume. Existing private keys survive
container replacement. A public key without its private key fails startup rather
than silently rotating. Metadata-IP access remains false; only private-network
access needed for internal callbacks is enabled. The stock shared key is unused.

Collabora 26.04.3.2.1 is a distroless image with no shell, startup shell script or
`coolconfig`. `extra_params` is ignored by its native `--use-env-vars` entrypoint.
The small init image generates the RSA PEM/OpenSSH pair equivalent to the
[documented `ssh-keygen` alternative](https://sdk.collaboraonline.com/CO-SDK-manual.pdf),
then copies the pinned default `coolwsd.xml` beside it. The server reads proof keys
from `/etc/coolwsd/proof_key`; changing `--config-dir` does not move that path.
The volume is read-only in the server, directory mode 0700, files mode 0600,
owned by service UID/GID 1001. Initialization preserves matching keys, repairs an
interrupted public-key write, and rejects mismatched pairs. It runs without
network access and does not replace the private key.

Discovery is trusted only from the configured office service. The API validates
signed WOPI callbacks, current session/identity ownership, canonical file scope,
explicit edit admission, and the user's SFTPGo access.

## Editing admission

Office is view-only by default. `FDRIVE_OFFICE_EDIT_RULES=[]` denies editor entry,
new documents, conversion and writes. View remains available. SFTPGo's
credential-only user API does not expose authoritative per-path write capability.
A successful login or download is not a write grant. Shared editors can pool
changes from several users and save with one writer's credentials, so rejecting a
reader's own upload is insufficient.

Operators explicitly configure a trusted grant list, limited to a subset of each
user's actual SFTPGo write permissions. This second authorization configuration
must stay synchronized with upstream permissions. Close all active Office sessions
when changing rights, then restart the API with the updated policy. Existing
editor processes may retain coediting permissions until those sessions end.

Each strict JSON rule has exactly `providerId`, `username`, `path`, `recursive`
and `allow`. Provider UUID and username match exactly, including username case.
Paths must be canonical absolute virtual paths, with no traversal, repeated or
trailing slash. Recursive rules include descendants only at path-segment boundaries.
The longest matching path wins; deny wins ties. No matching rule denies. Wildcards
are unsupported. Input is limited to 128 KiB and 500 rules; invalid policy prevents
API startup. There are no credentials in this policy.

Obtain an owned identity UUID and exact username from the signed-in browser's
`GET /api/v1/auth/me` response (`identities[].id` and `identities[].username`).
The identity UUID is not the provider UUID. An operator with access to fdrive's own
Postgres can map it without SFTPGo administrator credentials:

```sql
SELECT p.id AS provider_id, p.base_url, i.external_username
FROM app.identities AS i
JOIN app.providers AS p ON p.id = i.provider_id
WHERE i.id = 'REPLACE_WITH_OWNED_IDENTITY_UUID'::uuid;
```

Verify the returned provider URL before granting access. For example, a deployment
`.env` entry can grant Alice a folder while denying a private subtree. Replace the
example provider UUID with the verified value:

```dotenv
FDRIVE_OFFICE_EDIT_RULES='[{"providerId":"12345678-1234-4234-8234-123456789abc","username":"alice","path":"/documents","recursive":true,"allow":true},{"providerId":"12345678-1234-4234-8234-123456789abc","username":"alice","path":"/documents/private","recursive":true,"allow":false}]'
```

Both production Office overlays pass this setting to the API. Host-run development
uses the same setting and defaults to no grants. The isolated browser fixture
explicitly injects authority derived from its seeded Alice/Bob writer permissions;
Reader receives no grant. Production never imports that fixture.

The Collabora pin includes the locale fix for
[upstream filename detection issue 16023](https://github.com/CollaboraOnline/online/issues/16023).
The acceptance suite opens filenames containing spaces, Unicode and literal percent
sequences against the pinned image.

ONLYOFFICE's [view cache key implementation](https://github.com/ONLYOFFICE/server/blob/master/DocService/sources/wopiClient.js)
prefers `LastModifiedTime` over `Version`. fdrive omits that optional CheckFileInfo
timestamp for ONLYOFFICE, so the live content hash controls view cache invalidation,
including external writes with unchanged size and mtime. Collabora still receives
the real timestamp. No fabricated modification time is used.

## Checks

Helper checks, independent of application packages:

```sh
pnpm biome check --write tools/office deploy/office
pnpm tsc -p tools/office/tsconfig.json
pnpm vitest run --coverage --config tools/office/vitest.config.ts
bash -n deploy/office/onlyoffice-entrypoint.sh
```

Live checks after starting either product:

```sh
curl -fsS http://localhost:58090/hosting/discovery -o /tmp/onlyoffice-discovery.xml
curl -fsS http://localhost:58090/web-apps/apps/api/documents/api.js -o /dev/null
curl -fsS http://localhost:58091/hosting/discovery -o /tmp/collabora-discovery.xml
docker compose --env-file .env.office.onlyoffice.dev -f deploy/compose.office.dev.yaml --profile office --profile collabora ps -a
```

Both XML documents must contain `proof-key` with current and old RSA components.
The Collabora editor HTML URL is an action's `urlsrc` in its discovery. Fetch that
URL without the query to check static delivery. An ONLYOFFICE WOPI action URL
without `WOPISrc` can return 404; use the static API script above for the asset
smoke check. Do not treat that expected action response as a server outage.

Development verification on 2026-09-06: both servers healthy; discovery modulus
matched the persisted private key; restarting preserved it; independent fresh
compose projects published different keys; both editor assets returned HTTP 200.
The production ONLYOFFICE proxy advertised
`https://drive.example.test/onlyoffice/` and served the API asset. Both Caddy files
validated, and both production compose overlays passed `config --quiet`.
Disposable proof-check containers and volumes were removed. Full document
open/edit/save, multi-user and read-only flows belong to the WOPI host end-to-end
suite; discovery checks alone do not prove those flows.

See the upstream [ONLYOFFICE configuration reference](https://api.onlyoffice.com/docs/docs-api/using-wopi/config/)
and [Docker parameters](https://helpcenter.onlyoffice.com/docs/installation/docs-community-install-docker.aspx).
