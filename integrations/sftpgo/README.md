# Optional SFTPGo native write enforcement

This image adds `fdrive-local-v1` leases to SFTPGo's local filesystem. It is an
opt-in development integration, not a replacement for the stock deployment image.
The native app continues to use fdrive's desktop API; storage credentials and the
lease token stay on the server.

## Qualification boundary

Use only with **one SFTPGo process owning every mutation of the storage volume**.
SFTP, REST, WebDAV and FTP on that process share the same mutation gate. No second
SFTPGo instance, direct host edits, writable OCR/indexer mount, SMB/NFS server or
other writer may access those files. Keep SFTPGo configuration, databases, backups,
logs, certificates and temporary working directories outside users' storage homes.
The lease cannot fence a process that bypasses SFTPGo.

Native lease users must use local filesystem homes without virtual folders. Other
users' local filesystem writes also participate, including aliases of the same
files. The initial mode rejects encrypted local filesystems. Startup validation forbids
protocol and authentication hooks, plugins, Event Manager commands, cluster mode and
SSH commands that execute external programs. Normal authentication, disabled
accounts, MFA, path permissions, quotas and web-client restrictions still apply.
Trusted administration must preserve these requirements when changing configuration.

Do not enable this on an existing production mount merely by setting the mode.
Qualify its complete writer inventory and exercise recovery on disposable data first.
fdrive's retained backups, operation ledger and native pending copies are still required.
fdrive's retention job reclaims acknowledged backups under a lease after the configured
retention period. This integration does not complete macOS beta qualification.

## Build and enable

From the repository root:

```sh
docker build -t fdrive-sftpgo:local-v1 integrations/sftpgo
```

The build runs Go race tests before producing the image. It pins SFTPGo v2.7.5 at
`9888a3d169aed9011ae6e4f7a97ae735c1643068`, applies `enforcement.patch`, and copies
the new files in `internal/`. The stock image supplies its normal assets and runtime.
No deployment Compose default is changed.

For a qualified instance, use the built image and set:

```text
FDRIVE_SFTPGO_WRITE_ENFORCEMENT=fdrive-local-v1
FDRIVE_SFTPGO_WRITE_USERS=alice,bob
```

Then set that fdrive SFTPGo provider's **Native write enforcement** to
`fdrive-local-v1`, configure persistent `FDRIVE_DESKTOP_STATE_DIR`, and explicitly
grant **Read and write** while pairing/reconnecting the Mac. Leave the provider field
blank for stock SFTPGo. Setting it against an unsupported server cannot publish a
native write: lease acquisition fails before any storage mutation.

## Protocol and failure behavior

Authenticated user endpoint `/api/v2/user/fdrive/lease`:

| Method | Request | Result |
| --- | --- | --- |
| POST | Existing user Bearer token | Protocol name, opaque 64-hex token, 60-second timeout |
| PATCH | Same user's Bearer token and `X-Fdrive-Write-Lease` | Renew the live token for 60 seconds |
| DELETE | Same headers | Release; 204 |

Each leased REST request carries both headers. Tokens are bound to their authenticated
owner and never grant a filesystem permission. fdrive renews every 20 seconds, refuses
unknown protocol/timeout responses, aborts on renewal failure and disables captured
storage handles when the callback ends. Contention and a missing/expired lease become
retryable fdrive responses, preserving the same pending operation instead of reporting a
missing file or content conflict. Requests preserve reverse-proxy URL prefixes
and never follow redirects carrying the lease.

Lease control requests recheck current account and HTTP access restrictions without
occupying a transfer session, so renewal works during uploads for `max_sessions=1`.
Ordinary file requests still obey that limit. Rejected leased file requests return
HTTP 409 with `X-Fdrive-Write-Lease-Error: invalid-or-expired`; fdrive aborts the scope
and returns a retryable storage failure. Ordinary file conflicts retain their meaning.

The process-wide gate deliberately serializes native commits across all users. Acquire
refuses while ordinary writers have an open file or mutation in progress. During a
lease, ordinary mutation calls fail permission checks; reads continue. Expiry or release
rejects new leased calls and subsequent writes on open leased files immediately. Exclusion
is retained until already-admitted handles/calls finish, so a stalled writer can delay
all writes. An expired lease cannot be renewed or reused after another owner acquires.

Native uploads disable backend write buffering and sync before closing. Publication
uses local rename; a cross-device rename fails without copy/remove fallback. fdrive's
destination checks are safe only inside the enforced lease. No optimistic conditional
header fallback is used. This does not claim power-loss atomicity for the whole sequence
of filesystem and PostgreSQL updates; uncertain outcomes retain recovery data.

## Verification and maintenance

`startSftpgo({ enforcedWriteUsers: [...] })` builds this exact source in testkit.
To build once before running several suites, set `FDRIVE_TEST_SFTPGO_WRITE_IMAGE`
to the image freshly built from this checkout. Leave it unset to build automatically;
never point it at an older build when validating source changes.
The SFTPGo integration suite checks open writers, competing protocol mutations, owner
binding, path permissions, virtual-folder rejection, real expiry, renewal and collision
protection. The API integration suite runs native creation/replacement, receipt replay,
conflicts, file/folder Trash and restore against both qualified backends.

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage
pnpm test:integration
```

Do not silently rebase this patch onto a new SFTPGo version. Audit every filesystem
mutation path, open-handle lifetime, external execution path and authentication change;
rerun Go race tests and real protocol/API tests before qualifying a new source pin.

Upstream: [SFTPGo](https://github.com/drakkan/sftpgo/tree/9888a3d169aed9011ae6e4f7a97ae735c1643068).
The overlay uses AGPL-3.0-only SPDX headers. The image includes the complete modified
source, upstream license and notices at `/usr/share/sftpgo/fdrive-source.tar.gz`.
Keep that source available with distributed binaries, along with SFTPGo attribution.
Before exposing the modified service to users, provide them access to the matching
modified source archive; the stock upstream source link alone omits this patch.
