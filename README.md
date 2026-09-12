# fdrive

Current design: [Architecture](docs/ARCHITECTURE.md). Unfinished work: [Plans](docs/plans/README.md).

**fdrive** is a clean, fast web drive for your home server. It connects to your existing [SFTPGo](https://github.com/drakkan/sftpgo) storage so you can browse, upload, preview, and share your files from any browser on your home network, without moving your data into a database or giving up control.

Think of it like Google Drive or iCloud Drive, but running completely on your own hardware, right over your existing files.

![fdrive file browser in dark mode, with folders, favorites, tags, and file details](docs/screenshots/files-list-only-overview.png)

[Explore the screenshots](#screenshots) · [Get started](#quickstart-home-server--lan)

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

## Screenshots

<details>
<summary><strong>Browse and organize files</strong> — file actions, thumbnails, and light mode</summary>

**File actions and tags**

![File browser with context menus for sharing, renaming, moving, tagging, and downloading files](docs/screenshots/files-overview-with-dropdowns.png)

**Thumbnails and view options**

![Tree view with inline image thumbnails and the view and sorting menu open](docs/screenshots/files-thumbnails.png)

**Light mode**

![Photo folder in light mode with image thumbnails and the information sidebar](docs/screenshots/lightmode.png)

</details>

<details>
<summary><strong>Search</strong> — file contents and AI image search</summary>

**File search**

![Search results for budget, with file type filters and matching document contents](docs/screenshots/search-files.png)

**AI image search**

![Image search for car showing a visual match, with image and folder filters](docs/screenshots/image-search.png)

</details>

<details>
<summary><strong>Preview and work with files</strong> — images, code, and Office documents</summary>

**Image lightbox**

![Flower photo in the image lightbox with navigation controls, file information, tags, and favorites](docs/screenshots/image-lightbox-view.png)

**Code viewer and editing controls**

![TypeScript file with syntax highlighting, line numbers, and an edit action](docs/screenshots/code-edit.png)

**Office documents with ONLYOFFICE**

![Word document open inside fdrive through the ONLYOFFICE integration](docs/screenshots/office-edit-view.png)

</details>

<details>
<summary><strong>Share and upload</strong> — shared links and upload status</summary>

**Shared links**

![Shares page showing password protection, gallery presentation, download counts, expiration, and link actions](docs/screenshots/shares.png)

**Upload status**

![Upload status window showing two completed file uploads](docs/screenshots/current-upload-window.png)

</details>

<details>
<summary><strong>Sign in and administer</strong> — login and image search settings</summary>

**Sign in**

![SFTPGo sign-in form with username, password, and one-time code option](docs/screenshots/login.png)

**Image search administration**

![Image search administration showing service status, embedding model, thumbnail count, and rebuild controls](docs/screenshots/image-search-advanced-settings-view-admin.png)

</details>

---

## Quickstart (Home Server / LAN)

If you already have Docker and SFTPGo running on your home server:

### 1. Download and initialize

Repository access and a GitHub SSH key are required while the repository is private.

```bash
git clone git@github.com:fredrikburmester/fdrive-web.git /path/to/fdrive
cd /path/to/fdrive/deploy
./init-env.sh
```

`init-env.sh` creates a private `.env` containing two generated secrets. It never overwrites an existing file.

### 2. Prepare storage and start

For processing features, first point the workers at the existing SFTPGo file directory.
Follow [installation step 3](deploy/README.md#3-prepare-file-access-before-offering-processing-features)
before startup. Browsing-only installations can skip the mount and leave features off.
The default `deploy/data/roots/sftpgo` directory is not automatically connected to SFTPGo.

```sh
./update.sh
```

### 3. Complete the setup walkthrough

From your Mac, phone, or another device on the same network, open **`http://<server-ip>:8090`**. No port-binding or cookie settings are needed. Use the claim token printed in the API log, test your SFTPGo connection, and verify a normal SFTPGo WebClient account. That account becomes the fdrive administrator; its SFTPGo permissions stay unchanged. Choose optional features in the same setup screen, then finish into your files. Storage checks run automatically for enabled features.

Choose thumbnails, full-text search, search OCR, semantic search, image search, and searchable PDF conversion step by step. Trash follows as a separate optional choice; [configure its SFTPGo recycle-bin rule](docs/TRASH.md) before enabling it. ONLYOFFICE follows as another optional choice, with browser viewing and an explicit editor-user list; see [Office setup](docs/OFFICE.md). Both OCR choices appear in onboarding; PDF conversion has its own toggle because it modifies PDFs. All choices remain editable in **System > Features**. Models and processing stay inactive until enabled.

Browsing needs only a reachable SFTPGo server. Processing also needs its files mounted into the workers during deployment. See the [deployment guide](deploy/README.md) for startup and the [advanced reference](deploy/REFERENCE.md) for host mounts and remote access.

---

## Resource Requirements

fdrive is designed to be lightweight by default. You only pay for what you use:

| Setup | Recommended RAM | What you get |
| :--- | :--- | :--- |
| **Core fdrive** | **< 500 MB** | Full file manager, previews, tags, favorites, public shares, and trash. Runs on a Raspberry Pi or low-end NAS. |
| **+ Search & AI** | **~4 GB** | Full-text search inside documents, AI image search (search photos by description), and nightly OCR for scanned PDFs. |
| **+ Office Editing** | **~2 GB** | Collaborative Word, Excel, and PowerPoint editing in the browser via ONLYOFFICE. |

Search & AI is CPU-hungry as well as memory-hungry, and on a shared host that matters more
than the RAM: the indexer, OCR, Tika and the embedding sidecars each ship with bounded
concurrency and optional hard caps. See
[processing worker resource limits](deploy/REFERENCE.md#processing-worker-resource-limits).

---

## Documentation

- 🚀 **[Home Server Setup Guide](deploy/README.md)**: Full step-by-step setup guide, optional add-ons, and LAN configuration.
- 🗑️ **[Trash Setup](docs/TRASH.md)**: Enable safe recycle-bin restore for deleted files.
- 🔍 **[Search, Thumbnails & AI](docs/SEARCH-AND-AI.md)**: How document search, image search, and OCR work.
- 📝 **[Office Documents & Editing](docs/OFFICE.md)**: View and collaboratively edit office files in your browser.
- 🤖 **[AI Assistant Integration (MCP)](docs/MCP.md)**: Connect Claude or Raycast to search and read your files.
- 🔒 **[Advanced Deployment Reference](deploy/REFERENCE.md)**: Custom domain setup, reverse proxies (Caddy / NPM), and security hardening.
- 💻 **[Development Guide](docs/DEVELOPMENT.md)**: Run the dev stack locally and run tests.
- **[Adding a Storage Provider](docs/STORAGE-PROVIDERS.md)**: Implement, register and test a backend.

---

## Why fdrive?

Most self-hosted drives either try to replace your filesystem with their own database (like Nextcloud), or they're too barebones to replace Google Drive or iCloud Drive.

fdrive sits right in the sweet spot:
1. **SFTPGo handles storage & protocols**: SFTP, user management, and permissions are handled by SFTPGo, a rock-solid, battle-tested Go server.
2. **fdrive handles the modern web experience**: A polished, responsive browser UI, fast search, document editing, and mobile-friendly links.

---

## License

[AGPL-3.0](LICENSE). fdrive is built on top of [SFTPGo](https://github.com/drakkan/sftpgo), which it uses unmodified as an external service.
