# @fdrive/web

The web frontend for fdrive, built with **Next.js 16**, **React 19**, **Tailwind CSS 4**, and **shadcn/ui**.

---

## Features

- **Finder-style File Browser**: Fast virtualized list and grid views for smooth scrolling over tens of thousands of files.
- **Instant Previews**: Media viewers for images, video, audio, PDFs, markdown, text, and code files.
- **Command Palette & Search**: Full-text, filename, and AI image search with live preview thumbnails.
- **Office Editing**: Embedded WOPI client integration for ONLYOFFICE and Collabora Online.
- **Public Share Views**: Dedicated, responsive sharing pages with password protection and gallery lightbox.

---

## Development

To run the web app in development mode:

```bash
pnpm --filter @fdrive/web dev
```

The web server starts on `http://localhost:3000` and proxies `/api/*` requests to the API server running on port `3001`.

For full development setup, see [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md).
