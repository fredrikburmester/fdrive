# Encryption

Planned 2026-11-14 and checked against main on 2026-11-16; not started. fdrive on the web and
FDrive for Mac are the only clients this covers.

All choices are [decided](#decided); [trade-offs](#trade-offs) records what each one gave up.

## Outcome

- **In transit.** Unchanged: TLS at the proxy, HSTS on every route, and a Mac app that refuses
  plain HTTP except on loopback.
- **At rest.** An operator can make a stolen disk or a copied volume useless, and the install
  docs name every volume that holds file contents or anything derived from them.
- **End to end.** Family members sign in with the one password they already have. Any of them
  can create an encrypted folder in the web app or in Finder. Names and contents inside are
  encrypted on their device before upload; the server stores ciphertext and never holds a key
  that opens it. Inside the folder they browse, search by name, upload, download, preview
  (seeking in video too), rename, copy, move, trash and restore, in the browser and in Finder,
  and can share the folder with another fdrive user. A forgotten password is reset with their
  recovery key. The owner can restore a sign-in but never open an encrypted folder; without the
  recovery key, the folder is gone for good.

## Threat model

| Who | Host encryption | Encrypted folder |
| --- | --- | --- |
| Someone with a stolen disk, a copied volume or a host backup | Protected | Protected |
| An administrator, a shell on the running host, a database dump | Not protected | Names and contents protected; [the server still sees](#what-the-server-still-sees) structure, sizes and access. A database dump allows offline password guessing |
| The installation's owner | Not protected | Protected: a reset restores someone's sign-in, never their encrypted folders. Only a modified web app (below) gets around that |
| fdrive's own processing: indexer, OCR, ML server, ffmpeg, AI providers, MCP clients, Office | Reads everything | Never receives a clear name or byte |
| A server that turns hostile and serves a modified web app | Not protected | Not protected for anyone who signs in through a browser afterwards: the page that takes the password comes from the server it guards against. The signed Mac app cannot be made to send its keys, but trusts the server for other users' public keys ([verify keys](#sharing)) |

The server can also delete entries, swap names inside a folder or serve an older version of a
file without detection; it cannot read, forge or alter contents. The web's limit is inherent to
end-to-end encryption in a browser and is stated where encryption is set up.

## Current behavior

- TLS terminates at Caddy or an edge proxy ([deploy](../../deploy/README.md)); the Mac app
  refuses non-loopback HTTP and redirects.
- Sign-in sends the password to the API, which checks it against a scrypt hash in
  `app.local_users` and keeps no other copy. Passwords are checked at sign-in, setup,
  Account > Password, System > Users add and reset, and System > Backups' confirmation
  ([authentication](../AUTH.md)). The secrets fdrive keeps (backup destination keys, AI keys,
  share link cookies) are sealed with `FDRIVE_MASTER_KEY`.
- [Installation backups](../BACKUPS.md) go to S3 as [age](https://age-encryption.org/v1)
  archives to an X25519 recipient whose identity the browser generates and the owner keeps.
  `age-encryption` 0.3.1 is already a dependency of `apps/web`, `apps/api` and
  `packages/backup`, with `@noble/hashes` and `@noble/ciphers` installed beside it.
- The files folder holds plain files that writers outside fdrive (OCR, rsync, SMB, Syncthing)
  may change, and fdrive never follows a symbolic link ([storage](../STORAGE.md)). Derived data
  is plaintext too: extracted text, embeddings, EXIF and OCR text in PostgreSQL, the indexer's
  in-memory name index for typo search, thumbnails in `fdrive-thumbs`, OCR originals, Mac
  staging and replaced versions under `/.fdrive-desktop`, Office data, and paths in logs.
- Every file change goes through one service (`apps/api/src/files/operations.ts`) and lands in
  the change journal (`idx.changes`), which feeds the indexer, live updates and the Mac's
  change feed. Trash keeps each item at `/.trash/<id>/<name>` with a row in `app.trash_items`.
- The web sends files over 8 MiB in 8 MiB pieces through `/fs/upload` (`part`, `offset`,
  `final`), which resume after an interruption. Downloads, previews and video stream with
  ranges; `/fs/transcode` pipes videos browsers cannot play through ffmpeg and `/fs/subtitles`
  serves the subtitle files beside them. There is no service worker and no client-side crypto
  outside backups.
- The Mac app streams originals from the desktop API's `/content` and follows the change feed;
  its pairing code is random (`apps/api/src/desktop/pairing.ts`).

## Encryption at rest

fdrive documents host encryption and does not encrypt the files folder itself.

- File contents and what is derived from them live in the files folder, PostgreSQL, thumbs, OCR
  originals, Office data and logs. Encrypting only the files folder would leave the extracted
  text and thumbnails of every file in plaintext beside it. An encrypted host volume (LUKS, ZFS
  native encryption, an encrypted Unraid array) covers all of them with no fdrive code.
- A key fdrive held would sit in `.env` on the same host, so it would protect against the same
  stolen disk as the host volume and nothing more.
- It would undo the decision that plain files stay authoritative
  ([architecture](../ARCHITECTURE.md#boundaries)): writers outside fdrive could no longer read or
  change the folder, OCR could not rewrite originals in place, and every reader, the Rust
  indexer and ffmpeg included, would need the key.

The work is one deploy docs section: each volume, what it holds, and that `.env` and the
backup recovery key do not belong on the volume they protect. Revisit fdrive-managed
encryption if the files folder ever moves to storage the operator does not control.

## Encrypted folders

### Format

- **Contents are age files.** Each file in an encrypted folder is a standard age v1 file
  encrypted to the folder's recipient, the format and library backups already use.
  `age -d -i <exported folder identity>` opens any of them without fdrive, so the files folder
  plus a recovery key is a complete backup.
- **Ranges.** age encrypts 64 KiB chunks with ChaCha20-Poly1305 and a counter nonce, so any
  byte range decrypts once the header is read. `age-encryption` streams but does not seek; the
  web decrypts ranges itself with `@noble/ciphers`, tested against the library's output.
- **Swift.** fdrive takes no third-party Swift crypto dependency. FdriveKit implements the
  X25519 recipient and the payload with CryptoKit (Curve25519, ChaChaPoly, HKDF, HMAC) and
  passes age's published test vectors (C2SP CCTV).
- **Keys are X25519** ([trade-offs](#post-quantum-keys)). The marker carries a format version,
  so a later move to post-quantum keys is a re-encryption job, not a format change.

### Keys

- **One password** ([trade-offs](#one-password-or-two)). The browser turns the login password
  into two values with scrypt, salted with the username: a sign-in value it sends instead of the
  password, and an unlock key it never sends. The server stores a scrypt hash of the sign-in
  value, so neither the password nor the unlock key reaches it. Every place that checks a
  password changes with it: sign-in, setup, Account > Password, System > Users add and reset,
  and System > Backups' confirmation. No upgrade path: existing passwords are set again once.
- **Account key.** One age identity per local user, generated in the browser at their first
  sign-in with a password of their own. The server keeps its public recipient, and the identity
  only wrapped: by the unlock key and by each paired Mac's device key. Keys stay with the
  username like the rest of a removed user's data, so adding the name again is a reset.
- **Recovery key.** Before their first encrypted folder, a person saves a recovery key: a second
  identity, downloaded or printed and proven by pasting it back, the backup recovery key's flow.
  Turning encryption on also asks for a password of at least 12 characters. Changing one's own
  password rewraps the unlock-key copy.
- **The owner never gets in.** Nothing is wrapped to the owner or any administrator, and:
  - **Passwords the owner sets are temporary.** A password chosen in System > Users, at add or
    reset, must be replaced by the person at their next sign-in, before an account key is
    generated or wrapped with it, since the owner knows it.
  - **A reset restores sign-in only.** It never touches keys; encrypted folders stay locked
    until the person enters their recovery key, which rewraps the key under their own password.
  - **Forgot password** on the sign-in page lets a person reset it themselves with their
    recovery key. The browser fetches the recovery copy and a challenge encrypted to the account
    recipient, without learning whether the username exists; decrypting the challenge proves the
    key, and the browser sends the new sign-in value and unlock-key copy. Login rate limits apply.
  - Without the recovery key the folders are gone for good. The person can start over from
    Account > Encryption with a new key; folders others share with them come back when those
    owners add them again.
- **Folder key.** One age identity per encrypted folder, wrapped to each member's account
  recipient and kept in the folder's marker. Contents are encrypted to its recipient; names use
  a key derived from it with HKDF.
- **Web.** Signing in unlocks. The account identity lives in a dedicated worker that does all
  crypto, so keys stay out of React state. It stays on this browser until sign-out, wrapped by a
  non-extractable WebCrypto key in IndexedDB, so a reload does not ask for the password again.
  Signing out deletes it.
- **Mac.** The Mac generates an age identity at pairing, keeps it in the Keychain group the
  extension shares, and sends its recipient with the pairing request. The connection code
  becomes a digest of that recipient, which both sides compute, so the comparison the person
  already makes authenticates the key. The approving browser wraps the account identity to it.
  The Mac then stays unlocked until it is disconnected ([trade-offs](#mac-lock)).
- **Devices** are listed under Account > Encryption. Removing one deletes its wrapped copy and
  its desktop token; it cannot erase a key the Mac already holds, and the page says so.

### Layout on disk

- **The folder.** An encrypted folder carries a `.fdrive-encrypted` marker at its top: format
  version, folder ID, the folder recipient and the folder identity wrapped per member. Its own
  name lives in an ordinary folder and stays visible. No encrypted folder inside another in v1.
- **Names.** Each entry's name on disk is its encrypted name: AES-256-GCM (native in WebCrypto
  and CryptoKit) under the folder's name key, a random nonce, the folder ID as associated data,
  in lowercase unpadded base32 behind a version prefix. Base32 because homes may sit on a
  case-insensitive disk; names are normalized to NFC first. The 255-byte limit leaves about
  130 bytes of UTF-8 for the name, and v1 refuses longer names with a clear message;
  Cryptomator's shortened names (a hash as the name, a sidecar with the ciphertext) are the fix
  if that bites. A name is not bound to its parent, so moves, copies, Trash and restore stay the
  single storage operations they are today. Considered: one encrypted listing file per folder as
  Nextcloud does, which has no length limit but turns every create, rename and delete into a
  compare-and-swap on a shared file.
- **Collisions.** The server cannot see names, so it cannot refuse a duplicate. Clients check
  the live listing before creating or renaming, and show two entries that decrypt to one name
  side by side (the Mac with a suffix) instead of failing the listing as the catalog does for
  clear names.
- **Strays.** A file a writer outside fdrive drops into an encrypted folder has a name that does
  not decrypt. Clients show it as unencrypted, with **Encrypt** to encrypt, upload and delete it.

### What the server still sees

The encrypted folder's own name, location and members; the shape of the tree inside it; each
entry's size (the plaintext's plus 16 bytes per 64 KiB and a header of a few hundred bytes) and
rough name length; modification times; who read or wrote what, and when; and what people
search for, since a query also searches the rest of their files.

### Search

The server cannot search what it cannot read, so search inside encrypted folders runs where the
keys are.

- **Names in the web (v1).** The indexer records encrypted entries, so one paged request returns
  every entry under an encrypted folder with its encrypted name. The worker decrypts them, a few
  thousand in a fraction of a second, keeps them while signed in, and merges its matches into
  the server's results. A saved search runs the same way when it is opened.
- **Names and contents on the Mac (v1).** Finder search finds what macOS already knows: names in
  folders the extension has listed and, through Spotlight, the contents of downloaded files,
  which are decrypted on the Mac.
- **Contents in the web (later).** Needs every file's text on a client. A device that has the
  files would extract their text, build an index, encrypt it to the folder key and store it in
  the folder; the web downloads it and searches in the worker. Costs: that device downloads
  every file, the index lags new uploads, and two devices writing it must merge.
- **Typo, image and semantic search** stay server features and never reach encrypted folders.

### Server

- **Flag.** An installation flag `encryptedFolders` on `/auth/me` beside `index`, and on the
  desktop `/location` beside `changeFeed`, so no client offers what its server lacks.
- **Keys.** Routes to read and replace one's own wrapped copies and to read another user's
  recipient for sharing. The key table is a new `app.*` table, so FK covering indexes, the
  backup registry policy and db coverage gate it.
- **Folders.** Create makes the folder and writes a client-built marker as one create-if-absent;
  a membership change replaces the marker against its current hash. The marker is hidden from
  listings, desktop entries and MCP, and the ordinary file routes cannot write it. A paged
  subtree listing from the index serves name search.
- **Refusals inside an encrypted folder**, in the file operations service and the read routes:
  a name that is not a well-formed encrypted name; an upload or Mac commit whose bytes do not
  start with the age header, so a confused client cannot store plaintext; moves and copies
  across the folder's boundary (clients re-encrypt instead); a Trash restore outside the folder
  the item came from; share links, Office, transcoding and subtitles, archive previews and
  extraction, compress and folder ZIP, AI organize and chat references, MCP reads and
  thumbnails.
- **Lists the server builds** (Recents, favorites, tags, activity, Trash, Storage's largest files
  and duplicates) carry encrypted paths; clients show names only when they can decrypt them,
  and a tag's own name stays clear text. The photos timeline leaves encrypted folders out.
- **Indexer and OCR** skip a folder's contents once they see its marker, in Trash too: no text,
  OCR, EXIF, thumbnails or embeddings, and no entry in the typo name index. The indexer still
  records size, mtime and the ciphertext's sha256, so storage usage and limits, folder sizes,
  name search, the change journal and the Mac's version checks keep working.
- **Uploads in pieces** need no change: the browser sends ciphertext pieces, and resume works as
  for any upload.

### Web

- **Clear text never leaves the browser**: not in API requests, URLs, logs, error reports,
  drag data the server sees or the AI chat's `location`. Routes under `/files` keep the
  encrypted path; breadcrumbs, titles and rows render decrypted names. The chat bubble is hidden
  inside encrypted folders.
- **Upload.** The worker encrypts 64 KiB chunks into 8 MiB pieces, so memory stays bounded
  whatever the file size. Files pasted from the clipboard go the same way.
- **Download and media.** A service worker scoped to one path answers with decrypted streams, so
  the browser's download manager writes large files to disk, dragging a file out to Finder works
  in Chromium, and `<video>` and `<audio>` seek through byte ranges. Check Safari first: if it
  buffers service-worker downloads in memory, cap browser downloads there and point to Finder.
  Images, PDFs and text decrypt into blobs for the viewer; HEIC decoding works on those bytes.
  Videos browsers cannot play stay download-only, and subtitles beside a video are found by
  decrypted name and converted in the browser.
- **Rename, copy and move** compute encrypted names in the worker, batch rename included; copy,
  cut, paste and undo inside the folder use the usual routes. Anything that crosses the folder's
  boundary, a paste or a drag included, is a copy that encrypts or decrypts in the browser, then
  deletes the source once the copy is published, shown as one job in the dock.
- **Not in v1:** thumbnails (icons instead), content search, playing videos browsers cannot
  play, share links, Office, archive previews and folder ZIP.

### Mac

- **FdriveKit** holds the age subset, the name codec and the marker, and runs the TS vectors.
- **Read path.** Enumerations and the change feed decrypt names; the catalog keeps the server
  path beside the display name. `fetchContents` decrypts as it writes the transfer file.
  First-download hashing and version checks stay on ciphertext, which is what the server hashes.
  Finder's Trash shows decrypted names, and **Restore** puts an item from an encrypted folder
  back only inside that folder.
- **Write path.** Saves and new files encrypt locally, then go through protocol 2's prepare,
  upload and commit under the encrypted name; rename and move become server moves to a new
  encrypted name; Move to Trash is unchanged.
- **Clear text on the Mac.** Downloaded files sit decrypted in File Provider storage like any
  other download, protected by FileVault, and Spotlight may index them. The app says so.
- A Mac paired without a device key, or a server without the flag, shows encrypted folders as
  folders it cannot open, with the reason.

### Sharing

- Every user has an account key from their first sign-in, so anyone can be added. The folder
  owner's client fetches the member's recipient, wraps the folder identity to it and replaces
  the marker; the server adds the `app.local_grants` row, and the folder appears under the
  member's `/Shared with me` like any shared folder.
- **Verify keys.** The server could hand over a recipient of its own. Account > Encryption shows
  each person's key fingerprint, adding someone shows theirs to compare outside fdrive, and both
  clients pin a verified fingerprint and warn when it changes.
- Removing a member deletes their wrapped copy and their grant. What they downloaded stays
  readable to them; rotating the folder key for new files is later work.

### Later

Proposals, not commitments:

- Content search in the web through an encrypted index ([search](#search)).
- End-to-end links to single files. An age file key belongs to one file, so `/s/<id>#<file key>`
  opens that file in the browser without the server learning the key. Folders need a per-link
  key and are harder.
- Thumbnails made by the client at upload and stored encrypted in the folder.
- Passkey unlock, long names, folder key rotation with re-encryption, post-quantum keys.

## Steps

One PR each, with the checks [AGENTS.md](../../AGENTS.md) requires.

1. **Host encryption docs.** Independent of everything else.
2. **Crypto core.** `packages/crypto` (TS, on `age-encryption`, `@noble/hashes` and
   `@noble/ciphers`) and the FdriveKit counterpart: password derivation, the age payload with
   ranges, the name codec and the marker, with shared vectors that `pnpm test:coverage` and
   `macos.yml` both run.
3. **Sign-in and account keys.** Derived passwords everywhere a password is checked, temporary
   owner-set passwords, the account key at first sign-in, recovery key, Forgot password, the
   installation flag; Account > Encryption with devices.
4. **Server folders.** Marker routes, refusals, indexer and OCR skips, subtree listing.
   Integration tests prove no clear name or byte reaches the database, thumbs or logs.
5. **Web folders.** Create, browse, name search, upload, download, media, viewer, rename and
   batch rename, copy and move, Trash, crossing the boundary, strays; e2e specs.
6. **Mac read path** with the pairing key, then **Mac write path**, each a
   [Mac release](../MACOS-RELEASE.md).
7. **Sharing** with key verification.

## Complete when

- A person signs in with their one password, saves a recovery key, creates an encrypted folder
  in the browser, uploads files (one over 4 GiB in Safari), finds one by name, plays a video
  with seeking, downloads, renames, copies, moves, trashes and restores, then opens the same
  files in Finder and saves an edit there.
- After the owner resets their password, a person must choose their own before signing in, and
  their folders open only once they enter their recovery key. A person resets a forgotten
  password from the sign-in page with the recovery key alone.
- A canary file name and a canary string inside a file appear nowhere in a database dump, the
  thumbs volume, the API and indexer logs or the files folder, and `age -d` with the exported
  folder identity decrypts a file copied off the disk.
- Tests show the indexer, OCR, ML server, ffmpeg, AI, MCP, Office and share links never read or
  offer encrypted content.
- The TS and Swift implementations pass the same vectors in CI.
- A member reads a shared encrypted folder; after removal they can no longer fetch it.

## Trade-offs

### One password or two

**One password, derived in the browser (chosen).** How Bitwarden signs in.

- Pro: one password, and signing in unlocks; nobody types a second secret.
- Pro: the server still never sees the password or the key.
- Con: every place that checks a password changes, and existing passwords are set again once.
- Con: a weak password is a weak key. With a database dump, someone can guess offline at the
  speed scrypt allows; today a guessed password only opens a login, here it opens the files.
  The 12-character minimum when turning encryption on limits this.
- Con: a forgotten password cannot simply be reset; it needs the recovery key.
- Con: signing in takes about a second longer on slow devices while scrypt runs.

**A separate encryption passphrase.**

- Pro: sign-in stays as it is, and people who never encrypt see no change.
- Pro: the encryption secret can be stronger than the login password.
- Con: two secrets. The second one is used rarely and forgotten, and forgetting it loses data.
- Con: an extra unlock prompt.

**Not an option:** the same password sent as today. The server would see it at every sign-in, so
anyone with the running server could take the key, and it would protect only what host
encryption already does.

**Family recovery** (rejected 2026-11-16): a copy of each person's key wrapped to the owner's, so
the owner's reset could bring back access. It would also let the owner read those folders, which
defeats them.

### Post-quantum keys

**X25519 (chosen).**

- Pro: every age tool and CryptoKit support it, the Swift code stays small, and a file's header
  is a few hundred bytes.
- Con: a future quantum computer could open files copied today. Moving later re-encrypts every
  file's header and cannot protect copies already taken.

**Hybrid ML-KEM-768 + X25519**, which `age-encryption` supports.

- Pro: safe against that future attack.
- Con: FdriveKit must match age's hybrid construction with CryptoKit's ML-KEM, which is newer
  and less tested across implementations; headers grow to about 1.5 KB per file.

Someone who stores a family's ciphertext for decades, waiting for a quantum computer, is an
unlikely attacker.

### Mac lock

**Stays unlocked until disconnected (chosen).**

- Pro: files open in Finder like any cloud drive, and background refresh and other apps' reads
  just work.
- Con: anyone using that Mac account opens the folders; a stolen Mac relies on FileVault and the
  Mac's login password.

**Locks each session behind Touch ID.**

- Pro: folders stay closed until someone proves they are there.
- Con: the extension runs in the background with no window to ask from, so reads fail with
  Finder errors until the app is opened and unlocked; more code.

## Decided

- 2026-11-14: host encryption at rest, documented by fdrive; fdrive does not encrypt the files
  folder.
- 2026-11-14: end-to-end encryption is per folder, and names inside are encrypted.
- 2026-11-14: one password, derived in the browser, with a recovery key as the way back.
- 2026-11-14: X25519 keys, not post-quantum.
- 2026-11-14: a paired Mac stays unlocked until it is disconnected.
- 2026-11-16: no family recovery. The owner can reset a sign-in but never open an encrypted
  folder, and passwords the owner sets are temporary.
