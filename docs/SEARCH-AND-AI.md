# Search, Thumbnails & AI

fdrive can index your documents and photos so you can find anything instantly from the top search bar.

All indexing, image processing, and search queries happen **completely locally on your own machine**. No file contents or search queries are ever sent to third-party cloud services.

---

## What It Can Do

When the search profile is turned on, fdrive provides three search capabilities:

### 1. Full-Text Document Search
- Searches both file names and the text **inside** your files.
- Works with PDFs, Word documents (`.docx`), Excel spreadsheets (`.xlsx`), PowerPoint slides (`.pptx`), OpenDocument files (`.odt`), plain text, markdown, and code files.
- Shows relevant snippet previews in search results with matched words highlighted.

### 2. AI Image Search (Find Photos by Description)
- Search your photo collection using natural language descriptions (e.g., *"red sunset over mountains"*, *"receipt from supermarket"*, or *"dog playing in snow"*).
- Uses a local vision AI model (SigLIP 2) to embed pictures so they can be retrieved by meaning rather than just file names.
- Accessible via the **Images** toggle in the search bar.

### 3. Automatic Nightly OCR
- Scans paper documents and receipts saved as PDFs that don't have text layers.
- Runs automatically at night (3:00 AM by default) using OCRmyPDF to add searchable text layers.
- **100% Safe**: Never alters PDFs that already have text, never touches digitally signed PDFs, and keeps backup copies of original files.

### 4. Fast Thumbnails
- Generates fast, lightweight WebP previews for images, videos (frame capture), and the first page of PDFs.
- Cached locally for snappy folder browsing and photo gallery shares.

---

## How to Enable It

Search and AI features are part of the `index` Compose profile:

1. Open `/path/to/fdrive/deploy/.env`.
2. Add `index` to `FDRIVE_PROFILES`:
   ```dotenv
   FDRIVE_PROFILES="index"
   ```
   *(If you also have Office editing enabled, use `FDRIVE_PROFILES="index office"`).*
3. Run:
   ```bash
   ./update.sh
   ```

> [!NOTE]
> **First run download**: On the first start, Docker will download the open-source text and vision AI models (approximately 3 GB). Depending on your internet speed, search and image search may report "Unreachable" or "Loading" for a few minutes while the models download and load into memory.

---

## Managing Search from the Web UI

You don't need to run terminal commands to manage search. As an admin user, open the **System** section in the left sidebar:

- **Indexer**: View how many files have been indexed, see any files that couldn't be read, and click **Reindex** to force a fresh scan of any folder.
- **Search**: View the status of the text embedding engine and database search queries.
- **Image Search**: View how many photos are indexed for visual search, or trigger a rebuild of image embeddings.
- **Thumbnails**: See how much disk space thumbnails are using, trigger a background thumbnail rebuild, or clear the preview cache.
- **OCR**: View recent OCR runs, see how many scanned PDFs were converted, or click **Run now** to start an immediate pass.

---

## Customizing What Gets Indexed

You can tell fdrive to ignore certain folders or adjust scanning settings in `.env`:

```dotenv
# Exclude folders from text extraction (e.g. huge code repositories or temporary folders):
TEXT_EXCLUDE_GLOBS="**/node_modules/**,**/temp/**,**/cache/**"

# Folders OCR should skip (e.g. photos where text recognition isn't useful):
OCR_EXCLUDE_GLOBS="Photos/**,Videos/**"

# What hour of the night OCR runs (0 to 23, default 3 is 3:00 AM):
OCR_HOUR=3

# How often the indexer scans for file changes (in seconds, default 900 = 15 minutes):
SCAN_INTERVAL_SECONDS=900
```

After modifying `.env`, run `./update.sh` to apply the changes.

---

## Technical Details for Developers

If you are developing or need the internal architecture of the indexing pipeline, see:
- [Indexer Architecture Reference](INDEXER.md)
- [OCR Engine Reference](OCR.md)
