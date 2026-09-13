# macOS beta qualification

The native read-only implementation is in `apps/macos`; current behavior, architecture,
build/signing steps and limits are in [MACOS.md](../MACOS.md). Search and remote editing
remain outside this release's scope. The development app targets macOS 26+, Apple silicon.

## Distribution gate

- Complete the first [automated release](../MACOS-RELEASE.md), install its DMG and verify its
  Homebrew cask against the private GitHub asset endpoint and the public URL after publication.
- Produce a Developer ID Application signed Release archive, notarize and staple it.
  Local Apple Development signing is verified; no Developer ID Application identity was
  available during implementation. An unsigned CI build does not satisfy this gate.
- Install on a second Mac or fresh account, enable the extension, connect two identities,
  browse/open, disconnect one and manually upgrade while retaining the other domain and IDs.
- Rehearse reboot, extension termination during transfer, crash-temp cleanup and rollback
  to the previous installable version. Verify launch-at-login and wake across real sleep.

## Reliability and scale gate

- Improve/characterize first-open latency for large folders. Real Finder enumeration of
  10,000 placeholders completed without original reads, but system reconciliation took
  several minutes on the development Mac. Server snapshot and catalog regressions also pass.
- Transfer representative PDFs, images, package directories and multi-gigabyte files; measure
  peak memory. Cancel mid-transfer, disconnect/reconnect and simulate low disk. Never expose
  partial downloads as completed content. Add crash cleanup if the rehearsal finds leftovers.
  A 2 GiB zero-filled file passed a live File Provider download and full-byte hash check;
  peak memory and additional content types still need a broader rehearsal.
- Test offline cached files/listings, uncached content, permission revocation, token expiry,
  identity unlink and provider disable in Finder; one failed location must leave another usable.
- Repeat external create/overwrite/rename/move/delete on both providers while connected and
  disconnected, including same-size/same-mtime replacements and folders with cached children.
  Path-only backends cannot identify every change missed between observations; do not claim
  stable identity across an unobserved external delete/recreate or rename.
- Test real editor Save/Save As, attempted upload/mkdir/rename/move/Trash/delete and direct
  filesystem writes. Verify remote bytes stay unchanged and errors settle without retry loops.
  TextEdit's Locked/Duplicate path has a live development rehearsal; broaden to other editors.
- Exercise Unicode, percent signs, case-only differences, unsupported special files and
  colliding names on the target volume. Current behavior is a visible listing failure for
  ambiguous names, with no silent merge or omission.

## Provider validation cost

The current strong validator streams SHA-256 on the server for materialized files. A
60-second refresh can reread every downloaded large file from remote storage. Measure
SFTPGo/WebDAV bandwidth/latency, then tune the interval or introduce trustworthy provider
validators before general beta use. Preserve same-size/same-mtime change detection. Do not
hash the remote tree or download originals to the Mac merely to enumerate metadata.

Multi-process API deployments also need sticky routing or shared transient storage for
five-minute pairing and two-minute listing snapshots. Keep desktop protocol v1 compatible
with shipped clients; migrations must retain metadata IDs or force explicit resynchronization.
