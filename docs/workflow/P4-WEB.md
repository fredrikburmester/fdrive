# P4-WEB

Implementer chunk. Worktree at launch, read WORKING/PLAN §8 and shadcn skill.
Never stash, Git state changes, or delegation. Other workers own API/deployment/DB;
do not edit those. Contracts copied as explicit prerequisites. Own:
apps/web/src/components/office/**, apps/web/src/lib/office/**,
apps/web/src/app/(shell)/office/**, apps/web/src/components/files/**,
apps/web/src/lib/files/**, apps/web/src/lib/api/office-queries*.ts,
apps/web/e2e/office.spec.ts and test fixtures/helpers for it. Do not edit existing
API/client/contracts or global CSS. Components must use existing shadcn primitives;
new visible primitives only through shadcn CLI, token colors, lucide icons.

Use pinned contracts in office.ts: officeStatus, officeOpen, officeCreateDocument.
Status query cached/deduplicated. Hide office-specific creation/actions when
unavailable; existing browser/text-editor behavior stays usable. Opening a docx,
xlsx,pptx/ODF through ordinary Open should use office view when discovery supports
it. Retain existing native viewers for text/PDF/images/media. Single-file menu
adds View in office, Edit in office, Convert and edit according to discovery.
Multiple selection must not dispatch ambiguous office actions. Read-only View
always explicitly requests view. Edit is a deliberate action, not inferred from
file stat. Display denied operations accurately through standard error UI.

New menu adds Document, Spreadsheet, Presentation. Reusable shadcn dialog chooses
OOXML/ODF format and filename (defaults Untitled.docx/.xlsx/.pptx). Validated safe
filename, inline error, pending state; successful create invalidates parent
listing and opens edit. Existing text/markdown creation unaffected.

Route `/office/:identity/*path?mode=view|edit|convert` (Next catch-all) renders
office page with slim shared header, breadcrumb/back-to-folder and Download.
Identity must belong to signed-in account. Use per-request identity client/header,
not global mutable default. Do not silently open under a different active identity.
Use normal encoded path helpers; unsupported/deleted/revoked/expired opens show
clear recovery controls. Route defaults view. Response path/file ID used only
after API authorization, no raw metadata paths in UI.

Fetch open descriptor client-side, keep token only in memory. Form POST hidden
inputs into uniquely named iframe, target matches iframe name. No token in
browser history, URL, localStorage, logs, screenshots/test output. iframe sandbox
minimum editor capabilities (forms/scripts/same-origin/popups/downloads/modals
as required), allow clipboard/fullscreen if needed, descriptive title, no-referrer.
Hidden native form/input plumbing is permitted; visible controls are shadcn.
Never render access token or WOPI diagnostic fields to user. Prevent duplicate
form submit on React strict-effect replay; new descriptor can intentionally
submit after retry. Avoid spinner hanging forever on denied iframe/session.

PostMessage handling validates BOTH descriptor editorOrigin and iframe source;
parse only recognized messages. Close returns to parent; File_Rename updates
display/current route only after trusted server file/path check; Save As/conversion
uses allowed same-origin host URLs, never arbitrary redirect from message. Save
status may be shown only when actual editor event supports it; no fabricated Saved
badge based on timeout. Clean event listeners/timers on unmount.

Tests: path/mode helpers, message origin/source filtering, hidden form fields and
safe target, view/edit/convert actions, unavailable feature, create/collision/error,
identity isolation. Playwright office spec should eventually use real office stack;
do not add it to ordinary fake-stack run until explicit fixture exists. Parent
owns real-editor acceptance and will supply tested service. Unit tests can mock
typed API responses with clearly test-only tokens. No screenshot of real token.

Run web typecheck, full web coverage, Biome changed files; existing Playwright
browser actions if affected (serial after Turbo, unique ports). Do not change
unrelated e2e selectors to hide regressions. Report files/gates/assumptions/gaps,
branch/checkout. Send interface gaps immediately while continuing independent UI.
