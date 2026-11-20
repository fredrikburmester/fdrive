# Design: Quiet

Quiet is how fdrive looks outside the file list itself: one short list on the left, one wide sheet
on the right, almost no color. System, Settings and About use it, and so does every page that
shows one thing in detail. The file list keeps its own dense look.

The design system with every token and a rendered example of each component is the
[fdrive Quiet](https://claude.ai/artifact/PS5YieKXD61rcvTjUaVHZY) artifact. This page is the
part of it a change to the web app needs.

## Principles

- **One list, one sheet.** A page is a short list of things and a wide sheet that shows the chosen
  one. Never stack cards down a page, and never open a section in place: no accordions.
- **Ink on ground.** Everything is `foreground` on `background` or `panel`. Color means state:
  green for healthy and on, amber for attention, red for failed and for actions that delete. The
  one blue, `ring`, marks focus, selected files, drop targets and folder icons.
- **State is a word with a dot.** Say Reachable, Healthy, On or Off in a `StatusBadge`. Never show
  state by color alone.
- **One primary action.** A sheet has at most one primary button. Everything else is a secondary
  button or a text button.

## Parts

| Part | Where | Use |
| --- | --- | --- |
| `ListSheet`, `AreaList`, `ListSheetTrail` | `components/shell/list-sheet.tsx` | The frame: a list of areas beside the chosen area's sheet. Each area has its own URL. |
| `DetailSheet` | `components/shell/list-sheet.tsx` | The sheet: title, one-line lede, status badges, actions, content, footer. |
| `SheetDock` | `components/shell/list-sheet.tsx` | A page of rows with the chosen row's sheet docked on its right. |
| `SheetColumns` | `components/shell/list-sheet.tsx` | Two short, related blocks side by side. |
| `StatusBadge`, `StatusDot` | `components/shell/status.tsx` | State. Badges in sheet headers and table cells, dots at the end of list rows. |
| `PageSection`, `SettingRow`, `SettingActions`, `DataTable` | `components/shell/page-layout.tsx` | A titled block, a setting, a form's buttons and a table. |
| `SegmentedControl`, `ChoiceRow` | `components/shell/setting-controls.tsx` | Two to four fixed choices. |
| `BarList`, `FactList`, `Code` | `components/shell/sheet-data.tsx` | Shares of a whole, named read-only values, and values a person copies. |
| `SystemPage`, `SystemSection`, `StatGrid` | `components/system/` | A System area's sheet, with the feature switch, and its blocks and headline numbers. |

## Layout

- The app shell stays: the sidebar and the 48px page header.
- **List column**: on `background`, at most 300px wide. A 20px title, then 44px rows with a 10px
  radius. The chosen row sits on `muted` in weight 600.
- **Sheet**: fills the rest, on `panel`, with a hairline on its left and no shadow. Blocks inside
  are 24px apart. Divide with hairlines and small muted headings. Do not put boxes inside a sheet.
- **Sheet header**: the title, status badges under it, and on the right the actions. The primary
  button is the last action. A docked sheet ends its actions with a close button.
- **Docked sheet**: beside a page that is not a list of areas (a table's chosen row), the sheet is
  a 460px column on the right with the same ground and hairline.
- **Phone**: the list is a screen of its own. Choosing a row opens the sheet as a full screen, and
  the page header leads back to the list. Every control is at least 44px tall.

Inside a `DetailSheet` the `sheet:` Tailwind variant applies. Buttons, inputs and switches are
larger there, outline buttons fill with `muted`, destructive buttons are text, and `PageSection`,
`SettingRow` and `DataTable` drop their side padding. A component that must look different in a
sheet uses that variant instead of a prop.

## Color

All colors are tokens in `apps/web/src/app/globals.css`.

- Text is `foreground`. Descriptions, section headings, column heads and secondary cells are
  `muted-foreground`.
- `panel` is only the sheet. `card` and `popover` are only for things that float: menus, dialogs
  and the chat overlay.
- `muted` fills the chosen list row, secondary buttons, neutral badges and bar tracks.
- `primary` is ink, not blue: the one primary button, and checked checkboxes.
- `success`, `warning` and `destructive` are a badge's text, and the matching `*-muted` token is
  its ground. `success-dot` is the green of dots, healthy bars and a switch that is on.
- A destructive action is a text button in `destructive`, placed apart from the other actions at
  the far end of a sheet's footer. It always asks before it runs.

## Type and writing

- One family, the system font. Mono only for values a person copies: revisions, paths, IDs.
- Sentence case everywhere. Action labels are verbs with no ellipsis: Reindex, Back up now.
- Every setting has a label and a one-line description that says what it does.
- State words are fixed: On, Off, Reachable, Unreachable, Healthy, Needs attention, Failed.
- Say what a destructive action keeps: "Clearing removes the search index only. Your files are
  not touched."

## Where it applies

- **System**: one sidebar row for administrators. `/system` lists the areas (`lib/system/areas.ts`)
  and each area's page is its sheet.
- **Settings** (`/account`): the same frame with the personal sections.
- **About**: the last System area for administrators, and a sheet from the account menu for
  everyone else.
- **Shares, Trash, My activity**: the page's own table, with the chosen row's details in a docked
  sheet in place of dialogs and expanding rows.
- **Files**: the file list is unchanged. Its details panel takes `panel` and the hairline.
