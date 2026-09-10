# P10 chunk A2: capabilities in the web app, provider forms, System > Storage

Design: [P10-STORAGE-PROVIDERS.md](P10-STORAGE-PROVIDERS.md). Consumes the contracts agreed with
[P10-REGISTRY-API.md](P10-REGISTRY-API.md). Until A1 lands, develop against the contracts package
and the API fixture; every capability is true for SFTPGo so nothing visible changes for it.

## Capabilities helper

`apps/web/src/lib/identity/capabilities.ts`: `capabilitiesFor(me, identityId)`,
`anyLoginCan(me, key)`, and `browserActions(capabilities, selection)` returning which of the
existing `RowContextAction`, `ToolbarActionId` and `FilesActionType` ids are available. One
`capabilities` prop replaces `hideArchive`, `hideMoveCopy` and `trashAvailable` on
`file-context-menu.tsx`, `toolbar.tsx` and the keyboard dispatch in `file-browser.tsx`.
Virtual listings (favorites, recents, tags) keep their own move/copy hiding on top.

| Flag | Hidden or changed when false |
| --- | --- |
| `zip` | "Download as zip"; folder entries in multi-download; toolbar Download when the selection includes a folder; ⌘D on a folder. Single-file download stays. |
| `setModifiedAt` | Nothing hidden. Details pane notes that Modified reflects upload time. |
| `atomicMove` | Folder rename and move confirm as a job with progress instead of an inline rename. |
| `trash` | Existing: Trash in the sidebar, Delete versus "Move to Trash". Source becomes the capability, with `TrashStatusResponse` kept for the page itself. |
| `shares` | "Share" in the context menu; Shares in the sidebar when no linked login has it. |
| `office` | View/Edit/Convert in the context menu; New Document/Spreadsheet/Presentation in the toolbar. |
| `index` | "Show thumbnails" toggle and grid thumbnails; folder size shows "not indexed" without a request; search keeps its existing per-identity unavailable notice. |
| `scopeMapping` | The identity scope card on the Account page for that login. |

Tags, favorites, recents, previews, in-place editing, archives, rename, copy, duplicate, new
folder and uploads are always shown.

## Login and link

- Login page fetches `GET /api/v1/providers`. One enabled provider: fields from its
  `credentialFields`, subtitle from its label, no picker. Several: a picker above the fields.
  Submit `{ providerId, credential }`.
- Link login dialog: same picker and fields; `currentCredential` fields come from the active
  login's provider. Unlink keeps the current password confirmation through `currentCredential`.
- Identities card and sidebar switcher show `providerLabel` and a per-type icon.

## System

- System > General loses the connection card. New System > Storage page (`/system/storage`,
  admin): provider list with type, label, endpoint, reachability, capability chips, Enabled
  toggle, Edit and Remove (refused while logins use it). Add provider: type picker, then a form
  from `configSchema` field metadata; Test runs `/admin/providers/:id/test`. Rows with
  `managedByEnv` show the endpoint read-only with the existing "set by SFTPGO_URL" copy.
- Shared folders card lists SFTPGo providers only. Home template is edited on the SFTPGo
  provider row (it lives in its config now).
- Setup wizard connection step is unchanged in behaviour: it creates the SFTPGo provider.
- Walkthrough and feature cards: replace "SFTPGo" with the provider label where the copy refers
  to the user's storage; keep it where it names SFTPGo the product (trash rules, Office user
  lists).

## About

Renders `builtOn[]` as one attribution line per configured provider.

## Copy

Every `sftpgo` literal in `apps/web/src` (about 30 files, listed in the investigation) is either
replaced by the label from the API or kept deliberately because it names the product. Error copy
in `components/account/scope-model.ts` becomes provider-neutral.

## Checks

`application`. Browser specs: `login` with one and two providers (fixture API), `files` context
menu and toolbar with each capability false in turn, `account-scope` hidden without
`scopeMapping`, `system-storage` add/test/edit/remove, `about`. Real dev app pass with the
migrated SFTPGo row. `workflow`.
