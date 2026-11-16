# Encryption follow-ups

Encryption at rest is the host's ([deploy](../../deploy/README.md#encryption-at-rest)), and
end-to-end encrypted folders work in the web app and FDrive for Mac ([encryption](../ENCRYPTION.md)).
This is what is left. Proposals, not commitments.

## Not yet verified

- **A Mac release.** FdriveKit's tests and the unsigned build pass, but nobody has opened, saved
  or trashed a file of an encrypted folder in Finder against a real server. Do that with a
  development-signed build ([dev app check](../MACOS.md#build-and-verify)) before the next
  release, and pair a Mac with encryption on and off.

## Later

- **Sharing encrypted folders** with other users: look up their recipient, show its fingerprint to
  compare, add them as a marker member, and rotate the folder key for new files when one leaves.
  The marker format allows more members; v1 refuses them.
- **Moving across an encrypted folder's edge in Finder.** The Mac refuses it and asks for a copy;
  the web's re-encrypting move could run in the extension the same way.
- **Large files and video in the browser.** Files over 2 GB open only on the Mac, and video plays
  once it has loaded in full. A service worker that decrypts byte ranges as they stream would lift
  both. Subtitles and videos browsers cannot play are not offered in encrypted folders.
- **Search.** Name search covers the encrypted folder in view, up to 20,000 entries. Searching all
  of a person's encrypted folders, and their contents through an encrypted index a device builds,
  are open.
- **Crypto in a worker.** Keys live outside React state but on the main thread; a dedicated worker
  would keep them out of page script that is not fdrive's crypto.
- **Authenticated contents.** The server can replace a file with one encrypted to the folder's
  public recipient. Signing each file with a key only members hold would make that detectable.
- **End-to-end links** to single files, with the file key in the URL fragment.
- **Client-made thumbnails**, stored encrypted in the folder.
- **Long names** beyond 128 bytes, through Cryptomator's shortened names.
- **Post-quantum keys**, if Swift can match age's hybrid recipients.
- **Restore after a rename.** An item trashed from an encrypted folder that was renamed since
  cannot go back, since its original path no longer reaches the folder.
