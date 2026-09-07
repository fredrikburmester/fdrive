# Setting up fdrive

This guide puts fdrive in front of the SFTPGo you already run, with **everything
turned on**: files, search, image search, thumbnails, OCR, trash, office editing
and the MCP server, all in one Docker Compose stack.

Follow the steps in order. Every step is one thing. Need the details behind any
of it? See [REFERENCE.md](REFERENCE.md).

## What you need

- A running SFTPGo, and access to its web admin.
- A Linux server with Docker and Docker Compose. It must see the directory
  SFTPGo stores its users' files in, so usually it is the same machine SFTPGo
  runs on.
- About 12 GB of RAM with everything on (the search models are the heavy part).
- A domain name for fdrive, for example `drive.example.com`, and something that
  does HTTPS in front of it: Caddy, Nginx Proxy Manager, Traefik, Cloudflare
  Tunnel, anything. fdrive itself only speaks plain HTTP on `127.0.0.1:8090`.

No SFTPGo yet? `compose.sftpgo.yaml` starts one for you; see
[REFERENCE.md](REFERENCE.md). This guide assumes you have one.

## Step 1: Get the code

```bash
git clone https://github.com/fredrikburmester/fdrive-web.git /opt/fdrive
```

```bash
cd /opt/fdrive/deploy
```

Everything below happens inside `/opt/fdrive/deploy`.

## Step 2: Create your settings file

```bash
cp .env.example .env && chmod 600 .env
```

Generate the two secrets:

```bash
openssl rand -base64 32
```

Run that twice. The first result is your `FDRIVE_MASTER_KEY`, the second your
`POSTGRES_PASSWORD`.

Open `.env` in an editor. It is long, but only the settings below matter. In
`.env.example` most of them are switched off with a `#` in front of the name,
like `#FDRIVE_PUBLIC_URL=`. Remove that `#` and fill in the value.

```dotenv
FDRIVE_MASTER_KEY=<first openssl result>
POSTGRES_PASSWORD=<second openssl result>

FDRIVE_PUBLIC_URL=https://drive.example.com
FDRIVE_COOKIE_SECURE=true

SFTPGO_URL=http://<sftpgo host>:8080
FDRIVE_INDEX_SFTPGO_DIR=<directory on this server that holds the users' home folders>

FDRIVE_ADMIN_USERS=<your SFTPGo username>

FDRIVE_SFTPGO_TRASH_PATH=/.trash
FDRIVE_SFTPGO_TRASH_RETENTION_HOURS=720

ONLYOFFICE_JWT_SECRET=<run: openssl rand -hex 32>

FDRIVE_COMPOSE_FILES="compose.office.yaml"
FDRIVE_PROFILES="index office"
```

About the two SFTPGo lines:

- `SFTPGO_URL` is the address of SFTPGo's HTTP port as seen from a container on
  this server. If SFTPGo runs on the host, `http://172.17.0.1:8080` (Docker's
  host address) usually works. If SFTPGo runs in its own compose project, copy
  `compose.sftpgo-network.example.yaml` to `compose.sftpgo-network.yaml`, put
  that project's network name in it, add the file to `FDRIVE_COMPOSE_FILES`, and
  use the SFTPGo container name, like `http://sftpgo:8080`.
- `FDRIVE_INDEX_SFTPGO_DIR` is the folder that contains one subfolder per SFTPGo
  user. If SFTPGo itself sees that folder at a different path than this server
  does (it runs in a container, say), also set `FDRIVE_INDEX_SFTPGO_PATH` to the
  path SFTPGo sees. The default is `/srv/sftpgo/data`.

Do not leave any `change-me` in the file. The next step refuses to start if you do.

## Step 3: Start everything

```bash
./update.sh
```

This pulls, builds, checks your `.env`, starts every container and waits for
fdrive to report healthy. The first run takes a while: it builds the images and
downloads the search models (a few GB). Later runs are fast.

