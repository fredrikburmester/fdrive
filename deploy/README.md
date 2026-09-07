# Setting up fdrive on your Home Server

This guide walks you through setting up fdrive with Docker.

We start with the **basic setup** (a fast, lightweight file manager on your home network), and then show you the exact steps to enable the **full setup with all the bells and whistles** (AI document search, photo search by description, nightly OCR, browser office editing, trash, and Claude AI integration).

---

## Hardware Requirements

- **Basic Setup**: < 500 MB RAM (runs on almost anything, including a Raspberry Pi).
- **Full Setup (All Bells & Whistles)**: ~6 GB RAM (runs the local AI text and vision models plus ONLYOFFICE).

---

# Part 1: Basic Setup (2 Minutes)

This gets your core file manager running on your local network (LAN) at `http://<your-server-ip>:8090`.

### Step 1: Download fdrive

Open a terminal on your server:

```bash
git clone https://github.com/fredrikburmester/fdrive-web.git /path/to/fdrive
cd /path/to/fdrive/deploy
```

All commands in this guide are run from inside your deploy directory (`/path/to/fdrive/deploy`).

### Step 2: Create your `.env` file

```bash
cp .env.example .env && chmod 600 .env
```

Generate two secret keys:

```bash
openssl rand -base64 32
openssl rand -base64 32
```

Open `.env` in an editor (e.g. `nano .env`) and set these 5 basic lines:

```dotenv
# Paste the two keys generated above:
FDRIVE_MASTER_KEY=<first openssl key>
POSTGRES_PASSWORD=<second openssl key>

# How fdrive reaches your SFTPGo server:
# If SFTPGo runs on the host outside Docker: http://172.17.0.1:8080
# If SFTPGo runs on another machine on LAN:  http://192.168.1.X:8080
SFTPGO_URL=http://172.17.0.1:8080

# The folder on this machine where SFTPGo stores user files:
FDRIVE_INDEX_SFTPGO_DIR=/srv/sftpgo/data

# Your SFTPGo username (grants admin rights in fdrive):
FDRIVE_ADMIN_USERS=myusername

# Allow plain HTTP access on your home Wi-Fi:
FDRIVE_COOKIE_SECURE=false
```

> [!TIP]
> **Don't have SFTPGo yet?** See [Starting with a fresh SFTPGo](#starting-with-a-fresh-sftpgo) below.

### Step 3: Start fdrive

```bash
./update.sh
```

Once it finishes, open your browser to **`http://<your-server-ip>:8090`** and sign in with your SFTPGo credentials.

You now have a fast, working drive for browsing, uploading, and sharing files!

---

# Part 2: The Full Setup (All the Bells & Whistles)

Once the basic setup works, follow these steps to turn on **everything**:
1. Full-text search inside PDFs, Word docs, and spreadsheets.
2. AI vision search: search photos by description (e.g. "red sports car").
3. Nightly OCR for scanned paper documents.
4. Browser office editing with ONLYOFFICE.
5. Trash and file restoration.

---

### Step 4: Turn on the Full Service Stack in `.env`

Generate an office secret:

```bash
openssl rand -hex 32
```

Open `.env` and add these settings to enable all the companion services:

```dotenv
# 1. Enable ONLYOFFICE:
FDRIVE_COMPOSE_FILES="compose.office.yaml"
ONLYOFFICE_JWT_SECRET=<hex key generated above>

# 2. Enable Search, AI vision embeddings, OCR, and Office together:
FDRIVE_PROFILES="index office"

# 3. Enable Trash display in fdrive:
FDRIVE_SFTPGO_TRASH_PATH=/.trash
FDRIVE_SFTPGO_TRASH_RETENTION_HOURS=720
```

Apply the changes:

```bash
./update.sh
```

*Note: On this run, Docker will download the ONLYOFFICE image and the open-source AI models (about 4 GB total). It may take 3 to 5 minutes depending on your internet speed.*

---

### Step 5: Enable Trash in SFTPGo (2 Minutes)

To make file deletions move to a recycle bin instead of disappearing immediately:

