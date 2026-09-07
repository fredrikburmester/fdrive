# P4-REGISTRY

Implementer chunk; primary decisions in P4-HOST-DESIGN.md and PLAN.md §8.
Assigned separate worktree at launch. Never stash, mutate Git state or delegate.
Other agents are active; preserve their work and remain in scope.

Owned paths: packages/db/src/schema/app.ts, packages/db/drizzle/**,
packages/db/src/repos/office-files*.ts, packages/db/src/index.ts,
packages/db/vitest.config.ts, packages/db/test/integration/office-files*.test.ts.
API hooks belong to later host worker; do not edit API.

Add office_files exactly as P4-HOST-DESIGN specifies. root-relative path has no
leading slash, directory scope root represented by empty string only for prefix
operations; actual file locations must be nonempty. Validate canonical paths,
reject NUL/dot/dotdot/empty internal segments and segment byte lengths above255.
Use existing normalizers carefully: they normalize traversal rather than reject.

Export standalone OfficeFileRepo, OfficeFile and createOfficeFileRepo(db):
- ensure({providerId,rootName,path}): Promise<OfficeFile>. Atomic under concurrent
  opens; same active location returns same UUID. No identity/account in key.
- get(id): Promise<OfficeFile|null>. Tombstoned IDs return null.
- movePrefix({providerId,rootName,from,to,at}): Promise<void>. Atomically moves exact
  and slash-delimited descendants, preserving UUIDs. Same path no-op. Destination
  conflicts tombstone prior entries. Disjoint siblings untouched, repeats no-op.
- deletePrefix({providerId,rootName,path,at}): Promise<void>. Tombstone scoped exact
  and descendants; later ensure allocates new UUID. Idempotent.

OfficeFile fields: id,providerId,rootName,path,createdAt. Advisory transaction locks
on provider/root serialize registry moves/deletes/ensure. No need to serialize
different roots/providers. Mutation SQL must escape LIKE wildcard names. Prefix
move may never move a folder into itself; reject overlapping from/to paths except
equality no-op. All operations parameterized; avoid relying on row iteration order.
Provide memory implementation sharing validation/semantics for API route tests.
Pure mapping/state logic stays covered; SQL adapter may follow integration-only
exclusions. Generate Drizzle migration with package scripts, no lockfile edits.

Tests: concurrent ensure from two pools; multi-user shared location same UUID;
provider/root isolation; rename+folder move preserve IDs; escaped wildcard paths;
destination replacement; delete/recreate new ID; repeated event idempotence;
transaction failure rollback. Index clear does not affect registry/table FK.
Run DB typecheck, unit coverage, full integration and Biome changed files.
Report interface, changed files, actual gate lines, gaps, branch/absolute checkout.