When it finishes you should see `preflight OK` and a JSON health line at the
bottom. If it stops earlier, the message names the exact `.env` line to fix.

## Step 4: Put HTTPS in front

fdrive listens on `127.0.0.1:8090`. Make your HTTPS proxy forward
`https://drive.example.com` to `http://127.0.0.1:8090`. The proxy must allow
WebSockets and large uploads.

With Caddy on the same server, the whole config is:

```
drive.example.com {
	reverse_proxy 127.0.0.1:8090
}
```

If your proxy runs in its own container (Nginx Proxy Manager is the usual case),
it cannot reach the host's `127.0.0.1`. Set `FDRIVE_HTTP_BIND=0.0.0.0` in `.env`,
point the proxy at the server's LAN address on port 8090, run `./update.sh`
again, and firewall port 8090 from everything but the proxy.

Now open `https://drive.example.com` and sign in with your normal SFTPGo username
and password. Your files are there.

Upload something. It shows up in search a minute later, with a thumbnail if it is
an image. If not, open **System** in the sidebar: each page says exactly what is
missing.

## Step 5: Turn on trash

fdrive never keeps deleted files itself. Trash works by telling SFTPGo to move a
file into a `/.trash` folder instead of deleting it, so it also catches deletes
made over SFTP or WebDAV. You set this up once, in SFTPGo's web admin, and it
applies to every user.

In the SFTPGo admin, open **Event Manager**.

1. Under **Actions**, add one:
   - Name: `fdrive-move-to-trash`
   - Type: **Filesystem**, sub-type **Rename**
   - Rename from: `/{{.VirtualPath}}`
   - Rename to: `/.trash/{{.VirtualDirPath}}/{{.ObjectName}}/{{.Timestamp}}`
2. Under **Rules**, add one:
   - Name: `fdrive-trash`
   - Trigger: **Filesystem events**, event **pre-delete**
   - Path filter: `/.trash/**` with **inverse match** ticked
   - Actions: `fdrive-move-to-trash`, with **execute sync** and **stop on
     failure** ticked

Save both. Reload fdrive, delete a file, and it appears under **Trash** in the
sidebar with Restore and Delete forever.

**Automatic emptying.** fdrive says "removed after 720 hours" because of
`FDRIVE_SFTPGO_TRASH_RETENTION_HOURS`, but SFTPGo has to do the actual removing.
Add one more action and rule:

1. Action `fdrive-trash-retention`, type **Data retention check**, folder
   `/.trash`, retention `720` hours, **delete empty dirs** and **ignore user
   permissions** ticked.
2. Rule `fdrive-trash-retention`, trigger **Schedule**, once a day (for example
   hour `3`, everything else `*`), action `fdrive-trash-retention`.

Keep the retention hours and `FDRIVE_SFTPGO_TRASH_RETENTION_HOURS` the same.

Two things to know: deleting a folder trashes each file inside it one by one,
and overwriting a file (upload over an existing name) is not a delete, so the
old version is not trashed.

## Step 6: Office editing

ONLYOFFICE is already running and documents open in the browser. Editing is off
by default though: everything is view-only until you say who may edit what.

First find the provider id. Sign in to fdrive, then run:

```bash
docker compose -f compose.yaml exec db psql -U fdrive -d fdrive -c "SELECT p.id AS provider_id, i.external_username FROM app.identities i JOIN app.providers p ON p.id = i.provider_id;"
```

Then add a rule to `.env`. This one lets `alice` edit everything in her home:

```dotenv
FDRIVE_OFFICE_EDIT_RULES='[{"providerId":"<provider_id from above>","username":"alice","path":"/","recursive":true,"allow":true}]'
```

Run `./update.sh`. Alice can now edit. Add one object per person. The full rule
format, and how to use Collabora instead of ONLYOFFICE, is in
[docs/OFFICE.md](../docs/OFFICE.md).

## Step 7: Connect an AI assistant (MCP)

