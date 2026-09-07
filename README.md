# fdrive

**fdrive** is a clean, fast web drive for your home server. It connects to your existing [SFTPGo](https://github.com/drakkan/sftpgo) storage so you can browse, upload, preview, and share your files from any browser on your home network, without moving your data into a database or giving up control.

Think of it like Google Drive or iCloud Drive, but running completely on your own hardware, right over your existing files.

---

## Highlights

- **Your files stay yours**: Files remain plain files on your disk, managed by SFTPGo. fdrive never moves, hides, or locks them into a proprietary format.
- **Lightning fast & clean**: Minimalist, distraction-free interface with dark mode, keyboard navigation, and mobile support.
- **Instant previews**: Photos, videos, music, PDFs, markdown, and code files open right in your browser.
- **Smart tags & favorites**: Star items and add custom color tags. They survive renames and moves, even if you rename a file over SFTP or directly on disk.
- **Share with family & friends**: Create password-protected links with expiration dates, download limits, and beautiful photo galleries.
- **Built-in Trash**: Safely restore accidentally deleted files.
- **Modular power-ups**: Keep it featherlight (< 300 MB RAM) for basic browsing, or switch on full-text search, AI image search, OCR, and browser office editing whenever you want.

---

## 2-Minute Quickstart (Home Server / LAN)

If you already have Docker and SFTPGo running on your home server:

### 1. Download fdrive
```bash
git clone https://github.com/fredrikburmester/fdrive-web.git /path/to/fdrive
cd /path/to/fdrive/deploy
cp .env.example .env
```

### 2. Generate two secret keys
```bash
openssl rand -base64 32
openssl rand -base64 32
```

### 3. Edit `.env`
Open `.env` in your favorite editor. For a simple home server on your local network (LAN), you only need to set these lines:

```dotenv
# Paste the two keys you generated above:
FDRIVE_MASTER_KEY=<first-openssl-key>
POSTGRES_PASSWORD=<second-openssl-key>

# Address of your SFTPGo server:
SFTPGO_URL=http://127.0.0.1:8080

# The folder on this machine where SFTPGo keeps user files:
FDRIVE_INDEX_SFTPGO_DIR=/srv/sftpgo/data

# Your SFTPGo username (makes you an admin in fdrive):
FDRIVE_ADMIN_USERS=myusername

# Allow plain HTTP login on your home Wi-Fi:
FDRIVE_COOKIE_SECURE=false
```

### 4. Start it up
```bash
./update.sh
```

Now open your browser to **`http://<your-server-ip>:8090`** and log in with your normal SFTPGo username and password!

---

## Resource Requirements

fdrive is designed to be lightweight by default. You only pay for what you use:

| Setup | Recommended RAM | What you get |
| :--- | :--- | :--- |
| **Core fdrive** | **< 500 MB** | Full file manager, previews, tags, favorites, public shares, and trash. Runs on a Raspberry Pi or low-end NAS. |
| **+ Search & AI** | **~4 GB** | Full-text search inside documents, AI image search (search photos by description), and nightly OCR for scanned PDFs. |
| **+ Office Editing** | **~2 GB** | Collaborative Word, Excel, and PowerPoint editing in the browser via ONLYOFFICE. |

---

## Documentation

- 🚀 **[Home Server Setup Guide](deploy/README.md)**: Full step-by-step setup guide, optional add-ons, and LAN configuration.
- 🗑️ **[Trash Setup](docs/TRASH.md)**: Enable safe recycle-bin restore for deleted files.
- 🔍 **[Search, Thumbnails & AI](docs/SEARCH-AND-AI.md)**: How document search, image search, and OCR work.
- 📝 **[Office Documents & Editing](docs/OFFICE.md)**: View and collaboratively edit office files in your browser.
- 🤖 **[AI Assistant Integration (MCP)](docs/MCP.md)**: Connect Claude or Raycast to search and read your files.
- 🔒 **[Advanced Deployment Reference](deploy/REFERENCE.md)**: Custom domain setup, reverse proxies (Caddy / NPM), and security hardening.
- 💻 **[Development Guide](docs/DEVELOPMENT.md)**: Run the dev stack locally and run tests.

---

## Why fdrive?

Most self-hosted drives either try to replace your filesystem with their own database (like Nextcloud), or they're too barebones to replace Google Drive or iCloud Drive.

fdrive sits right in the sweet spot:
1. **SFTPGo handles storage & protocols**: SFTP, user management, and permissions are handled by SFTPGo, a rock-solid, battle-tested Go server.
2. **fdrive handles the modern web experience**: A polished, responsive browser UI, fast search, document editing, and mobile-friendly links.

---

## License

[AGPL-3.0](LICENSE). fdrive is built on top of [SFTPGo](https://github.com/drakkan/sftpgo), which it uses unmodified as an external service.
