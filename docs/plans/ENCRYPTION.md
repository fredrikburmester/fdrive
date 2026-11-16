# Encryption

Planned 2026-11-14 and simplified 2026-11-16; not started. fdrive on the web and FDrive for Mac
are the only clients this covers. Every choice is [decided](#decided).

## Outcome

- **In transit.** Unchanged: TLS at the proxy, HSTS on every route, and a Mac app that refuses
  plain HTTP except on loopback.
- **At rest.** An operator can make a stolen disk or a copied volume useless, and the install
  docs name every volume that holds file contents or anything derived from them.
- **End to end.** A person sets an encryption password, separate from their sign-in password,
  and creates personal encrypted folders in the web app or in Finder. Names and contents inside
  are encrypted on their device before upload; the server stores ciphertext and never holds a
  key that opens it. In the browser they browse, search by name, upload, open, download, rename,
  copy, move, trash and restore inside the folder, and move files and folders into and out of it;
  in Finder they can also save edits. A
  forgotten encryption password is replaced with their recovery key; without it the folder is
  gone for good. Administrators reset sign-in passwords as today, which never touches encryption.

## Threat model

| Who | Host encryption | Encrypted folder |
| --- | --- | --- |
| Someone with a stolen disk, a copied volume or a host backup | Protected | Protected |
| The owner, an administrator, a shell on the running host, a database dump | Not protected | Names and contents protected; [the server still sees](#what-the-server-still-sees) structure, sizes and access. A database dump allows offline guessing of encryption passwords |
| fdrive's own processing: indexer, OCR, ML server, ffmpeg, AI providers, MCP clients, Office | Reads everything | Never receives a clear name or byte |
| A server that turns hostile and serves a modified web app | Not protected | Not protected for anyone who unlocks in a browser afterwards: the page that takes the encryption password comes from the server it guards against. The signed Mac app cannot be made to send its keys |

The server can also delete entries, swap names inside a folder or serve an older version of a
file without detection; it cannot read, forge or alter contents. The web's limit is inherent to
end-to-end encryption in a browser and is stated where encryption is turned on.

## Current behavior

- TLS terminates at Caddy or an edge proxy ([deploy](../../deploy/README.md)). Passwords are
  checked against scrypt hashes in `app.local_users`, and the secrets fdrive keeps are sealed
  with `FDRIVE_MASTER_KEY` ([authentication](../AUTH.md)).
- [Installation backups](../BACKUPS.md) are [age](https://age-encryption.org/v1) archives to an
  X25519 recipient whose identity the browser generates and the owner keeps. `age-encryption`
  0.3.1 is already a dependency of `apps/web`, `apps/api` and `packages/backup`.
- The files folder holds plain files that writers outside fdrive may change
  ([storage](../STORAGE.md)). Derived data is plaintext too: extracted text, embeddings, EXIF
  and OCR text in PostgreSQL, the indexer's name index, thumbnails, OCR originals, Mac staging
  under `/.fdrive-desktop`, Office data, and paths in logs.
- Every file change goes through one service (`apps/api/src/files/operations.ts`) and the change
  journal (`idx.changes`). Trash keeps each item at `/.trash/<id>/<name>` with a row in
  `app.trash_items`.
- The web uploads files over 8 MiB in resumable 8 MiB pieces through `/fs/upload`. There is no
  client-side crypto outside backups. The Mac app streams originals from the desktop API's
  `/content`, follows the change feed, and pairs with a random code
  (`apps/api/src/desktop/pairing.ts`).

## Encryption at rest

fdrive documents host encryption (LUKS, ZFS native encryption, an encrypted Unraid array) and
does not encrypt the files folder itself: the text, thumbnails and EXIF derived from every file
would still sit in plaintext beside it, a key fdrive held would live in `.env` on the same host,
and plain files would stop being authoritative ([architecture](../ARCHITECTURE.md#boundaries)).

The work is one deploy docs section: each volume, what it holds, and that `.env` and the backup
recovery key do not belong on the volume they protect.

## Encrypted folders

### Format

- **Contents are age files**, encrypted to the folder's X25519 recipient: the format and library
  backups already use. `age -d -i <exported folder identity>` opens any of them without fdrive,
  so the files folder plus a recovery key is a complete backup.
- **Swift.** fdrive takes no third-party Swift crypto dependency. FdriveKit implements the
  X25519 recipient and the payload with CryptoKit (Curve25519, ChaChaPoly, HKDF, HMAC) and
  passes age's published test vectors (C2SP CCTV) and the TS implementation's.

### Keys

- **Encryption password.** Turning encryption on (Account > Encryption) asks for a new
  encryption password of at least 12 characters and the sign-in password, and refuses an
  encryption password equal to it, since the server sees the sign-in password at every sign-in.
- **Account key.** One age identity per user, generated in the browser then. The server keeps
  its public recipient and the identity only as age files: one encrypted with the encryption
  password (age's scrypt recipient), one to the recovery key, one per paired Mac.
- **Recovery key.** A second identity, downloaded or printed and proven by pasting it back, the
  backup recovery key's flow. With it a person sets a new encryption password.
- **Administrators.** Sign-in password resets in System > Users stay as they are and never
  touch keys. Nothing is encrypted to an administrator.
- **Folder key.** One age identity per encrypted folder, encrypted to the account recipient and
  kept in the folder's marker. Contents are encrypted to its recipient; names use a key derived
  from it with HKDF.
- **Web.** Entering the encryption password unlocks. The account identity lives in a dedicated
  worker that does all crypto, and stays on this browser until sign-out, wrapped by a
  non-extractable WebCrypto key in IndexedDB, so a reload does not ask again.
- **Mac.** The Mac generates an age identity at pairing, keeps it in the Keychain group the
  extension shares, and sends its recipient with the pairing request. The connection code
  becomes a digest of that recipient, which both sides compute, so the comparison the person
  already makes authenticates it. The approving browser, unlocked, encrypts the account identity
  to it. The Mac stays unlocked until it is disconnected. Account > Encryption lists devices;
  removing one deletes its copy and its desktop token.

### Layout on disk

- **The folder** carries a `.fdrive-encrypted` marker at its top: format version, folder ID,
  the folder recipient and the encrypted folder identity. Its own name lives in an ordinary
  folder and stays visible. No encrypted folder inside another.
- **Names.** Each entry's name on disk is its encrypted name: AES-256-GCM (native in WebCrypto
  and CryptoKit) under the folder's name key, a random nonce and the folder ID as associated
  data, in lowercase unpadded base32 (homes may sit on a case-insensitive disk) behind a version
  prefix, from the NFC name. That leaves about 130 bytes of UTF-8 per name; longer names are
  refused with a clear message. A name is not bound to its parent, so moves, copies, Trash and
  restore inside the folder stay single storage operations.
- **Collisions.** The server cannot refuse a duplicate name. Clients check the live listing
  before creating or renaming, and show two entries that decrypt to one name side by side (the
  Mac with a suffix).
- **Strays** a writer outside fdrive drops in have names that do not decrypt, and are shown as
  unreadable.

### What the server still sees

The encrypted folder's own name and location; the shape of the tree inside it; each entry's size
(the plaintext's plus 16 bytes per 64 KiB and a header of a few hundred bytes) and rough name
length; modification times; who read or wrote what, and when; and what people search for, since
a query also searches the rest of their files.

### Server

- **Flag.** An installation flag `encryptedFolders` on `/auth/me` beside `index`, and on the
  desktop `/location` beside `changeFeed`.
- **Keys.** Routes to read and replace one's own key copies, in a new `app.*` table (FK covering
  indexes, the backup registry policy and db coverage gate it).
- **Folders.** Create makes the folder and writes the client-built marker as one
  create-if-absent. The marker is hidden from listings, desktop entries and MCP, and no file
  route writes it. A paged listing of every entry under an encrypted folder, from the index,
  serves name search.
- **An allowlist inside encrypted folders.** The API answers only list, upload, download, new
  folder, rename, move and copy within the same encrypted folder, Trash, restore back into it,
  delete, and the desktop routes for the same. Uploads and Mac commits must carry a well-formed
  encrypted name and bytes that start with the age header. Every other route refuses, so share
  links, Office, transcoding, archives, ZIP, AI, MCP reads, thumbnails and any later feature
  stay out without a rule of their own.
- **Lists the server builds** (Recents, favorites, tags, activity, Trash, Storage) carry
  encrypted paths, and clients show names only when they can decrypt them. Photos leave
  encrypted folders out.
- **Indexer and OCR** skip a folder's contents once they see its marker, in Trash too: no text,
  OCR, EXIF, thumbnails, embeddings or name index entries. The indexer still records size,
  mtime and the ciphertext's sha256, so storage usage, limits, folder sizes, name search, the
  change journal and the Mac's version checks keep working.
- **Thumbnails go with their last file.** The indexer deletes a thumbnail once no indexed file
  has its sha256; today the cache is only ever cleared whole, so a photo moved into an encrypted
  folder would leave its thumbnail behind. Its text, embeddings and EXIF already go with its row.

### Web

- **Clear text never leaves the browser**: not in API requests, URLs, logs, error reports or the
  AI chat's `location`. Routes keep the encrypted path; breadcrumbs, titles and rows render
  decrypted names. The chat bubble is hidden inside encrypted folders.
- **Search.** The worker decrypts the folder's names from the paged listing, keeps them while
  unlocked and merges its matches into the server's results.
- **Upload.** The worker encrypts into the usual 8 MiB pieces, so uploads stay bounded and
  resumable.
- **Open and download.** The worker decrypts a whole file in memory. Up to 500 MB it opens in the
  viewer (images, HEIC, PDFs, text, and audio and video the browser plays); a larger file
  downloads instead; over 2 GB the browser says to open it in Finder.
- **Inside the folder** rename, copy, move, Trash and undo work as usual, with names encrypted
  in the worker.
- **In and out.** Moving files or folders into or out of an encrypted folder (Move to, drag, cut
  and paste) is a job in the dock the browser runs, since the server cannot re-encrypt: per file
  it streams the original through the worker, encrypting or decrypting, into a new upload in
  pieces, so size is no limit, then deletes the original for good, not to Trash, so a moved-in
  file leaves no plaintext copy. The original goes only after its copy is published: an
  interrupted move never loses a file, though it can leave both. Folders are recreated first.
  Tags, favorites and share links stay with the original and go with it, and the confirmation
  says so. Copying in or out is the same job without the delete. There is no Undo for these.

### Mac

- **FdriveKit** holds the age subset, the name codec and the marker.
- **Read path.** Enumerations and the change feed decrypt names; the catalog keeps the server
  path beside the display name. `fetchContents` decrypts as it writes the transfer file.
  First-download hashing and version checks stay on ciphertext. Finder's Trash shows decrypted
  names, and Restore puts an item back only inside its encrypted folder.
- **Write path.** Saves and new files encrypt locally, then go through protocol 2's prepare,
  upload and commit under the encrypted name; rename and move inside the folder become server
  moves to a new encrypted name. A Finder copy into the folder arrives as a new file and is
  encrypted like one; a move across the folder's edge is refused with a message to copy instead.
- **Clear text on the Mac.** Downloaded files sit decrypted in File Provider storage like any
  other download, protected by FileVault, and Spotlight may index them. The app says so.
- A Mac paired without a device key, or a server without the flag, shows encrypted folders as
  folders it cannot open, with the reason.

### Later

Proposals, not commitments: sharing encrypted folders with other users (key lookup, fingerprint
checks, members in the marker); moving files across an encrypted folder's edge in Finder;
streaming large files and seeking video through a service worker; content search through an
encrypted index a client builds; end-to-end links to single files with the file key in the URL
fragment; client-made thumbnails; long names; folder key rotation; post-quantum keys.

## Steps

One PR each, with the checks [AGENTS.md](../../AGENTS.md) requires.

1. **Host encryption docs.**
2. **Crypto core.** `packages/crypto` (TS, on `age-encryption`) and the FdriveKit counterpart:
   the age subset, the name codec and the marker, with shared vectors that
   `pnpm test:coverage` and `macos.yml` both run.
3. **Keys.** Table, routes and flag; Account > Encryption with the encryption password, recovery
   key and devices.
4. **Server folders.** Marker routes, the allowlist, indexer and OCR skips, the paged listing,
   thumbnails that go with their last file.
   Integration tests prove no clear name or byte reaches the database, thumbs or logs, and
   every route outside the allowlist refuses.
5. **Web folders.** Create, browse, search, upload, open, download, rename, copy, move, Trash,
   moving in and out; e2e specs.
6. **Mac read path** with the pairing key, then **Mac write path**, each a
   [Mac release](../MACOS-RELEASE.md).

## Complete when

- A person turns encryption on, saves a recovery key, creates an encrypted folder in the
  browser, uploads files, finds one by name, opens an image, a PDF and a video, downloads,
  renames, copies, moves, trashes and restores, and moves a folder of photos in and back out;
  then in Finder opens the same files, saves an
  edit, creates a file and copies one in.
- After an administrator resets their sign-in password, their encrypted folders open with the
  unchanged encryption password; a forgotten encryption password is replaced with the recovery
  key.
- A canary file name and a canary string inside a file, one uploaded into an encrypted folder
  and one moved in, appear nowhere in a database dump, the thumbs volume, the API and indexer logs or the files folder, and `age -d` with the exported
  folder identity decrypts a file copied off the disk.
- The TS and Swift implementations pass the same vectors in CI.

## Decided

- 2026-11-14: host encryption at rest, documented by fdrive; fdrive does not encrypt the files
  folder.
- 2026-11-14: end-to-end encryption per folder, names included, as age files with X25519 keys.
  Post-quantum keys would mean matching age's newer hybrid format in Swift for an unlikely
  attacker.
- 2026-11-14: a paired Mac stays unlocked until it is disconnected; its extension has no window
  to ask for a password from.
- 2026-11-16: a separate encryption password, so administrators reset sign-in passwords as
  today. Using the sign-in password would have changed every password form and made
  administrator-set passwords temporary. The recovery key is the only way back: family recovery
  was rejected because it would let the owner read the folders.
- 2026-11-16: the first version leaves out sharing and streaming in the browser, and the API
  allows a short list of operations inside encrypted folders instead of refusing a long one.
- 2026-11-16: the browser moves files into and out of encrypted folders by re-encrypting them
  itself and deleting the original for good; Finder copies across the edge instead.
