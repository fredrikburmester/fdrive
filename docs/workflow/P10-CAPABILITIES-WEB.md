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

## As implemented (2026-09-10)

- `lib/identity/capabilities.ts`: `capabilitiesFor(me, identityId?)`, `anyLoginCan(me, key)`,
  `browserActions(capabilities, selection)` over a `BrowserSelection { files, folders }`, plus
  `canDownload`/`downloadNeedsZip`, `DEFAULT_CAPABILITIES` (everything true except `trash`, so
  nothing flickers before `/auth/me` answers and the pre-capability behaviour is kept) and the
  chip labels. The context menu, toolbar and list/grid take one `capabilities` prop;
  `trashAvailable` is gone. `hideMoveCopy`/`hideArchive`/`showReveal` stay: they describe the
  listing kind (favorites, recents, a tag), not the provider, and the spec's "on top" rule needs
  them. `selectionCount`/`includesFolder` on the context menu became `selection`.
- `zip`: `planDownload(entries, zip)` in `lib/files/download.ts` streams one file directly, zips
  anything else when the provider can, and otherwise downloads each file on its own, skipping
  folders; the menu, toolbar and ⌘D all go through it, so a folder-only selection has no
  Download without `zip` and a mixed one reads "Download" (not "as zip").
- `atomicMove`: no job with progress (there is no job endpoint for a move); the rename dialog and
  the Move-to picker show a caution line for a folder instead. `setModifiedAt`: the Inspector
  adds an upload-time note. `index`: the Inspector reports "Not indexed" for a folder without a
  request, the "Show thumbnails" toggle and list thumbnails are off, grid tiles fall back to icons.
  `office`: the Office items and the New document kinds are hidden even while Office is enabled.
  `trash`: the label, the sidebar entry and the delete confirmation all read the capability
  (`trashAvailabilityFor`); the separately cached `TrashStatusResponse` only contributes the
  retention sentence, so the menu and the dialog cannot disagree.
- Login page copy: the public provider list never carries the host, so an unlabelled provider
  is shown by product name (`providerDisplayName`) in the picker and the subtitle reads "Sign in
  with your SFTPGo account" without an "on …" part.
- Sidebar Shares and Trash are the union across linked logins (`anyLoginCan`); the switcher and
  the Logins card show a per-type `ProviderIcon` (labelled with the product name).
- Login page: the server component loads `GET /providers`; `LoginForm` renders
  `credentialFields` through the shared `ProviderFieldInputs` (an optional one-time code stays
  behind "Use a one-time code" as before) and a `ProviderPicker` when more than one provider is
  enabled; `providerId` is sent whenever a provider is known. With no providers (API unreachable)
  the SFTPGo-shaped `DEFAULT_CREDENTIAL_FIELDS` render and the server picks its only provider.
- Add and Remove login dialogs: fields from the chosen provider, confirmation fields from the
  active login's provider filtered to secret kinds and relabelled "Your current password" / "Your
  one-time code" (`confirmationFieldsFor`). The identity scope card renders only with
  `scopeMapping`. Scope error copy is provider-neutral; copy that names SFTPGo the product
  (trash rules, Office user lists, virtual folders, setup) stays.
- Browser specs: `login-providers.spec.ts` adds a second SFTPGo provider through the admin API,
  checks the picker appears only then, and signs in through the seeded one with its
  `providerId`; `about.spec.ts` unchanged (attribution list already rendered).
- System > Storage (`/system/storage`, worker worktree `claude/p10-system-storage`, transferred):
  one `SystemSection` per provider with type icon and product name, address, Enabled switch,
  reachability badge with a per-row Test, Source badge, login count, capability chips from the
  matching `types[].capabilities`, Edit and Remove; Remove is disabled with the reason as helper
  text for env-pinned rows and rows with logins, and disabling the last enabled provider asks for
  confirmation. `ProviderDialog` adds and edits: type picker (locked on edit), Name, Address
  (read-only with the reason when env-pinned or in use), the type's `configFields` rendered
  generically, a Test against the unsaved candidate, and an update patch of changed fields only
  (`providerUpdatePatch`). The home template is edited there as the SFTPGo config field.
  System > General keeps the server address and Trash cards plus a pointer to Storage;
  `hasHomeTemplateChanged` and `primarySftpgoProvider` are gone. `shared-folders-card.tsx` was
  untouched (it reads mount mappings only). `system-storage.spec.ts` adds, tests, renames,
  disables and removes a second SFTPGo row; `system.spec.ts` edits the home template through the
  Storage dialog. Known: while that spec's second row exists, `/login` shows the picker, so the
  storage and login specs run with `--workers=1`.
- Not done: no job with progress for non-atomic folder moves (caution copy only); the walkthrough's
  Office step label is still the literal "ONLYOFFICE"; the `general` log subsystem still has no page.