1. Open your **SFTPGo WebAdmin** (typically `http://<sftpgo-server>:8080/web/admin`).
2. Go to **Event Manager** in the left menu.
3. Under **Actions**, click **Add** (`+`):
   - **Name**: `fdrive-move-to-trash`
   - **Type**: `Filesystem`, sub-type `Rename`
   - **Rename from**: `/{{.VirtualPath}}`
   - **Rename to**: `/.trash/{{.VirtualDirPath}}/{{.ObjectName}}/{{.Timestamp}}`
   - Click **Save**.
4. Under **Rules**, click **Add** (`+`):
   - **Name**: `fdrive-trash`
   - **Trigger**: `Filesystem events`, check **pre-delete**
   - **Path filter**: `/.trash/**` and **check "Inverse match"**
   - **Actions**: Select `fdrive-move-to-trash`, check **"Execute sync"** and **"Stop on failure"**
   - Click **Save**.

Now deleting a file in fdrive moves it to **Trash**, where you can restore it anytime.

---

### Step 6: Enable Office Editing Permissions (1 Minute)

By default, office files open in view mode. To grant yourself editing access:

1. Run this command on your server to find your user's `provider_id`:
   ```bash
   docker compose -f compose.yaml exec db psql -U fdrive -d fdrive -c \
     "SELECT p.id AS provider_id, i.external_username FROM app.identities i JOIN app.providers p ON p.id = i.provider_id;"
   ```
2. Copy the UUID returned, and add an edit rule to `.env` (replace with your UUID and username):
   ```dotenv
   FDRIVE_OFFICE_EDIT_RULES='[{"providerId":"<your-uuid>","username":"<your-username>","path":"/","recursive":true,"allow":true}]'
   ```
3. Run:
   ```bash
   ./update.sh
   ```

You can now edit Word, Excel, and PowerPoint documents collaboratively in the browser!

---

### Step 7: (Optional) Connect Claude or Raycast (MCP)

To let AI assistants search and read your files:

1. In fdrive, go to **Account > API Tokens** and create a token.
2. In Claude Desktop, run:
   ```bash
   claude mcp add --transport http fdrive http://<your-server-ip>:8090/mcp --header "Authorization: Bearer <your-token>"
   ```
See [docs/MCP.md](../docs/MCP.md) for full details.

---

### Step 8: (Optional) Remote Access & HTTPS

If you want to access your full fdrive setup from outside your home:

1. Point your reverse proxy (Caddy, Nginx Proxy Manager, or Cloudflare Tunnel) to `http://<your-server-ip>:8090`.
2. In `.env`, set your public domain and turn secure cookies back on:
   ```dotenv
   FDRIVE_PUBLIC_URL=https://drive.yourdomain.com
   FDRIVE_COOKIE_SECURE=true
   ```
3. Run `./update.sh`.

---

## Verification Checklist

To confirm your full setup is healthy:

- **Search**: Open the search bar at the top and type a word inside any text or PDF file.
- **AI Image Search**: Click the **Images** toggle in the search bar and search for a photo by description (e.g. "mountain").
- **Office**: Click any `.docx`, `.xlsx`, or `.pptx` file. It should open inside ONLYOFFICE with full editing controls.
- **Trash**: Delete a test file. Go to **Trash** in the left sidebar and verify it appears with a **Restore** button.
- **System Dashboard**: Open **System** in the sidebar. Indexer, Search, Image Search, Thumbnails, and OCR should all report healthy status.

---

## Updating fdrive

To update fdrive in the future:

```bash
cd /path/to/fdrive/deploy && ./update.sh
```

---

## Starting with a fresh SFTPGo

If you do not have an existing SFTPGo installation:

1. In `.env`, enable the bundled SFTPGo compose file:
   ```dotenv
   FDRIVE_COMPOSE_FILES="compose.sftpgo.yaml"
   SFTPGO_URL=http://sftpgo:8080
   ```
2. Run `./update.sh`.
3. Open `http://<your-server-ip>:8091/web/admin` to create your SFTPGo admin account and your first user.
