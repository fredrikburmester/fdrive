# Encryption

fdrive leaves encryption at rest to the host's disk ([deploy](../deploy/README.md#encryption-at-rest))
and offers end-to-end encrypted folders in the web app and FDrive for Mac. Inside an encrypted
folder, names and contents are encrypted on the person's device before they upload; the server
stores ciphertext and never holds a key that opens it. Unfinished work is in
[the plan](plans/ENCRYPTION.md).

## Threat model

| Who | Encrypted folder |
| --- | --- |
| A stolen disk, a copied volume, a host backup | Protected |
| The owner, an administrator, a shell on the host, a database dump | Names and contents protected; [the server still sees](#what-the-server-still-sees) structure, sizes and access. A dump allows offline guessing of encryption passwords |
| fdrive's own processing: indexer, OCR, ML, ffmpeg, AI, MCP, Office, share links | Never receives a clear name or byte |
| A server that serves a modified web app | Not protected for anyone who unlocks in a browser afterwards. The signed Mac app cannot be made to send its keys |

The server cannot read anything, but it can delete entries, swap names inside a folder, serve an
older version of a file, or replace a file's contents with something it encrypted to the folder's
recipient, which is public in the marker. Names and the marker are authenticated; contents are
encrypted, not signed.

## Format

The TypeScript implementation is [`packages/crypto`](../packages/crypto/src/) and the Swift one is
[FdriveKit](../apps/macos/Sources/FdriveKit/) (`Age.swift`, `EncryptedFolders.swift`). Both pass
[`packages/crypto/vectors/v1.json`](../packages/crypto/vectors/v1.json), and the TS tests open what
the Swift tests write to `v1-swift.json`. Constants and API schemas are in
[`packages/contracts/src/encryption.ts`](../packages/contracts/src/encryption.ts).

- **Contents** are age v1 files with one X25519 recipient, the folder's: 64 KiB ChaCha20-Poly1305
  chunks after a 168-byte header and a 16-byte nonce. `age -d -i <folder identity>` opens them.
- **Names** on disk are `fe1-` and lowercase unpadded base32 of a 12-byte nonce and the AES-256-GCM
  ciphertext of the NFC name, with `fdrive/name/v1:<folder id>` as associated data. The key is
  HKDF-SHA-256 of the folder identity's scalar, info `fdrive/name-key/v1`. A name is at most 128
  UTF-8 bytes. Base32 keeps names apart on disks that ignore case.
- **The marker** `.fdrive-encrypted` at the top of the folder is JSON: `v`, `id`, the folder
  `recipient`, one member (the owner's account recipient and the folder identity as an age file to
  it) and `mac`, HMAC-SHA-256 of `[v,id,recipient,[[member recipient,key]]]` under HKDF of the
  owner's account identity, info `fdrive/marker-mac/v1`. Clients check the MAC before they use
  the folder key, so a marker the server made for the owner's public recipient fails.

## Keys

- **Account key**: an age identity per login, made in the browser when encryption is turned on
  (Account > Encryption). `app.encryption_keys` keeps its recipient and two age files of it: one
  to the encryption password (age's scrypt recipient, work factor 18) and one to the recovery key,
  a second identity the person downloads and pastes back before setup finishes.
- **Encryption password**: separate from the sign-in password, at least 12 characters, and the
  browser refuses one equal to the sign-in password, which the server sees at every sign-in.
  Turning encryption on, changing the encryption password and resetting all ask for the sign-in
  password again (`createLoginReauthentication`). Administrators' password resets never touch
  keys, and nothing is encrypted to an administrator.
- **Forgotten encryption password**: the recovery key opens the account key and the browser
  stores a copy under a new encryption password. Without it, Reset deletes every key copy;
  encrypted folders stay on disk, unreadable.
- **Folder key**: an age identity per encrypted folder, in its marker.
- **Devices**: a Mac pairing sends a fresh device recipient. The server answers with a random
  `nonce`, and the code both sides show is 64 bits of SHA-256 of `<recipient>\n<nonce>`, so a
  copied recipient shows a different code. The approving browser, unlocked, sends the account
  identity as an age file to the device (`deviceKey`), kept in `app.encryption_device_keys`
  with the Mac's token; removing the device deletes both. Both clients show the account key's
  fingerprint (64 bits of SHA-256 of its recipient) so a person can see that their Mac holds the
  key their browser does.

## Server

- **The guard.** Every storage a request or job reaches is wrapped by `guardEncryptedFolders`
  ([guard.ts](../apps/api/src/encryption/guard.ts)) in `deploymentFilesFolder`. A path inside an
  encrypted folder is refused (`forbidden`, `details.code` `encrypted_folder`) unless the request
  runs inside `withEncryptedAccess`. Only the routes in `ENCRYPTED_WEB_ROUTES`
  ([routes.ts](../apps/api/src/encryption/routes.ts)) and desktop requests that send
  `x-fdrive-encrypted-folders: 1` do; share links, Office, AI, MCP, ZIP, archives, transcoding,
  subtitles and thumbnails never reach inside, and neither does any route added later.
- **What the guard enforces**: the marker is never listed, read or written through storage;
  names below an encrypted folder must be encrypted names; an upload, a piece at offset 0 or a
  Mac publish must start with the age header; moves and copies stay within one encrypted folder;
  an encrypted folder never goes inside another; a restore goes back only to the side of an
  encrypted folder's edge the item was deleted from (`checkRestore`); a zip of a folder leaves
  out every encrypted folder below it.
- **Routes** under `/api/v1/encryption`: status, setup, password, reset, devices, `folders`
  (create a folder and write its client-made marker, refusing nesting, `Shared with me`, Trash and
  fdrive's folders), `folder?path=` (the marker of the folder a path is in) and `entries?path=`
  (every entry below an encrypted folder, walked through storage, at most 20,000).
  `/fs/list` marks encrypted folders `encrypted: true` and adds `encryptedFolder` inside one; the
  desktop listing does the same for the Mac and adds `originalPath` to Trash entries.
  `GET /api/v2/desktop/encryption` gives a Mac its device key.
- **Index-backed lists** (search, photos, Storage's largest files and duplicates, MCP, AI) go
  through `listedVirtualPath`, which leaves out any path with an encrypted name. The change
  journal, live updates and the Mac's change feed still see them. The indexer and OCR skip the
  contents of encrypted folders and drop thumbnails and image embeddings with their last file
  ([indexer](INDEXER.md), [OCR](OCR.md)).
- **Recents, Favorites, tags and My activity** leave out paths with an encrypted name. History
  still records what happens inside an encrypted folder under its stored names. An encrypted
  folder itself can still be a favorite or tagged, since its own name is clear.

## Web

- **Keys** live in `keyStore` ([keys.ts](../apps/web/src/lib/encryption/keys.ts)), outside React
  state, on the main thread. Once unlocked, the account identity is kept in IndexedDB encrypted
  with a non-extractable WebCrypto key until sign-out or Lock, so a reload does not ask again.
- **Listings** decrypt in `useEncryptedView` ([listing.ts](../apps/web/src/lib/encryption/listing.ts)):
  names, types, plaintext sizes and breadcrumbs. A locked folder shows the unlock form; a name
  that does not decrypt shows as a stray. Inside an encrypted folder the tree view is a list,
  thumbnails are off, and Share, Office, Duplicate, Compress, Organize, Chat, Tags and
  Favorites are hidden.
- **Uploads** go through the upload queue: `prepareEncryptedUploads` encrypts names (one per
  folder per batch) and gives each item a `source` that encrypts the file when it starts, sent
  in the usual 8 MiB pieces and kept for a resume.
- **Opening and downloading** decrypt whole files in memory: up to 500 MB in the viewer, up to
  2 GB as a download, larger only on the Mac. Videos browsers cannot play stay download-only, and
  subtitles are not shown. PDFs and text read from `blob:` URLs, which the CSP allows.
- **Moving in and out** (Move to, drag, cut and paste) is `planTransfer`
  ([transfer.ts](../apps/web/src/lib/encryption/transfer.ts)): folders are made first, each file
  is an upload whose source downloads, decrypts or encrypts it, and a moved original is deleted
  for good (into Trash and purged) once its copy is stored, a moved folder once its last file
  has gone. An interrupted move never loses a file; it can leave both.
- **Search** inside an encrypted folder decrypts the names from `entries` and puts its matches
  first; elsewhere search does not look into encrypted folders.

## Mac

See [FDrive for Mac](MACOS.md#encrypted-folders): the device key from pairing in the Keychain,
names decrypted in the catalog, downloads decrypted into the File Provider's storage, saves
encrypted before they upload, and moves across an encrypted folder's edge refused with a
message to copy instead.

## What the server still sees

The encrypted folder's own name and location; the tree's shape inside it; each entry's size
(the plaintext's plus 16 bytes per 64 KiB and about 184 bytes) and rough name length;
modification times; who read or wrote what, and when; and what people search for.
