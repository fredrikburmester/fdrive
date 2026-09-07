# Office Documents & Editing

fdrive allows you to view and collaboratively edit **Microsoft Office** (`.docx`, `.xlsx`, `.pptx`) and **OpenDocument** (`.odt`, `.ods`, `.odp`) files directly in your web browser.

It connects to an office document server (either **ONLYOFFICE** or **Collabora Online**) running securely within your own Docker setup.

---

## 1. Quick Setup (ONLYOFFICE)

Office editing is an optional power-up. To turn it on:

### Step 1: Generate a secret key
Run this in your terminal:
```bash
openssl rand -hex 32
```

### Step 2: Add to `.env`
In `/path/to/fdrive/deploy/.env`, add:

```dotenv
ONLYOFFICE_JWT_SECRET=<your 32-character hex key from above>
FDRIVE_COMPOSE_FILES="compose.office.yaml"
FDRIVE_PROFILES="office"
```
*(If you also have Search enabled, combine the profiles: `FDRIVE_PROFILES="index office"`).*

### Step 3: Start ONLYOFFICE
```bash
./update.sh
```

Now when you click any Word, Excel, or PowerPoint file in fdrive, it will open directly in the browser!

---

## 2. Enabling Edit Mode (Permissions)

By default, all documents open in **view-only mode**. This ensures that family members or shared users cannot accidentally overwrite important files.

To allow specific users to edit files:

### Step 1: Find your Provider ID
Run this command on your server to see your user's provider ID:

```bash
docker compose -f compose.yaml exec db psql -U fdrive -d fdrive -c \
  "SELECT p.id AS provider_id, i.external_username FROM app.identities i JOIN app.providers p ON p.id = i.provider_id;"
```

You will see output like:
```
             provider_id              | external_username 
--------------------------------------+-------------------
 04bb0ded-55f9-446b-baaf-207beacef70b | alice
```

### Step 2: Add an Edit Rule in `.env`
Add `FDRIVE_OFFICE_EDIT_RULES` to your `.env` file. For example, to let `alice` edit all files in her drive:

```dotenv
FDRIVE_OFFICE_EDIT_RULES='[{"providerId":"04bb0ded-55f9-446b-baaf-207beacef70b","username":"alice","path":"/","recursive":true,"allow":true}]'
```

- **`providerId`**: The UUID from Step 1.
- **`username`**: The SFTPGo username.
- **`path`**: The folder they can edit (`/` means their entire home directory, or use a subfolder like `/Documents`).
- **`recursive`**: `true` allows editing in all subfolders too.
- **`allow`**: `true` grants edit permission; `false` keeps it read-only.

### Step 3: Apply the Rule
```bash
./update.sh
```

Now when that user opens a document, full editing tools will be available, and changes will be automatically saved back to your files!

---

## 3. Using Collabora Online Instead of ONLYOFFICE

If you prefer Collabora Online (LibreOffice in the browser):

1. In `.env`, configure:
   ```dotenv
   FDRIVE_COMPOSE_FILES="compose.office.collabora.yaml"
   FDRIVE_PROFILES="collabora"
   ```
2. Run `./update.sh`.

---

## 4. Technical Architecture (For Developers)

- **Protocol**: fdrive acts as a [WOPI host](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/rest/) (Web Application Open Platform Interface). The document server runs as an isolated companion container and communicates with fdrive's API over the private Docker bridge network.
- **Security**: WOPI proof-key verification (RSA-SHA256) is always enforced. The document server validates that every callback genuinely originates from the trusted host.
- **Locking & Co-editing**: Concurrent edits are coordinated via file locks in Postgres. Multiple users can co-edit the same document simultaneously, with autosave streaming changes back to SFTPGo.
- For testing and integration verification details, see [docs/OFFICE-TESTS.md](OFFICE-TESTS.md).
