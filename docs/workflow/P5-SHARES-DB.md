# P5 shares repository

Implementer isolated DB chunk. Own packages/db/src/repos/shares*.ts,
packages/db/test/integration/shares*.test.ts, DB index exports/vitest config only.
No schema migration needed. Other workers own API/UI/office testing; preserve them.
Never stash, change Git state or delegate.

Export createShareRepo(db), ShareRepo and pure input validation/memory adapter.
Existing app.shares stores id/identityId/sftpgoShareId/name/scope/paths/hasPassword/
expiresAt/createdAt/views. No passwords, upstream credentials or tokens stored.
Share scope only read/write. App UUID is stable; upstream ID opaque bounded safe
identifier, not an URL. All canonical virtual paths absolute; reject traversal,
controls, backslashes/empty inner segments; root allowed. Between1 and1000 paths, each
4096chars, name1..255, valid Dates, views nonnegative32bitinteger. Canonical UUIDs.

Methods:
upsert({identityId,sftpgoShareId,name,scope,paths,hasPassword,expiresAt,views,at})
 -> Promise<ShareRecord>, stable appUUID/createdAt on conflict unique upstream+identity.
Same upstreamID under differentidentity remains distinct. Used only after upstream
success or reconciliation; all updates atomic. Copies input arrays in memory.
get(id)->ShareRecord|null for public proxy INTERNAL lookup; does not authorize use.
getOwned(identityId,id)->ShareRecord|null, explicit ownership in SQL.
listOwned(identityId,{limit?:number})->ShareRecord[], default200/max1000,
createdAt desc/id deterministic. No unbounded list API.
removeOwned(identityId,id)->boolean, foreign/missingfalse, never removes upstream.
Public routes later fetch authoritative SFTPGo share state and enforce auth/limits;
DB views is cached upstream count, never independently grants downloads.

Unit input validation and memory adapter semantics/concurrency; real DB CRUD,
unique/conflictupsert retainsUUID/timestamp, foreignread/delete isolation, identity
transfer leaves share withsameidentityUUID, no passwords columns. SQL adapters may
follow integration-only exclusions; pure modules100%, packagecoveragegate. Run
DB typecheck/Biome/fullunitcoverage/fullintegration. Reportfiles/gates/interface,
assumptions, branch and absolutecheckout.
