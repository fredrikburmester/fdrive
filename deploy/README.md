# Install fdrive

fdrive runs with Docker Compose v2 on any amd64 or arm64 host, such as a Linux server, a NAS
or Unraid (see [resource requirements](../README.md#resource-requirements)). It needs an
SFTPGo server: people sign in with their SFTPGo accounts, and fdrive browses files through
SFTPGo's API. Use your existing SFTPGo as it is. Installing fdrive never needs a second
instance or changes to its users, files or configuration. No SFTPGo yet? Add the
[bundled one](REFERENCE.md#bundled-sftpgo).

Paths and addresses below are examples.

## 1. Download fdrive

```sh
mkdir -p /path/to/fdrive && cd /path/to/fdrive
curl -fsSLO https://github.com/fredrikburmester/fdrive/releases/latest/download/compose.yaml
test -e .env || printf 'FDRIVE_MASTER_KEY=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 32)" "$(openssl rand -hex 32)" > .env
chmod 600 .env
```

`test -e .env` checks whether `.env` already exists. That line creates it with two random
secrets only if it doesn't, so it never replaces your keys.

Run later commands from this folder. `compose.yaml` is the only file you need, and it pulls
published images, so nothing is built on your server. If fdrive is already installed, keep
its folder, `.env` and data.

> [!IMPORTANT]
> Back up `.env` and keep it out of logs and reports. The master key encrypts stored
> credentials, and a lost or replaced key can't be recovered.

**Portainer, Dockge, Unraid's Compose Manager or a NAS app:** create a stack from
`compose.yaml` and set `FDRIVE_MASTER_KEY` (`openssl rand -base64 32`) and
`POSTGRES_PASSWORD` (`openssl rand -hex 32`) in its environment. Also set `FDRIVE_DATA_DIR`
to an absolute path you back up, since the stack's own folder may not be one.

Optional `.env` settings:

- `FDRIVE_DATA_DIR`: where fdrive keeps its database and other state (default `./data`). Set
  it before the first start and keep it on updates. It doesn't point at SFTPGo's files; that's
  step 2.
- `SFTPGO_URL`: leave unset and enter the address during setup. When set, fdrive adds that
  SFTPGo server at startup, and its address can then only change through this variable.

## 2. Mount SFTPGo's files (optional)

Browsing works without this step. Thumbnails, full-text search, both OCR modes, semantic
search and image search read files from disk, so fdrive's workers need SFTPGo's data folder
on this host. Only this step can provide it; the browser setup can't mount folders. Mounting
enables nothing and downloads nothing: you pick features during setup.

Find SFTPGo's volume for user files, not its config or database. In Unraid, that's the Host
Path and Container Path of its data mapping. Otherwise:

```sh
docker inspect <sftpgo-container> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

For `/srv/files -> /srv/sftpgo/data`, set the host path and SFTPGo's container path in
`.env`:

```dotenv
FDRIVE_INDEX_SFTPGO_DIR=/srv/files
FDRIVE_INDEX_SFTPGO_PATH=/srv/sftpgo/data
```

- The host path must directly contain one folder per user: `alice` is read from
  `/srv/files/alice`. Check with `ls` before starting, and don't create an empty folder to
  match a guess.
- SFTPGo's image keeps users in `/srv/sftpgo/data`. If the volume is mounted at
  `/srv/sftpgo`, use its `data` subfolder as the host path.
- `/srv/sftpgo/data` is already the default container path. The workers see the folder at
  `/roots/sftpgo`; never put that path in either setting.
- Without `FDRIVE_INDEX_SFTPGO_DIR`, the workers get an empty `./data/roots/sftpgo`. It isn't
  connected to SFTPGo, even if it reports readable.
- The indexer mounts the folder read-only. The OCR worker mounts it read-write for searchable
  PDF conversion, which stays off until you turn it on.

Other file owners, Docker named volumes or home folders not named after users: see
[permissions and other storage layouts](REFERENCE.md#processing-storage-and-permissions).

## 3. Start fdrive

```sh
docker compose up -d
```

The first start pulls about 3 GB, including the optional workers, which stay idle until a
feature needs them. Features are turned on in the browser, not with Compose profiles or
environment variables.

Open `http://<server-ip>:8090` from another device. Plain HTTP on the LAN works as is. For
another port, or HTTPS behind a reverse proxy, see
[network settings](REFERENCE.md#network-placement--reverse-proxies).

To check the stack:

- `docker compose ps` shows everything running, with `proxy`, `web`, `api` and `db` healthy.
- `curl -f http://localhost:8090/api/v1/health` returns `"status":"ok"`, and the setup page
  opens from another device. The local check alone doesn't prove LAN access.
- If you did step 2, the indexer's `/roots/sftpgo` must come from your folder with
  `writable=false`. A healthy container doesn't prove it:

  ```sh
  docker inspect "$(docker compose ps -q indexer)" --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} (writable={{.RW}}){{println}}{{end}}'
  ```

## 4. Set up fdrive in the browser

fdrive asks for SFTPGo's HTTP address, which the API container must reach: the host's IP and
SFTPGo's HTTP port, such as `http://192.168.1.20:8080`. A container name like
`http://sftpgo:8080` works only when fdrive's API shares SFTPGo's Docker network (see
[existing Docker networks](REFERENCE.md#existing-sftpgo-docker-network)). `localhost` is the
fdrive container itself, and 2022 is SFTPGo's usual SFTP port, not HTTP. Check the real HTTP
port rather than guessing.

The walkthrough:

1. **Claim**: enter the one-time token from `docker compose logs api`.
2. **Connection**: enter SFTPGo's address and pass **Test connection**.
3. **Administrator**: sign in as a normal SFTPGo file user, with its one-time code if it has
   one, not as a WebAdmin. That account gets access to fdrive's settings; its SFTPGo
   permissions stay the same.
4. **Features**: turn each of the six on or skip it. Search OCR doesn't change files.
   Searchable PDF conversion rewrites PDFs and keeps the originals as its retention settings
   say.
5. **Trash**: SFTPGo recycle-bin support. Set up and test [its SFTPGo rule](../docs/TRASH.md)
   first.
6. **ONLYOFFICE**: view and edit documents in the browser. Confirm fdrive's address; editing
   needs a list of SFTPGo usernames. The bundled editor starts on its own. See
   [Office setup](../docs/OFFICE.md).
7. **Finish**: until then, fdrive stays on `/setup`, and a reload keeps your choices.

Trash and ONLYOFFICE don't need step 2. Other people just sign in with their own SFTPGo
accounts. Everything stays editable in **System > Features**. Features start off and download
models only when needed, and browsing keeps working if one is unavailable.

Afterwards, check each enabled feature in **System** and look for a real thumbnail or search
result. Healthy containers don't prove a feature works for a given user.

Installing for someone else? Leave the feature choices, including PDF conversion, to them.
Report the address, the version on the **About** page, whether step 2 was done and any failed
check, without secrets.

## Updates and versions

```sh
docker compose pull && docker compose up -d
```

This moves to the newest [release](https://github.com/fredrikburmester/fdrive/releases) unless
`.env` pins `FDRIVE_VERSION`. When a release changes `compose.yaml`, its notes say so;
download that file again before you update.

| `FDRIVE_VERSION` | What runs |
| --- | --- |
| unset (default) | The newest release |
| a release, such as `0.3.1` | That release |
| `main` | The main branch's latest build, less tested. Use main's [`compose.yaml`](https://raw.githubusercontent.com/fredrikburmester/fdrive/main/deploy/compose.yaml) with it |

You can't go back to an older release once a newer one has migrated the database. Keep `.env`,
overlays, data folders, the database and your files, and don't delete volumes or redo setup to
fix an error. After changing `.env`, run `docker compose up -d`; `docker restart` doesn't
apply it.

## Troubleshooting

- **Can't open fdrive**: check the containers, port, host address and firewall. With
  `FDRIVE_HTTP_BIND=127.0.0.1`, only the host itself can connect.
- **Test connection fails**: check SFTPGo's HTTP port and that the API container can reach it.
  The SFTP port won't work.
- **Indexer healthy, but a user's folder fails**: compare the indexer's mount (step 3) with
  SFTPGo's volume (step 2). A readable root doesn't prove the user's folder is there.
- **Folder check returns 400, 403 or 404**: check the folder, permissions and mapping; the
  indexer isn't down. If it has the empty fallback folder, fix step 2 first.
- **Indexer times out, refuses connections or returns 5xx**: check its startup, logs, network
  and health. A folder mapping can't fix an outage.
- **Browsing works, search or thumbnails don't**: check that the feature is on, its worker is
  ready and the user's verified folder. Per-user exceptions go in **Account**, not setup.
- **A folder "is not indexed"**: it's an SFTPGo virtual folder without a mapping. Map it, or
  mark it not indexed, in **Account**; its `mapped_path` must be inside an indexed root. See
  [SFTPGo virtual folders](REFERENCE.md#sftpgo-virtual-folders).
- **PDF conversion blocked**: its worker needs read-write access. Search only needs read.
- **Feature "failed" while containers look healthy**: its controller gave up starting it. The
  reason is on **System > Features** and in `detail` of `GET /api/v1/health`. It retries after
  `FDRIVE_RUNTIME_RETRY_AFTER_SECONDS` (default 300), or at once when you save features. If it
  keeps failing, read that worker's logs. See
  [optional-worker controllers](REFERENCE.md#subsystem-health--self-diagnostics).
- **Indexer unhealthy after the database was recreated**: expected while Postgres starts; it
  reconnects on its own. If it stays unhealthy, Postgres isn't up.

For more, see `docker compose logs --tail=100 indexer`, **System** in fdrive and the
[advanced reference](REFERENCE.md).

## Installation backups

The stack includes a backup worker with encrypted storage. In **System → Backups**, set the
recovery key, schedules and optional S3/B2 or fileserver destinations. Upload exported
external configuration ZIPs there to include their saved versions. Keep the recovery key and
destination credentials outside fdrive. User files aren't included, so back them up on the
fileserver. See [backups and recovery](../docs/BACKUPS.md), including recovery into a new,
empty database.
