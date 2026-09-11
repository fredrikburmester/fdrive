# Install fdrive

This is the installation runbook for a server operator or an agent working on the
Docker host. All paths, hostnames, container names, and usernames below are examples;
replace them with values discovered on the target host. The same procedure applies
on a NAS, a Linux server, or another supported Docker host.

Deployment prepares networking and file access. The web walkthrough then connects
SFTPGo, establishes the fdrive administrator, and selects optional features. It cannot
mount host directories into containers. No storage configuration form is part of onboarding.

## 1. Establish the deployment inputs

Before starting, identify:

| Input | How to determine it |
| --- | --- |
| Checkout and persistent data locations | Use the operator's chosen directories. Preserve an existing checkout, `.env`, database, and data. |
| Browser address | The Docker host's address, normally `http://<server-ip>:8090`. |
| SFTPGo HTTP address | Its HTTP/WebClient/API listener, reachable **from fdrive's API container**. The SFTP protocol port is not an HTTP endpoint. |
| Processing storage, if wanted | The existing host directory containing the SFTPGo files, and the path where SFTPGo sees that directory. See step 3. |

Use an existing SFTPGo service when present. Do not create another instance, reset its
users, move files, or change its configuration as part of installing fdrive. If none
exists, first follow [bundled SFTPGo](REFERENCE.md#bundled-sftpgo).

Prerequisites: Docker Engine with Compose v2, Git, Bash, curl, and outbound access for
image builds/downloads. See the root [README](../README.md#resource-requirements) for
resources and the [ARM64 instructions](REFERENCE.md#native-arm64-embeddings) when applicable.

## 2. Initialize fdrive once

For a new installation:

The repository is private, so an anonymous clone fails. Arrange access first —
an SSH key on an account with access, or a deploy key on this machine — then:

```sh
git clone git@github.com:fredrikburmester/fdrive-web.git /path/to/fdrive
cd /path/to/fdrive/deploy
./init-env.sh
```

The HTTPS form (`https://github.com/fredrikburmester/fdrive-web.git`) works only
with a personal access token that carries that access.

Replace `/path/to/fdrive` with the chosen checkout path. All subsequent commands in
this guide run from its `deploy` directory.

`init-env.sh` creates a private `.env` with two generated secrets. Keep that file and
back it up securely; do not print its contents into logs or reports. For an existing
installation, reuse its `.env`; do not run initialization again or regenerate secrets.

Optional: set `FDRIVE_DATA_DIR` in `.env` to an absolute persistent directory before
first startup. It stores fdrive state; **it does not point the workers at SFTPGo files**.
Keep the same value on updates. Leave `SFTPGO_URL` unset for web onboarding; when it is
set, it seeds the SFTPGo storage provider at startup and pins its address, so the address
can only be changed by changing the variable.

## 3. Prepare file access before offering processing features

Choose the deployment's capability:

- **Browsing only:** no processing mount is required. Connect SFTPGo in the browser and
  skip the processing features. A remote SFTPGo connection alone does not provide workers
  with local files.
- **Processing available:** configure the real storage mount now. This makes thumbnails,
  full-text search, both OCR modes, semantic search, and image search available to select
  later. Mounting storage does not enable any feature or download its models.

For an existing Docker-based SFTPGo, inspect its mounts on the deployment host:

```sh
docker inspect <sftpgo-container> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

Find the mount containing user files, not SFTPGo's configuration/database directory.
For example, if inspection shows `/srv/files -> /srv/sftpgo/data`, add or update these
keys in fdrive's `deploy/.env` (one assignment per key):

```dotenv
FDRIVE_INDEX_SFTPGO_DIR=/srv/files
FDRIVE_INDEX_SFTPGO_PATH=/srv/sftpgo/data
```

| Setting/path | Meaning in this example |
| --- | --- |
| `FDRIVE_INDEX_SFTPGO_DIR` | `/srv/files`: existing directory on the **Docker host**. |
| `FDRIVE_INDEX_SFTPGO_PATH` | `/srv/sftpgo/data`: location **inside SFTPGo**, not a host path. This is already the default. |
| Worker path | `/roots/sftpgo`: fixed destination inside fdrive's workers. Do not put this in either host-path setting. |
| Default account mapping | User `alice` maps to `/roots/sftpgo/alice`, corresponding to `/srv/files/alice` on the host. |

Verify the chosen host directory exists and contains the intended account directories
before starting Docker. Do not create an empty directory just to make a guessed path
exist. With no explicit source, Compose uses `deploy/data/roots/sftpgo`; that fallback
is **not automatically connected to SFTPGo**, even if it exists and reports readable.

The indexer mounts this source read-only. The PDF OCR worker mounts it read-write, but
PDF rewriting stays off until explicitly selected. See [permissions and other storage
layouts](REFERENCE.md#processing-storage-and-permissions) for non-default ownership,
named volumes, and account paths that do not follow the username convention.

## 4. Choose how fdrive reaches SFTPGo

Use one of these HTTP addresses in web onboarding:

- A reachable host address and SFTPGo's published **HTTP** port, such as
  `http://<sftpgo-host>:<http-port>`.
- A container name and internal HTTP port, such as `http://sftpgo:8080`, **only when the
  API container shares that Docker network**. See [existing Docker networks](REFERENCE.md#existing-sftpgo-docker-network).

`localhost` inside the API container means that container, not the Docker host.
Likewise, a container name from a separate Docker network does not resolve automatically.
The standard SFTPGo SFTP port is 2022; do not use it as the HTTP/API URL. Actual HTTP
ports may differ; inspect the existing service rather than assuming a port.

## 5. Start and verify the deployment

```sh
./update.sh
```

The script pulls with fast-forward only, validates configuration, builds, and starts
fdrive. Preserve any configured overlays in `FDRIVE_COMPOSE_FILES` in `.env` so updates
continue using them. Do not add profiles or activation environment variables for the
six optional processing features.

The default publishes port 8090 on all host interfaces. Open
`http://<server-ip>:8090` from another device on the same network. `0.0.0.0` is the
listen address, not a browser URL. Direct LAN HTTP uses the default cookie settings.
For a different port or HTTPS reverse proxy, see [network settings](REFERENCE.md#network-placement--reverse-proxies).

Verify both layers:

1. `./update.sh` finishes successfully and reports container/API health.
2. The setup page opens at the actual browser address from another device. A successful
   localhost health check alone does not verify LAN access.
3. For processing deployments, confirm the actual worker mount after startup:

   ```sh
   docker inspect "$(docker compose -f compose.yaml ps -q indexer)" --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} (writable={{.RW}}){{println}}{{end}}'
   ```

   Its `/roots/sftpgo` source must be the existing file directory selected in step 3,
   with `writable=false` for the indexer. A healthy container alone does not prove this.

## 6. Complete one web walkthrough

1. **Claim:** obtain the one-time setup token from `docker compose -f compose.yaml logs api`
   and enter it privately in the browser.
2. **Connection:** enter the SFTPGo HTTP URL and pass Test connection.
3. **Administrator:** verify a normal SFTPGo **WebClient/file-user account**, including
   its one-time code if required. This account gains fdrive settings access; its SFTPGo
   permissions stay unchanged. SFTPGo WebAdmin credentials are not used here.
4. **Features:** enable or skip each of the six choices. Search OCR extracts text without
   rewriting files; searchable PDF conversion is a separate choice that modifies PDFs
   and retains originals according to its retention settings.
5. **Trash:** enable or skip the SFTPGo recycle-bin integration. Configure and test
   [the SFTPGo rule](../docs/TRASH.md) before enabling it; no processing mount is needed.
6. **ONLYOFFICE:** enable or skip browser document viewing/editing. Confirm the fdrive
   browser address; editing requires an explicit SFTPGo username list. The bundled editor
   starts automatically, without a storage mount. See [Office setup](../docs/OFFICE.md).
7. **Finish:** review choices, then enter the file browser. Until Finish, the UI stays
   on `/setup`. Reload resumes saved choices. Other users simply sign in with their own
   SFTPGo file accounts; they do not repeat the owner walkthrough.

Everything remains editable in **System > Features**. All optional processing starts
off. Enabled features may prepare in the background; models download only when needed.
Browsing remains available if optional processing is blocked or unavailable.

## 7. Confirm the result and hand it over

Report the actual browser URL, running revision, whether processing storage was mounted,
and any failed checks. Never include secrets. The owner chooses feature activation and
PDF rewriting; an installation agent should not select them merely to finish setup.

For selected features, check readiness in System and verify an observable result on an
intended account—for example, a thumbnail or a search result. Do not equate container
health with feature readiness or access to the correct user directory.

## Updates and troubleshooting

For an existing installation:

```sh
cd /path/to/fdrive/deploy
./update.sh
```

Preserve `.env`, configured overlays, data paths, database, and files. Do not delete
volumes or reset onboarding to resolve a deployment error. If changing a storage mount,
update the existing setting and run the update command; changing Compose configuration
requires container recreation, not merely `docker restart`.

| Symptom | Check and resolution |
| --- | --- |
| Browser cannot connect | Check container startup, published port, host address and firewall. An explicit loopback bind allows access only from the host. |
| Test connection fails | Verify the HTTP port and API-container network reachability. Do not substitute the SFTP port. |
| Indexer healthy, account directory fails | Compare the actual worker mount with SFTPGo's file mount. Root readability does not prove the account subdirectory exists. |
| Directory check returns 400/403/404 | Check the requested directory, permissions, and mapping; these responses do not mean the indexer is down. Correct the deployment source first if it points at the fallback directory. |
| Indexer connection timeout/refusal or 5xx | Check indexer startup, its logs, internal network and service health. A folder-mapping form cannot repair a service outage. |
| Files browse but search/thumbnails do not work | Confirm the feature is enabled, worker readiness, and the account's verified directory. Mapping exceptions belong in Account settings, not onboarding. |
| Account status says a folder "is not indexed" | An SFTPGo virtual folder has no fdrive mapping. Map it (or mark it not indexed) in Account; its `mapped_path` must be inside an indexed root first. See [SFTPGo virtual folders](REFERENCE.md#sftpgo-virtual-folders). |
| PDF conversion blocked | Its worker needs readable and writable file access. Normal search/indexing needs only read access. |
| Feature shows "failed" while every container looks healthy | The worker's controller gave up starting it; the reason is in the feature's detail line on **System > Features** and under `detail` in `GET /api/v1/health`. The controller retries on its own after `FDRIVE_RUNTIME_RETRY_AFTER_SECONDS` (default 300), and saving features retries at once. If it keeps failing, read that worker's container logs. See [optional-worker controllers](REFERENCE.md#subsystem-health--self-diagnostics). |
| Indexer unhealthy after the database container was recreated | Expected while postgres is starting; the indexer reconnects on its next health probe once postgres accepts connections. No restart is needed. If it stays unhealthy, postgres itself is not up. |

For further diagnostics, inspect `docker compose -f compose.yaml logs --tail=100 indexer`
and **System** in fdrive. Include configured `-f` overlays when targeting services that
only exist in an overlay. See the [advanced reference](REFERENCE.md) for additional layouts.
