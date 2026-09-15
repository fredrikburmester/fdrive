# Implementation pitfalls

Reference for affected code; shared rules live in [AGENTS.md](../AGENTS.md).

## Deployment resources

- A container limit on memory is not a limit on CPU, and every heavy worker sizes its own
  concurrency from the host's visible cores. Capping one just moves the problem: capping
  `embed` put the same host back at load 115 with the indexer's tesseract processes at 240%
  each. Bound thread counts explicitly (`FDRIVE_EMBED_THREADS`, `FDRIVE_IMAGE_EMBED_THREADS`,
  `OMP_THREAD_LIMIT=1` for the indexer's tesseract children); `cpus:` caps are opt-in because
  Docker rejects a value above the host's core count. Treat the limits as one pass over
  `compose.yaml`, not per-service tuning.
- Green fdrive-side signals do not mean the operator still has a machine. When a feature costs
  real resources, ask what the failure looks like from outside the stack.
- Overload feeds back. A loaded host slows the api, a slow api fails the runtime controllers'
  poll, and stopping a healthy child reloads its model — which loads the host further and makes
  the indexer log a connection error per file against the worker it just killed. A watchdog
  that reacts to "I could not reach the supervisor" the same way it reacts to "the supervisor
  said stop" will amplify any load spike.

- CPU image embedding is compute-bound: the default SigLIP 2 model managed about 1.4 images per
  second on four threads, and 4-, 8- and 16-image requests were no faster than single images.
  Batching cannot shorten an image-search backfill; not blocking other work on it can.

## Code and integration

- Worker state that tracks feature transitions must start from the persisted selection. A
  disabled placeholder made every indexer restart look like enabling thumbnails and image
  search, re-running the media backfill over the whole library.
- `NOT IN (SELECT ...)` stays linear only while Postgres can hash the subquery within
  `work_mem`. The scan sweep sent every seen path and went quadratic between 120,000 and
  150,000 files; at 200,000 it ran past ten minutes. Diff large sets in the worker, or use
  `NOT EXISTS`, and never rewrite every row just to mark it seen.

- Agents sometimes stash, edit outside their scope, or report gates they did not run; the review
  step exists for that. Scope-check with the review script and read the gate lines.
- Two parallel chunks editing one shared file (`composition.ts`, `config.ts`, `client.ts`,
  `app-sidebar.tsx`) always conflict; serialize them or plan for the conflict-resolution agent.
- e2e-only assumptions hide dev-only failures: the e2e stack has fakes that differ from the dev
  wiring (lazy SFTPGo client, host-run API). Click through the pane after merging anything that
  touches jobs, SSE, or the connection store.
- Turbopack cannot resolve `./x.js` specifiers to `.ts` sources; workspace packages use `.ts`
  import specifiers with `rewriteRelativeImportExtensions`. Production images build workspace
  packages first (`pnpm --filter <app>... run build`).
- Next bakes `API_INTERNAL_URL` into the build; the compose proxy owns `/api`, and the web image is
  built with the compose value.
- Never run `pnpm test:coverage` (or any turbo task) while a Playwright run is active in the same
  checkout: the e2e harness creates `apps/web-e2e-shadow-<ports>/`, which turbo rejects as a
  duplicate workspace. Run them one after the other.
- Sidebar Favorites, Recents, and Tags sections always render once their query resolves (a muted
  one-line placeholder replaces the list while empty); only a still-loading query renders nothing.
  A fresh dev database shows all three sections with their empty-state copy, not their absence.
- Real SFTPGo v2.7.5 drops the TCP connection on `GET /api/v2/user/dirs` for a path that is a
  file (the in-memory fake answers 400). Never call `list` on a path of unknown kind; `statFile`
  first, list only after it reports `bad_request`.
- Zod 4's `z.iso.datetime()` rejects `+00:00` offsets unless `{ offset: true }`; Python emits
  offsets.
- Base UI: `DropdownMenuLabel` must sit inside a group; never nest a `ToggleGroup` in a menu; pass
  `nativeButton={false}` when a `Button` renders a link; React events bubble through portals, so
  listen on the DOM node when a container must ignore its portalled children.
- Base UI Select: use `null` for an empty controlled value, not `undefined`; switching from
  undefined to a root name causes an uncontrolled-to-controlled warning. Give sentinel values
  explicit `SelectValue` display text so users see "All roots" instead of `__all__`.
