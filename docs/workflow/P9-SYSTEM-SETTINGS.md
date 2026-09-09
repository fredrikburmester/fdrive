# P9 System settings restructure and event log (requested 2026-09-09)

The admin System area grew one page at a time. Features mixed six toggles with Trash, the
public address and ONLYOFFICE cards plus the walkthrough; Connection skipped the shared
layout and also listed shared folders that are created on the Account page; feature pages
gated on the page title string; there were no logs anywhere. Decisions:

1. Per-feature settings live on the feature page, in a side Sheet opened from a "Settings"
   header button. Features is toggles only; every card links to its page.
2. Connection becomes **General** (`/system/general`): fdrive public address, SFTPGo
   connection, home template, Trash. `/system/connection` redirects there.
3. Office becomes a feature card on Features plus its own `/system/office` page. It is
   **not** a new `FeatureId`: it keeps `office.configuration`, its revision, provider binding
   and `off | starting | ready | unavailable` status. The page gates on `configuration.enabled`.
4. Shared folders get `/system/shared-folders`.
5. A Postgres-backed per-subsystem event log with a `LogSheet` (level filter, copy, download)
   on every feature page. The Indexer "Recent errors" list is replaced by it.

## Information architecture

| Route | Content | Icon |
| --- | --- | --- |
| `/system/features` | six toggles with "Open" links, Office card, Run walkthrough | `ToggleRight` |
| `/system/general` | Server address, SFTPGo connection, Home template, Trash | `Settings2` |
| `/system/shared-folders` | mapping review and remove; pointer to Account | `FolderSymlink` |
| `/system/thumbnails` | status, stats, actions, Logs | `Image` |
| `/system/indexer` | status, stats, tables, actions, Settings sheet, Logs | `Database` |
| `/system/search` | status, stats, actions, Logs | `Search` |
| `/system/ocr` | schedule, stats, actions, Settings sheet, Logs | `ScanText` |
| `/system/image-search` | status, stats, actions, Logs | `Images` |
| `/system/office` | status, stats, editors, Settings sheet, Logs | `FileText` |

Sidebar items are wrapped in `SidebarMenuItem`. Feature page headers render
`[actions] [Settings] [Logs]`, all hidden while the page's feature is off.

## Web primitives (`apps/web/src/components/system/`)

- `SystemSection { title, description?, actions?, children?, className?, contentClassName? }`:
  Card with a header row and right-aligned actions. Replaces the hand-written Card blocks.
- `StatGrid { stats: StatCardProps[], columns?: 2|3|4|5 }` around the existing `StatCard`.
- `SettingsSheet { title, description?, open, onOpenChange, dirty, invalid, pending, onSave,
  onReset, validationMessages?, children }` and `SystemSettingsButton`. Right Sheet,
  `sm:max-w-md`, scrollable body, Save/Reset footer (`SettingsFormActions` extracted from
  `SettingsFormShell`). Closing while dirty asks "Discard unsaved changes?".
- `SystemPage` gains `feature?: FeatureId | readonly FeatureId[]` (any on = visible) and
  `enabled?: boolean`; the title-string map is removed. Off-panel copy is unchanged.
- `lib/system/pages.ts`: `FEATURE_PAGES: Record<FeatureId, { href, label }>` and `OFFICE_PAGE`,
  shared by feature cards and the sidebar.
- `lib/system/walkthrough.ts`: `WALKTHROUGH_STEPS` (`feature` x6, `trash`, `publicUrl`,
  `office`, `review`), `WALKTHROUGH_STEP_OFFSET = 3`, `WALKTHROUGH_TOTAL = 13`,
  `walkthroughLabel(step)`. A test pins `WALKTHROUGH_STEPS.length - 1 === 9`, the contract's
  `walkthroughStep` bound. The wizard keeps its Trash, Server address and Office steps.
