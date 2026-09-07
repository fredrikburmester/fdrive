# P4 transaction correction

Parent review found pooled-connection starvation in nested office writes.
Implementer owns packages/db/src/repos/wopi-locks.ts, office-files.ts,
new office-write-scope.ts, associated unit/integration tests, DB index exports and
vitest config only. Other workers own API/web and identity-links modules.
Never stash, change Git state or delegate. Use assigned isolated checkout.

Factory createOfficeWriteScope(db) returns generic function
withWriteScope<T>(providerId:string, callback:(scope:{files:OfficeFileRepo;
locks:WopiLockRepo})=>Promise<T>):Promise<T>.
Acquire office-write:providerId advisory transaction lock in ONE transaction.
Scoped files and locks run all queries and acquire nested advisory locks on that
same transaction, no further pool checkout or savepoints. Refactor internal
repository helpers to accept minimal query executor and explicit transaction
runner; ordinary exported factories retain behavior. No global ALS/proxy.
All metadata service operations happen AFTER commit in API, not in coordinator.
Reject escaped scope operations after callback; drain awaited work naturally and
ensure callback failure rolls back registry and WOPI records. Do not expose a
public raw database transaction. Validate provider UUID before database access.
Existing memory repositories sufficient for API unit dependency injection.

Regression with production pool max2: A holds provider gate, B consumes second
connection waiting same provider gate (observer pool confirms advisory wait).
A must still finish nested path/file locks and registry ensure/move. Both finish
within bounded timeout. Test lock rollback, registry rollback, independent pools,
ordinary lock request competing with scoped write, escaped-use rejection.
Maintain 99% lines/functions and95%branches, pure100%; typecheck/Biome and full DB
unit/coverage/integration. Report exact files/results/assumptions, branch/path.
