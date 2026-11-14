# fdrive-owned shares

Share links are fdrive's own; how they work is in
[architecture](../ARCHITECTURE.md#accounts-and-storage). One item is open.

## Open: gallery on unindexed storage

A login without `index` (its root is not indexed) has no thumbnails, yet a share
row can hold `presentation: "gallery"`, `auto` resolves to gallery on the client when every
entry is an image, and a page is 200 tiles, each a 404 thumb plus a full download, against a
120-per-minute limit. HEIC and camera raw tiles fall back to an icon.

Recommended: enforce it server-side, not just hidden. `publicMetadata` downgrades the
presentation to `list` for such a login (or `PublicShare` gains `thumbnails: false` and the
client resolves from it), and the share dialog offers gallery only when the login has `index`.
On-demand resizing with a small disk cache is a follow-up, not part of this.

Complete when a share from a login without `index` never renders as a gallery, with an API test
for the downgrade and a web test for the dialog.
