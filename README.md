# fdrive

fdrive is a self-hostable web drive that sits in front of an existing [SFTPGo](https://github.com/drakkan/sftpgo) server. Your files stay exactly where they are, on disk, owned by SFTPGo; fdrive adds the browser, the search, the sharing and the editing on top.

It is built for the person who already runs SFTPGo for the SFTP and WebDAV clients and wants a proper web UI, full-text and semantic search across everything, and office editing, without moving the data into yet another app's database.

## Features

- Browse, upload, download, move, rename and delete over SFTPGo's user API, as the signed-in user, with SFTPGo's own permissions enforced.
- Previews for images, video, audio, PDF, text, code and markdown; in-place editing of text and markdown.
- Full-text and semantic search over file contents, with thumbnails, duplicates and folder overviews, backed by a Postgres index that respects every user's SFTPGo scope.
- Tags, favorites and recents that follow files through renames, even renames made over SFTP by other clients.
- Office documents opened and co-edited in the browser through WOPI, with ONLYOFFICE or Collabora, view-only by default and editing granted per operator policy.
- Public share links proxied through fdrive, with passwords, expiry, download limits, list, gallery or download-only presentation, and upload-only drop links.
- Trash with restore, provided by SFTPGo's own Event Manager rule so deletes from any client end up in the same recycle folder.
- Multiple SFTPGo identities linked to one account, with one-click switching and cross-identity favorites and search.
- OCR for scanned PDFs on a nightly pass, so they become searchable.
- A built-in MCP server with per-identity tokens, so an AI assistant can search and read files with exactly the caller's permissions.
- Every archive, ZIP download and OCR pass runs as a job with progress; the UI updates live over server-sent events.

## Documentation

- [Setup guide](deploy/README.md): step by step from an empty server to everything turned on, including trash, search, image search, office editing and MCP.
- [Deployment reference](deploy/REFERENCE.md): every compose file, TLS and network placement, container hardening and pinned images.
- [Office editing](docs/OFFICE.md): ONLYOFFICE and Collabora setup, proof keys, edit policy.
- [Search and indexing](docs/INDEXER.md): what gets indexed, settings, the indexer's internal API.
- [OCR](docs/OCR.md): the nightly pass and its safety guarantees.
- [MCP](docs/MCP.md): tools, tokens and scoping.
- [Authentication](docs/AUTH.md): credential mode, sessions and linked identities.
- [Development](docs/DEVELOPMENT.md): running the dev stack, tests and the trash rule.
- [Architecture and decisions](PLAN.md): the full design, domain model and phased plan.

## Screenshots

Coming with the first tagged release. Until then, the dev stack in [Development](docs/DEVELOPMENT.md) boots a seeded instance in a few minutes.

## Stack

- [Next.js](https://nextjs.org) with [shadcn/ui](https://ui.shadcn.com) for the web app.
- [Hono](https://hono.dev) for the API, on Node 24.
- [Postgres](https://www.postgresql.org) with [pgvector](https://github.com/pgvector/pgvector) for metadata and the search index, migrations owned by [Drizzle](https://orm.drizzle.team).
- A Python indexer using [Apache Tika](https://tika.apache.org), [text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference) and [OCRmyPDF](https://ocrmypdf.readthedocs.io).
- [Caddy](https://caddyserver.com) as the single-origin proxy inside the Compose stack.
- A pnpm and Turborepo monorepo with Vitest, Playwright and Biome.

## Why I built it

I run SFTPGo as the one place all my files live. The web front-ends I tried either wanted to own the files, copied them into their own store, or knew nothing about the content. fdrive is the opposite: SFTPGo stays the source of truth and is never touched below its public API, and everything fdrive adds, index, tags, shares, office sessions, is derived data that can be rebuilt.

## Alternatives

- [Filestash](https://www.filestash.app): a capable web client, office editing included, built to front many storage backends. I only have one, its development is slow, and it lacks the features I use daily: search worth the name, OCR, compressing files, favorites, tags.
- [Nextcloud](https://nextcloud.com): slow and clunky for this purpose, large and heavy, and it does far too many things. It also wants a database between you and your files. I want my files in a plain directory, nothing else.
- [FileBrowser](https://filebrowser.org): a lightweight file manager over a local directory, without SFTPGo's user model.
- SFTPGo's built-in web client: has sharing pages and handles transfers, but lacks previews, search and most other basics of a daily-use file UI.

## Security

- Credential mode only: fdrive never holds an SFTPGo admin token. Each user signs in with their own SFTPGo account; the password is stored encrypted and only ever sent to the exact server it was captured against.
- Every index-backed result is checked against a live read through the user's own SFTPGo session before it is shown, so search can never reveal a file the user cannot open.
- Office editing is deny-by-default; WOPI proof-key verification cannot be switched off.
- Share traffic is proxied; the SFTPGo host is never exposed to a visitor.
- Containers run with dropped capabilities, read-only filesystems where possible and digest-pinned images. See the [deployment reference](deploy/REFERENCE.md).

Found a vulnerability? Please open a private security advisory on GitHub rather than a public issue.

## Status

Under active development and running as my daily driver. Expect the occasional breaking change until the first tagged release; migrations are automatic, and `deploy/update.sh` updates a running stack in place.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](docs/CONTRIBUTING.md) first; the short version is that every change comes with tests and passes `pnpm lint`, `pnpm typecheck` and `pnpm test:coverage`.

## License

AGPL-3.0. fdrive is built on [SFTPGo](https://github.com/drakkan/sftpgo), which it uses unmodified as an external service.
