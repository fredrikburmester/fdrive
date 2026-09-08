# Real Office acceptance

The opt-in Playwright fixture runs the pinned deployment images against a fresh
Postgres, SFTPGo, API and web app. Alice and Bob are writers; Reader has only list
and download permission. All three use the same physical SFTP home and canonical
home mapping, so coediting must use one durable file UUID.

Use Node 24, pnpm 10.11, Docker Desktop, Python 3, OpenSSH `sftp` and `ssh-keygen`.
Install dependencies in this checkout first. Run each product serially:

```sh
pnpm test:e2e:office
OFFICE_E2E_PRODUCT=collabora pnpm test:e2e:office
pnpm --filter @fdrive/web exec vitest run --coverage --config office-e2e/vitest.config.ts
```

The `Real Office editors` GitHub Actions workflow runs both products in separate
Ubuntu 24.04 jobs daily at 03:17 UTC, on relevant pull requests, and through manual
`workflow_dispatch`. Jobs use Node 24, pnpm 10.11.0, a frozen lockfile and the
production shadow build, with a 45-minute limit. No repository secrets or browser
artifacts are used. The same pinned images and fixture cleanup apply locally and
in CI. Run `pnpm test:e2e:office` locally to reproduce its ONLYOFFICE job, or set
`OFFICE_E2E_PRODUCT=collabora` for its second matrix entry.

`E2E_DEV=1` uses a development web server in this isolated checkout. The default
uses the existing independent build shadow. Never overlap a Turbo command with a
Playwright run in the same checkout. `E2E_API_PORT`, `E2E_WEB_PORT` and
`OFFICE_E2E_PORT` override 39421, 39422 and 59490 (ONLYOFFICE) or 59491 (Collabora).
Development ports 3001, 3002, 58090 and 58091 are rejected. Tests never reuse dev
containers or office volumes.

Each run generates a random temporary Compose project, Office JWT, persisted
proof-key volume and isolated SSH key. SFTP uploads tunnel to port 2022 inside the
owned fixture container using OpenSSH ProxyCommand. This exercises real SFTP
without exposing another host port. The known-hosts file belongs to the temporary
fixture. Cleanup stops API/web, removes fixture containers and volumes, and deletes
temporary credentials and state, including after failures.

Browser traces, videos and screenshots are disabled because editor URLs can carry
short-lived credentials. Do not enable or publish them without token redaction.
The test logs contain operation results, never tokens or editor frame URLs.
`OFFICE_E2E_DIAGNOSTICS=1` retains a failed writer fixture for 60 seconds before
normal cleanup. Failure output includes saved-marker booleans, editor control
state, allowlisted exception identifiers and bounded numeric engine error codes. ZIP
assertions parse saved OOXML and ODF text through SFTPGo. XML text parsing preserves
markers split across legitimate formatting or coauthor runs. Editor toasts alone
do not establish persistence.

## Suite coverage

- UI creation and exact filename round trips, including spaces, Unicode and a
  literal `%20` sequence.
- Real keyboard edits and Save controls, two independently authenticated writers,
  shared file UUID, saved bytes and reopen for DOCX, XLSX and PPTX. Each writer's
  Save completes before the next writer types; both contexts stay open throughout.
  The final presentation edit selects the body placeholder, avoiding a stale title
  caret after the other writer updates that same shape.
- Reader explicitly requests edit mode while a writer is active. Reader edits
  must never be included in the writer's persisted coediting changes.
- Editor rename and Save Copy As persist in SFTPGo; host rename follows trusted
  postMessage notifications without replacing the active editor.
- Equal-size ZIP edits preserve second-resolution mtime over actual SFTP, then a
  fresh editor must show the new content.
- Collabora opens, edits, saves and reopens a real OpenDocument fixture. Reopened
  rendered word count confirms the saved text is loaded.
- Recents and Favorites open the preview and its View in office action preserves
  the selected identity and exact filename. The viewer renders saved text.

The read-only coediting regression initially reproduced a real host authorization
bug: Reader's marker reached saved DOCX bytes through Alice's Save. The host now
rejects Reader's explicit edit request before editor admission, while view mode
still works during Alice's editing session. Alice's saved bytes contain her marker
and no Reader marker. A direct Reader upload denial alone is insufficient.

Fixture admission derives from the known seeded users and permissions in the
shared test fixture. Production defaults to view-only and needs explicit operator
edit grants. The fixture does not infer writable capability from successful reads
or claim an SFTPGo permission-introspection API. See [Office deployment](OFFICE.md).

The suite exposed three other production defects: a zero-slide PPTX template,
ONLYOFFICE's timestamp-based view cache key, and Collabora's missing UTF-8 locale.
The authored PPTX now includes one editable slide with a complete master, layout,
theme and relationships. ONLYOFFICE receives the strong content Version without
optional LastModifiedTime; equal-size, equal-mtime SFTP changes therefore select a
fresh view. Collabora uses the pinned 26.04.3.2.1 locale fix. Image digests come from
`deploy/office/compose.services.yaml`.

A separate deterministic API regression covers writes queued behind rename or
deletion. Every write resolves the current registry row and canonical virtual path
inside its provider transaction, retaining the already resolved credentials. A
queued save follows the renamed UUID; deletion denies the save without recreating
the old path.

ONLYOFFICE's filename input delays its focus selection by 100 milliseconds. The
browser test waits for the observed full-input selection before typing; immediate
fill and Enter can race the editor's own focus callback and restore the old name.
View tests dismiss the editor's normal read-only warning before using its visible
Find control. ONLYOFFICE readiness comes from an actual trusted Document_Loaded postMessage,
with both source and origin checked, never a synthetic editor callback.

The ONLYOFFICE fixture now uses the bundled controller image and polls the real fixture
API for persisted Office activation. Its API seeds an explicit alice/bob editor list;
startup waits for discovery after activation. Collabora retains its dedicated fixture.
