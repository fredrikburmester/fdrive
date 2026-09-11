# Issue #2 concurrency fixes

Implement and commit in this order: credential replacement (#11), provider mutations
(#8–10), token minting/cache invalidation (#3), then setup cleanup (#7).

## Invariants

- Compare credentials under the identity/account persistence locks. Observe the credential
  before upstream authentication; reject a different credential committed in the meantime.
  Concurrent logins with the same new credential must both retain valid sessions.
- Admin provider creation inserts once with final configuration; seeding remains idempotent.
  Readdress uniqueness and deletion/login conflicts become 409. Provider locks serialize
  lifecycle changes against identity persistence without sending credentials to another URL.
- Per-identity token work coalesces. Invalidation/prime supersede older work; stale work
  cannot overwrite cache/database state or remove a newer in-flight operation.
- Setup losers leave no newly issued session. Cleanup must only remove exclusively owned
  bootstrap records; preserve pre-existing identities, the winner, and resumable claims.
  Keep setup finalization last.

## Verification

Use deterministic deferred operations to control race ordering, real PostgreSQL integration
for transaction behavior, and application/workflow gates. Do not weaken coverage thresholds
or timeouts; reduce test concurrency when the known parallel archive timeouts recur.
