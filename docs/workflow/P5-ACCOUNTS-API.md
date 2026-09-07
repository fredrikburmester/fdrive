# P5 accounts API

Implementer spec. Depends on reviewed P4 host and P5 identity repository. Separate
checkout; never stash, change Git state or delegate. Others own DB/UI/scope resolver.
Own apps/api/src/accounts/**, auth/service.ts/routes.ts and tests, composition.ts,
packages/contracts/src/accounts.ts/tests, index/routes/client and tests,
API integration accounts*.test.ts. No search/metadata service changes in this chunk.

Routes on cookie-authenticated CSRF-guarded group:
POST /api/v1/account/identities: strict {username,password,otp?}; bound all strings
(username255, password4096, otp32). Verify via same SFTPGo login and shared limiter
key ip|username; failed verification never mutates DB. Call linkVerified repository
with account from LIVE cookie session; seal password with existing crypto/keyId
and actual identity UUID. No identity/body account ID trust. Invalidate cached
credentials and prime verified token after commit. Rotate requesting session after
link, making linked identity active. Preserve remaining absolute expiry; retain
user agent/IP; old requesting session revoked. Return MeResponse and secure cookie.
DELETE /api/v1/account/identities/:id: strict canonical UUID; cookie required.
Call unlink repository; require remaining identity; invalidate token cache; rotate
requesting session and use repository-selected remaining identity only if removed
identity was active, otherwise preserve active. Return MeResponse. Never delete
storage objects. Other sessions scoped to removed identity already switched by DB.
POST /api/v1/account/active-identity: strict {identityId:UUID}, validates live owned
session and identity through switchActive. Return MeResponse, no expiry extension.
API bearer tokens cannot link/unlink/switch even if a cookie is also supplied for a
different account. Re-read requesting session ownership before privilege mutations.
Map typed repo errors to clean403/404/409/401, no raw SQL or secrets in logs.

Typed client: linkIdentity(input), unlinkIdentity(id), switchIdentity(id).
Existing login/logout/me behavior remains. Extract reusable credential-verification
helper if necessary; don't call ordinary login as a linking shortcut (would create
accounts/sessions before identity transfer). Return provider labels from each
identity's actual provider record, not current connection's label. Only current
configured provider can be newly linked. Preserve configured admin username logic;
transferring a normal identity never inherits source account admin flag.

Race review: regular login currently creates account+identity nonatomically. Ensure
simultaneous login/link cannot duplicate identity or return a session on stale
ownership; minimal DB support requires parent specification, do not expand DB scope.
Recheck identity ownership before creating session and before returning MeResponse;
fail safely/retry bounded on raced ownership. No random unique-error retries.

Cross-identity views independent endpoints (existing active-identity API unchanged):
GET /api/v1/account/favorites -> {items:(FavoriteItem & {identityId:UUID})[]};
GET /api/v1/account/search with existing SearchQuery ->
{query,sections:{folders:(FsEntry&{identityId})[], files:(SearchHit&{identityId})[],
content:(SearchHit&{identityId})[]},degraded,unavailable,tookMs}.
Use authenticated account's owned identities only; at most4 concurrent operations;
global result cap per section50 and favorites1000, deterministic order. Stable
identity+path key. Do not deduplicate across identities sharing virtual path.
Inject search callback taking full identity, ready for shared verified scope resolver.
Never resolve by username alone without verifying identity ownership. Storage errors
for one identity may omit it with explicit unavailableIdentityIds so partial output
is visible; don't fail open to another identity or expose its cached content.
Each result's permission must be checked through that identity's storage. Reject
foreign query identity filters, or omit filters entirely for account-wide endpoint.

Tests: invalid credentials/TOTP/rate limit; own idempotent link; foreign-account
single identity transfer preserving metadata and nonadmin status; old session/WOPI/
API tokens denied after transfer/unlink; last-identity unlink409; foreign switch403;
session expiry and rotation; header/cookie identity mismatch; distinct same-path
favorites/search, bounded fanout and partial unavailable identity; current endpoint
compatibility. Real SFTP+Postgres integration links seeded users and proves isolation.
Run API/contracts full coverage/typecheck/Biome/integration. Report exact files,
contracts, measured gates, assumptions, branch and checkout.
