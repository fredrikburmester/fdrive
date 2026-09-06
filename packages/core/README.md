# @fdrive/core

Pure TypeScript domain logic for fdrive: no I/O, no Node-specific imports, zero runtime
dependencies. Everything here is a function of its inputs, so it runs the same in the API server
and in the browser, and is tested with fakes rather than mocks.

## Invariants

- **Paths are always normalized at the boundary.** Every function in `paths.ts` that accepts a
  path normalizes it before doing anything else. Callers outside this package (route handlers,
  storage adapters) should treat any path as untrusted input and let `normalizePath` (or a
  function built on it) be the first thing that touches it. A path is never trusted just because
  it came from a database row or a provider response.
- **A path never escapes its root.** `normalizePath` resolves `.` and `..` segments without ever
  producing a path above `/`; extra `..` at the root are absorbed rather than erroring or
  escaping. No function in this package can produce a path outside the virtual root it started
  from.
- **Scope is mandatory on every index-style query.** `scope.ts` is the one place that translates
  between a user's virtual paths and a storage root's filesystem paths. Anything that lists,
  filters, or maps a set of files coming from an index (`filterInScope`, `scopePrefixes`) takes a
  `Scope[]` and only ever returns items that fall within it. There is no "no scope" query; an
  empty `Scope[]` means "nothing is in scope," not "everything is."
- **Fs paths never leave this package's public surface toward the UI.** `toVirtualPath` and
  `filterInScope` map storage-side paths back to virtual paths; route handlers and UI code should
  only ever see virtual paths. This is what keeps a wrong home-template mapping from leaking one
  user's files into another user's search results: the scope check happens once, in core, not at
  every call site.
- **Errors are one type.** Every thrown error is a `CoreError` with a `kind` from
  `CoreErrorKind`. Callers narrow with `isCoreError`, not `instanceof`, since that survives
  bundling and package boundaries.

## Layout

- `errors.ts` - the shared `CoreError` type.
- `paths.ts` - virtual path parsing, normalization, and manipulation.
- `scope.ts` - home templates and the scope model that maps virtual paths to storage paths.
- `entries.ts` - `FileEntry` and natural-order sorting.
- `ports/` - interfaces (`StorageProvider`, `Clock`, `IdGenerator`) that adapters implement later.
  No implementations live here.