Open **Account** in fdrive and create an API token. Give the token to your MCP
client with the URL `https://drive.example.com/mcp` as a bearer token, or use
`https://drive.example.com/mcp/t/<token>` for clients that cannot set headers.
The assistant can then search and read exactly what that user can. Writes stay
off unless you set `FDRIVE_MCP_WRITES=true`. Details in [docs/MCP.md](../docs/MCP.md).

## What is now running

| Feature | Where you see it | Turned on by |
| --- | --- | --- |
| Files, previews, shares, favorites, tags | Everywhere | Always on |
| Full-text and semantic search | The search box | `index` profile |
| Image search (describe a picture in words) | Search box, **Images** toggle | `index` profile |
| Thumbnails and folder overviews | File list and Inspector | `index` profile |
| OCR for scanned PDFs, nightly | System, OCR | `index` profile |
| Trash with restore | Sidebar, **Trash** | Step 5 |
| Office editing | Opening a document | `office` profile plus step 6 |
| MCP server | `/mcp` | Step 7 |

Everything under **System** in the sidebar (Connection, Indexer, Search, Image
search, Thumbnails, OCR) shows one of three states per feature: working,
"Unreachable", or "Not configured: set FDRIVE_X". `docker compose logs api` prints
the same list at every start.

## Updating

```bash
/opt/fdrive/deploy/update.sh
```

That is the whole update procedure. It reads `FDRIVE_COMPOSE_FILES` and
`FDRIVE_PROFILES` from `.env`, so it always restarts the same set of services you
set up. Database migrations run automatically.

## Optional tweaks

All of these go in `.env`, followed by `./update.sh`.

- `TZ=Europe/Stockholm`: the time zone for the nightly OCR pass.
- `OCR_EXCLUDE_GLOBS=Photos/**,Videos/**`: folders OCR should skip.
- `OCR_INCLUDE_GLOBS=alice/**`: only OCR these folders.
- `FDRIVE_INDEX_UID=1000`: the uid SFTPGo writes files as, so the indexer can read
  `700` folders. Change it if your SFTPGo runs as another user.
- `FDRIVE_DATA_DIR=/mnt/big-disk/fdrive`: move Postgres, models and OCR state off
  the default `./data`.
- `FDRIVE_SESSION_TTL_DAYS=30`: how long a login lasts.

## Something is wrong

- **`./update.sh` stops at preflight.** Read the line it printed. It is always a
  leftover `change-me`, a typo in a `FDRIVE_*` name, or a bad `FDRIVE_HOME_TEMPLATE`.
- **Cannot sign in over `http://<ip>:8090`.** Expected. The cookie is HTTPS-only.
  Use the HTTPS domain from step 4.
- **Sign-in fails with a connection error.** `SFTPGO_URL` is not reachable from
  inside the `api` container. Check with
  `docker compose -f compose.yaml exec api wget -qO- $SFTPGO_URL/healthz`.
- **Search says Unreachable.** The `index` profile is not running or is still
  downloading models. `docker compose -f compose.yaml --profile index ps` and
  `docker compose -f compose.yaml logs embed`.
- **Image search says Unreachable.** Same, but the `image-embed` container. It
  needs a few minutes on first start.
- **Search finds nothing, or thumbnails never appear.** `FDRIVE_INDEX_SFTPGO_DIR`
  points at the wrong folder, or `FDRIVE_INDEX_SFTPGO_PATH` does not match what
  SFTPGo sees. System, Indexer shows what it walked.
- **Trash item missing from the sidebar.** `FDRIVE_SFTPGO_TRASH_PATH` is not set,
  or the API was not restarted after setting it.
- **Delete fails with an error.** The SFTPGo rule exists but the rename into
  `/.trash` failed. Check the user has write permission on their home.
- **Office opens but cannot edit.** Step 6. View-only is the default.
- **The editor iframe is blank.** `FDRIVE_PUBLIC_URL` in `.env` does not match the
  address in the browser. Fix it and run `./update.sh` (the web image bakes it in
  at build time).
