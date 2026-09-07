# Scoping: per-folder view setting (requested 2026-09-07)

Asked: "per folder view setting. I don't know where this setting would go, if the user has a global
setting but then changing the view in the top bar saves it per folder? unclear. please scope it
out." No code in this pass — this is the design and the open decisions.

## Where the setting lives today

`apps/web/src/lib/files/view-mode.ts` reads and writes one localStorage key, `fdrive.view`, holding
`"list" | "grid" | "tree"`. It is global (every folder), per browser (not per account), and the
toolbar's View menu writes it directly. Sort order (`fdrive.sort`), grid tile width
(`fdrive.gridWidth`), tree expansion (`fdrive.tree`) and inspector visibility (`fdrive.inspector`)
all follow the same one-key pattern. Nothing is per folder today.

## The ambiguity, and the answer

The question is what the toolbar's View control means once folders can differ. Three coherent
answers:

**A. Sticky global, opt-in per folder — Finder's model. Recommended.**
One global default. Changing the view while in a folder pins *that folder* to the new view,
immediately, and nothing else changes. A folder with no pin follows the global default. The View
menu grows two items: "Use as default for all folders" (writes the global) and "Use default view"
(removes this folder's pin). This is what Finder does with "Always open in…" versus "Browse in…",
without the modality.
*Why:* the change applies where you made it, which is the least surprising reading of a control in
a folder's own toolbar, and there is still one lever that resets everything.

**B. Global unless explicitly pinned.**
The toolbar keeps writing the global; a folder is pinned only through an explicit "Always open this
folder as…" item. Fewer accidental pins, but the common case ("I want *this* photo folder as a
grid") costs a menu trip every time, and the toolbar silently reformats every other folder.

**C. Per-folder only, seeded by whatever you last used.**
Every folder remembers what you last used there; a folder you have never visited inherits your last
choice anywhere. No settings UI at all — but it drifts, you cannot predict what a new folder will
look like, and there is no "make everything a list again" short of clearing storage.

Recommendation: **A**. It answers the question the way the toolbar already reads, and the two extra
menu items are cheap.

## Where the pins are stored

**Local (localStorage).** One key, `fdrive.view.folders`, holding a `{ [path]: ViewMode }` map,
bounded (cap at ~500 entries, evict least-recently-used) so a browsing habit cannot grow it without
limit. Zero backend work, ships in one chunk. Per browser, so a folder that is a grid on the laptop
is a list on the phone.

**Server (`app.folder_views`).** A table shaped exactly like `app.favorites`:
`(identity_id uuid, path text, view_mode text, sort jsonb null, updated_at timestamptz)`, primary
key `(identity_id, path)`. Follows the account across devices, survives a cleared cache, and is per
identity — the same folder seen through two identities can legitimately differ. Costs a migration,
a repo, a contract, routes, and query-cache wiring.

Recommendation: **server**, for the same reason favorites and tags are on the server — this is a
preference people expect to follow them, not a browser detail. But the resolution logic
(`resolveFolderView(path, pins, globalDefault)`) is identical either way, so shipping the
localStorage version first and swapping the store later is a contained change, not a rewrite. If
this should land quickly, do local first.

## Decisions still open

1. **Inheritance.** Does pinning `/photos` affect `/photos/2024`? Finder says no; each folder is
   independent. Recommend no inheritance — predictable, and "apply to enclosing folders" can be
   added later without breaking anything.
2. **What travels with the view.** View mode is the ask. Sort order has the same shape and users
   usually expect the pair to travel together ("this folder is a grid, sorted by date"). Recommend
   modelling the record as a folder *view state* (`mode`, optional `sort`) from the start, even if
   only `mode` ships first — retro-fitting sort into a mode-only key means a second migration.
3. **Virtual listings.** Favorites, Recents, Tags, Trash and search results are not folders.
   Recommend they always follow the global default and cannot be pinned; reserved keys
   (`@favorites`) can be added later if wanted.
4. **Renames and moves.** A path-keyed pin goes stale when the folder moves. Server-side, the
   rename and move endpoints can carry the pin in the same transaction; locally they cannot.
   Either way, prune pins whose path no longer resolves when a listing is read.
5. **Reset.** "Reset all folder views" belongs on the account page beside the other preferences.
6. **Tree view.** No special case — a folder pinned to `tree` opens expanded under itself, same as
   the other two modes.

## Effort

- localStorage version: one chunk — a pure `folder-view.ts` (resolution, pin/unpin, bounded map)
  with unit tests, the two new View-menu items, `file-browser.tsx` wiring, and a Playwright spec
  that pins one folder and checks a sibling is unaffected.
- Server version: two chunks — `folder-view-db` (migration, repo, contract, routes, integration
  test) and `folder-view-web` (the same UI, reading through the metadata query cache).

Neither blocks the current UX pass.
