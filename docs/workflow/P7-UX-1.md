# P7 UX pass 1 (requested 2026-09-07)

User feedback, verbatim intent, split into two chunks with disjoint files. Frontend rules apply
throughout: shadcn/ui components only (added with the CLI), Apple-like design language, colours
from `globals.css` tokens, one-line descriptions under settings fields, every visible change
checked at 390x844 (mobile) and 1440x900 in Playwright.

## Chunk `ux-shell` (apps/web only, except `apps/web/e2e/**` additions)

1. Mobile top bar. Below `md` the toolbar crunches. Design: keep at most three controls
   visible on small screens (search, New, an overflow "More" menu holding View, Upload,
   Duplicate, Compress, details toggle and selection actions); the breadcrumb truncates
   from the left with the current folder always visible; selection count moves into the
   overflow trigger's badge. No horizontal overflow at 320px. Desktop layout unchanged.
2. Search on mobile. Reproduce why the search icon is not pressable at 390px (likely the
   disabled state when the index is unavailable, or overlap with the sidebar trigger).
   The button must be a 44x44 target, never overlapped, and when search is unavailable it
   stays enabled and opens the panel with the existing "Search is not available" state so
   the user learns why. Cross-identity search stays available when more than one identity.
3. Sidebar order. Locations group becomes: Files tree, Shares, Trash (Trash last in the
   group, directly above the System/connection group). Keep the existing active states.
4. Tags and Favorites with nothing yet. The Tags section always renders with "Manage tags…"
   so tags can be created before anything is tagged; an empty section shows one muted line
   "No tags yet". Favorites and Recents sections always render with a muted empty line
   ("Star a file to see it here" / "Files you open show up here") instead of disappearing.
   Update the WORKING.md pitfall note that documented the old behaviour.
5. Tests: jsdom tests for the toolbar breakpoint logic (pure function deciding which
   actions are visible), sidebar order, empty sections; Playwright at the mobile preset:
   toolbar has no horizontal overflow, overflow menu exposes every action, search button
   clickable and opens the panel, sidebar order.

## Chunk `ux-shares` (packages/db, packages/contracts, apps/api/src/shares, apps/web shares)

1. Model: shares get an operator-chosen `presentation`: `"auto" | "list" | "gallery" |
   "download"`. Default `auto`. `auto` resolves on the public page to `gallery` when every
   shared file is an image (by extension), `list` for directories or mixed files, and
   `download` for a single non-image file (today's behaviour). Store it in the fdrive
   share row (migration, repo, memory repo, integration test), accept it on create and
   update, return it in owner and public metadata. `ShareLayout` stays as the derived
   physical shape.
2. Public page. `gallery`: responsive grid of image thumbnails rendered from the public
   download route (bounded: lazy-loaded `img`, no full-size decode for the grid beyond
   `object-fit: cover`; if the API has no public thumbnail route, use the download stream
   with `loading="lazy"` and cap grid tiles at 200 per page with "Show more"), tap opens a
   full-size lightbox with previous/next, a Download button per image, and "Download all
   as ZIP" when more than one file. `list`: current directory listing with per-row
   Download and the ZIP button. `download`: single prominent Download card. Password
   prompt and expired/limit states unchanged.
3. Share dialog and Shares page copy. Remove technical vocabulary from the user-facing
   surface: no "scope", "layout", "credential generation", "upstream", "capabilities",
   ids or paths beyond the shared item's own name. Fields: Link name, Access (Can view /
   Can upload), Show as (Automatic / List / Gallery / Download only), Password (optional,
   with Generate), Expires (Never / date), Download limit (optional). Descriptions are
   one plain sentence each. The Shares page lists name, item, access, shown as, expiry,
   downloads used, with Copy link, Edit, Revoke. Keep every existing behaviour and test
   (rename copy in tests rather than deleting assertions).
4. Tests: repo and contract tests for `presentation`; API route tests for create/update
   validation and public metadata; web unit tests for the `auto` resolution and gallery
   pagination; Playwright on the real SFTPGo fixture: create an image-folder share, public
   page shows the gallery, lightbox navigation, per-image download, ZIP download, then a
   single non-image share shows the download card, and the dialog shows the friendly
   labels. Run at desktop and mobile presets.
