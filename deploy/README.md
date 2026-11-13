# Install fdrive

fdrive runs with Docker Compose v2 on any amd64 or arm64 host, such as a Linux server, a NAS
or Unraid (see [resource requirements](../README.md#resource-requirements)). It serves one
folder on that host: each user's files are plain files in a folder named after them, so the
host's own backups, rsync, SMB or Syncthing keep working. fdrive keeps its users in its own
database. Coming from SFTPGo? See [upgrading from SFTPGo](#upgrading-from-sftpgo).

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
and `FDRIVE_FILES_DIR` to absolute paths you back up, since the stack's own folder may not be
one.

Optional `.env` settings:

- `FDRIVE_DATA_DIR`: where fdrive keeps its database and other state (default `./data`). Set
  it before the first start and keep it on updates.
- `FDRIVE_FILES_DIR`: the folder with everyone's files (default `files` inside
  `FDRIVE_DATA_DIR`). See step 2.
- `FDRIVE_RUN_AS_UID`: the user ID that owns the files (default `1000`). See step 2.

## 2. Choose the files folder

The files folder holds one folder per user: `alice`'s files are in `<folder>/alice`. fdrive
creates a user's folder when it first needs it, and a folder that already exists becomes the
files of the user with that name. To keep files somewhere other than the data folder, set it
in `.env` before the first start:

```dotenv
FDRIVE_FILES_DIR=/srv/files
```

- The api, backup worker and OCR worker mount it read-write and write as `FDRIVE_RUN_AS_UID`;
  the indexer mounts it read-only and reads as the same user. All of them see it at `/data`.
- Existing files must belong to that user. Check with `ls -ln /srv/files` and set
  `FDRIVE_RUN_AS_UID` to the owner's ID rather than changing ownership. A new, empty folder is
  handed to that user on the first start.
- It must be a folder on this host, such as a local disk or a share the host has mounted.
  Use a path, not a Docker named volume.

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
- `docker compose exec api ls /data` lists the folders in your files folder. An empty list for
  a folder that has files means `FDRIVE_FILES_DIR` points somewhere else.

## 4. Set up fdrive in the browser

The walkthrough:

1. **Claim**: enter the one-time token from `docker compose logs api`.
2. **Account**: choose your username and password. That account is the first user and
   fdrive's administrator. Its files are `<folder>/<username>`, so to keep an existing folder,
   use its name.
3. **Features**: turn each of the six on or skip it. Search OCR doesn't change files.
   Searchable PDF conversion rewrites PDFs and keeps the originals as its retention settings
   say.
4. **Trash**: deleted items wait in each user's Trash before they are removed. See
   [Trash](../docs/TRASH.md).
5. **Server address** and **Office**: the address everyone opens fdrive at, and viewing and
   editing documents in the browser; editing needs a list of usernames. The bundled editor
   starts on its own. See [Office setup](../docs/OFFICE.md).
6. **Review**: until you finish, fdrive stays on `/setup`, and a reload keeps your choices.

Add everyone else under **System > Users**. Everything stays editable in
**System > Features**. Features start off and download models only when needed, and
browsing keeps working if one is unavailable.

Afterwards, wait until each enabled feature shows as ready in **System > Features**, or run
`docker compose exec api node wait-ready.ts`, which returns once they all are. Then look for a
real thumbnail or search result: healthy containers don't prove a feature works for a given
user.

Installing for someone else? Leave the feature choices, including PDF conversion, to them.
Report the address, the version on the **About** page, the files folder and any failed check,
without secrets.

## Updates and versions

```sh
docker compose pull && docker compose up -d
```

This moves to the newest [release](https://github.com/fredrikburmester/fdrive/releases) unless
`.env` pins `FDRIVE_VERSION`. When a release changes `compose.yaml`, its notes say so;
download that file again before you update.

Enabled features restart with the update and can take a few minutes to be ready again.
**System > Features** shows each one's state, or wait in the terminal with
`docker compose exec api node wait-ready.ts`: it returns once every enabled feature is ready,
and after 20 minutes fails and names the ones that aren't.

| `FDRIVE_VERSION` | What runs |
| --- | --- |
| unset (default) | The newest release |
| a release, such as `0.3.1` | That release |
| `main` | The main branch's latest build, less tested. Use main's [`compose.yaml`](https://raw.githubusercontent.com/fredrikburmester/fdrive/main/deploy/compose.yaml) with it |

You can't go back to an older release once a newer one has migrated the database. Keep `.env`,
overlays, data folders, the database and your files, and don't delete volumes or redo setup to
fix an error. After changing `.env`, run `docker compose up -d`; `docker restart` doesn't
apply it.

**Updating from 0.6 or earlier?** Document text extraction and both embedding models now run
in one `ml` container, where there used to be `tika`, `embed` and `image-embed`. Download
`compose.yaml` again, then update with one extra flag, which removes the containers that no
longer exist (those three and three one-time helpers):

```sh
docker compose pull && docker compose up -d --remove-orphans
```

- Nothing is indexed again. The `ml` container downloads its models once more when a feature
  first needs them (about 3.1 GB with every search feature on), so search and image search
  take a few minutes to be ready after this update.
- In `.env`, `FDRIVE_EMBED_THREADS`, `FDRIVE_IMAGE_EMBED_THREADS` and the `FDRIVE_EMBED_*`,
  `FDRIVE_IMAGE_EMBED_*` and `FDRIVE_TIKA_*` limits no longer do anything. Their replacements
  are `FDRIVE_ML_THREADS`, `FDRIVE_ML_CPUS` and `FDRIVE_ML_MEMORY`
  ([resource limits](REFERENCE.md#processing-worker-resource-limits)).
- Once the features show as ready, the old model files can go: the `models` folder in the data
  directory, and `docker volume rm fdrive_fdrive-image-embed-models`. So can the three old
  images, about 2.4 GB for each release still on disk:

  ```sh
  docker image ls --format '{{.Repository}}:{{.Tag}}' \
    | grep -E 'fdrive-(tika|embed|image-embed):' | xargs -r docker image rm
  ```

**Installed from a git checkout?** Releases from 0.3.0 have no `update.sh`. Update from the
checkout's `deploy` folder like any other installation, and move extra Compose files from
`FDRIVE_COMPOSE_FILES` to `COMPOSE_FILE` in `.env`, the list Compose itself reads.

**Used WebDAV or S3 storage?** The files folder is now fdrive's only storage. The update
disables WebDAV and S3 storage and their logins disappear, so copy anything you need from them
into the files folder first. Backups to an S3 bucket keep working.

## Upgrading from SFTPGo

Earlier releases browsed files through SFTPGo. fdrive now serves SFTPGo's data folder itself,
in place, with the same layout, so nothing is copied.

1. Stop SFTPGo, so fdrive is the only one writing the folder.
2. Download `compose.yaml` again. In `.env`, set `FDRIVE_FILES_DIR` to SFTPGo's data folder on
   the host, the one with one folder per user (with the bundled SFTPGo, the `sftpgo/data`
   folder inside `FDRIVE_DATA_DIR`). If `.env` already sets `FDRIVE_INDEX_SFTPGO_DIR`, that
   folder is used and nothing needs to change. Keep `.env`, `FDRIVE_DATA_DIR` and the database as
   they are.
3. If the files aren't owned by user ID 1000, set `FDRIVE_RUN_AS_UID` to their owner
   (`FDRIVE_INDEX_UID` still works). Remove `compose.sftpgo.yaml` and
   `compose.sftpgo-network.yaml` from `COMPOSE_FILE` in `.env`.
4. Run `docker compose pull && docker compose up -d --remove-orphans`.

On the first start:

- The SFTPGo storage becomes the local folder. Every user who has signed in to fdrive before
  keeps their password, but only administrators (the setup owner and anyone marked admin) can
  sign in right away. Everyone else is added disabled, because fdrive can't tell whether
  SFTPGo disabled or removed them since they last signed in: an administrator enables each one
  under **System > Users**. Users who never signed in to fdrive get a password from an
  administrator there.
- The search index carries over.
- SFTPGo share links keep working. Password-protected ones need a new password.
- fdrive's Trash lives in `.trash/.fdrive-move-v1` in each user's folder. Items SFTPGo's
  recycle rule moved to `.trash` stay on disk but aren't listed.
- SFTPGo virtual folders aren't part of anyone's files: theirs stay where SFTPGo kept them.
  Move them into a user's folder to keep them in fdrive.
- `SFTPGO_URL`, `FDRIVE_INDEX_SFTPGO_PATH` and the `SFTPGO_ADMIN_*` settings no longer do
  anything.

Once everyone can sign in, SFTPGo's container and configuration can go. Keep its data folder:
it is fdrive's files folder now.

## Troubleshooting

- **Can't open fdrive**: check the containers, port, host address and firewall. With
  `FDRIVE_HTTP_BIND=127.0.0.1`, only the host itself can connect.
- **A user's files are missing**: their folder must be `<files folder>/<username>`, with the
  same spelling. Compare `docker compose exec api ls /data` with the folder on the host.
- **Uploads or new folders fail**: the files must belong to `FDRIVE_RUN_AS_UID`. At start the
  api logs `cannot write /data` when that user can't write the folder.
- **Indexer times out, refuses connections or returns 5xx**: check its startup, logs, network
  and health. A folder mapping can't fix an outage.
- **Browsing works, search or thumbnails don't**: check that the feature is on and its worker
  is ready.
- **PDF conversion blocked**: its worker needs read-write access. Search only needs read.
- **Feature "failed" while containers look healthy**: its controller gave up starting it. The
  reason is on **System > Features** and in `detail` of `GET /api/v1/health`. It retries after
  `FDRIVE_RUNTIME_RETRY_AFTER_SECONDS` (default 300), or at once when you save features. If it
  keeps failing, read that worker's logs. See
  [optional-worker controllers](REFERENCE.md#subsystem-health--self-diagnostics).
- **Indexer unhealthy after the database was recreated**: expected while Postgres starts; it
  reconnects on its own. If it stays unhealthy, Postgres isn't up.

For more, see `docker compose logs --tail=100 api`, **System** in fdrive and the
[advanced reference](REFERENCE.md).

## Installation backups

The stack includes a backup worker with encrypted storage. In **System → Backups**, set the
recovery key, schedules and optional S3/B2 or folder destinations. Upload exported external
configuration ZIPs there to include their saved versions. Keep the recovery key and
destination credentials outside fdrive. User files aren't included, so back up the files
folder with the host's own tools. See [backups and recovery](../docs/BACKUPS.md), including
recovery into a new, empty database.