- Office draft logic is extracted to `useOfficeSettingsDraft()` + `OfficeSettingsFields`
  (`office-settings-card.tsx`), used by the wizard card and the page sheet.
- Indexer and OCR drafts are only reseeded from polled data while not dirty, so the 5 s poll
  cannot wipe edits in an open sheet.

## Event log

Storage: `app.system_events { id bigserial, at timestamptz, subsystem text, level text,
message text, data jsonb null }`, index `(subsystem, at desc, id desc)`. Written only by the
API. Retention: newest 2000 rows per subsystem, pruned opportunistically on every 50th insert.
Reads merge sidecar history already in Postgres: `idx.scans` and `idx.files`
(`text_status='error'`) for `indexer`; `idx.ocr_runs` and `idx.ocr_log` failures for `ocr`.
The sidecars are unchanged; they may write the table directly later.

Contract (`packages/contracts/src/system.ts`):

- `SystemLogSubsystem = indexer | search | ocr | thumbnails | image-search | office`
- `SystemLogLevel = info | warn | error`; `SystemLogSource = api | indexer | ocr`
- `SystemLogsQuery { limit: int 1..1000 (default 200, clamped), level: minimum level
  (default info), before?: ISO datetime }`
- `SystemLogEntry { id, at, level, message, data?, source }`
- `SystemLogsResponse { subsystem, entries (newest first), nextCursor? }`; `nextCursor` is
  the last entry's `at` and is set only when the page is full. Entries sharing an identical
  `at` across a page boundary can be skipped; acceptable for a log viewer.
- Route `systemLogsRoute(subsystem)` = `GET /api/v1/system/{subsystem}/logs`, admin only.
  Client `systemLogs(subsystem, query?)`.

API: `apps/api/src/system/event-log.ts` `SystemEventLog.record(subsystem, level, message,
data?)`, fire-and-forget, failures are logged and swallowed; `noopSystemEventLog` for tests.
Constructed in `composition.ts` after `createRepos`; injected into system routes, the feature
service and the office settings service (optional, defaulting to noop).

| Source | subsystem | level | message |
| --- | --- | --- | --- |
| PUT indexer / ocr settings | indexer / ocr | info | `Settings updated` (data: changed keys) |
| POST reindex, thumbnails rebuild, image-embedding rebuild, ocr run, search reembed | respective | info | `<action> requested` |
| POST index clear, thumbnails clear, image-embedding clear | respective | warn | `<action> requested` |
| sidecar action failure | respective | error | `<action> failed: <detail>` |
| feature value changed | thumbnails, textSearch, searchOcr -> indexer; pdfOcr -> ocr; semanticSearch -> search; imageSearch -> image-search | info | `Feature <id> enabled` / `disabled` |
| worker probe transition in `status()` | indexer, ocr, search, image-search | error / info | `Worker unreachable: <detail>` / `Worker reachable again` (per-process last-known map; a restart re-emits one entry for a still-down worker) |
| office settings updated | office | info | `Office settings updated` (data: enabled, editingEnabled) |

Web: `useSystemLogs(subsystem, { level, enabled })` (`useInfiniteQuery`, 5 s refetch only while
open), `lib/system/logs.ts` (`formatLogLines`, `toNdjson`, `logFileName`), and
`components/system/log-sheet.tsx` `LogSheet { subsystem, title? }`: its own "Logs" trigger,
level toggle (all / warn+ / error), monospace rows with a level badge and collapsible data,
Copy (clipboard + toast), Download (.txt / .ndjson), Load older.

## Verification

`application`, `integration` (migration and the idx merge query), browser `features`,
`office-settings`, `trash`, `system`, `account-scope` specs (plus a `/system/connection`
redirect check and opening the Indexer Settings sheet), and a real dev pass: edit Indexer
settings, wait past one poll, close the sheet and get the discard prompt; run Reindex and see
`Reindex requested` in Logs; Copy and Download yield the same lines; Run walkthrough still
walks 13 steps.
