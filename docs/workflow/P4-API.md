# P4-API

Implementer chunk, PLAN §8 and P4-HOST-DESIGN. Absolute worktree assigned at
launch. Never stash, change Git state, or delegate. Other workers own registry
and deployment. Preserve their edits. Main prerequisites copied; parent reviews
and integrates only your delta. Node24/pinned pnpm; full gates required.

## Owned files

`apps/api/src/office/**` EXCEPT `office/protocol/**` (already reviewed),
`apps/api/src/config.ts`/tests, `apps/api/src/composition.ts`,
`apps/api/src/events/indexer-listener.ts`/tests,
`packages/contracts/src/office.ts`/tests, contracts index/routes/client and tests.
No DB implementation, web, deployment, or filesystem route edits.
Additional scope: auth/service.ts and tests for owned identity query selection on
GET/HEAD; scoped client downloadUrl appends identity. Foreign/invalid identity
never falls back to the active one. Session active identity stays unchanged.
Tests under apps/api/test/integration/office*.test.ts and
apps/api/test/fixtures/office/** permitted.

## Contracts decided by primary

ROUTES.office.status `/api/v1/office`: GET -> OfficeStatusResponse
`{available:boolean, product:'onlyoffice'|'collabora'|null,
 extensions:{view:string[],edit:string[],convert:string[]}}`.
Unavailable discovery returns available=false without leaking internal URLs/errors.

ROUTES.office.open `/api/v1/office/open`: POST
OfficeOpenRequest `{path:string, mode:'view'|'edit'|'convert', ui?:string}` ->
OfficeOpenResponse `{fileId:string,identityId:string,path:string,
 mode:'view'|'edit'|'convert',actionUrl:string,editorOrigin:string,
 formFields:Record<string,string>,expiresAt:ISO datetime}`. Caller identity is
authenticated principal, not request body. Cookie session required (no API tokens).
CSRF remains normal. formFields contain access_token, access_token_ttl epoch-ms,
and ONLYOFFICE docs_api_config enabling force-save with sensible neutral defaults.
Responses containing tokens have Cache-Control:no-store and Referrer-Policy:no-referrer.

ROUTES.office.documents `/api/v1/office/documents`: POST
`{parent:string,name:string}` where name is a safe single filename with one of
docx/xlsx/pptx/odt/ods/odp extensions. Return `{identityId:string,path:string}`201.
Never overwrite an existing file. Use real blank ODF templates; ONLYOFFICE can
start from empty OOXML, but Collabora requires valid templates. Generate minimal
valid templates with existing ZIP dependency or source documented blank fixtures;
no new package dependencies unless parent approves exact choice.

Client methods officeStatus(), officeOpen(request), officeCreateDocument(request).
Use existing contract/path/error conventions. Strict bounded Zod request schemas.

Config optional fields (undefined means office disabled): fdriveOfficeProduct,
fdriveOfficeUrl, fdriveOfficePublicUrl, fdriveWopiUrl. Env names in P4-DEPLOY.md.
If any supplied require complete tuple plus existing fdrivePublicUrl. URLs HTTP(S),
no credentials/query/fragment; WOPI base ends /wopi. Public URL may include a proxy
prefix; explicit conversion between discovered trusted action URL and configured
public base must preserve product action path/query. Reject alien action origins.
fdriveOfficeMaxBytes default104857600, positive bounded safe integer. Existing
AppConfig test fixture literals must stay source compatible through optional fields.

## Dependencies and auth

Registry worker exposes OfficeFileRepo ensure/get/movePrefix/deletePrefix matching
P4-REGISTRY. Until parent copies that dependency, define host dependency with a
structural interface matching it in office/types.ts; parent will validate wiring.
Do not add fake DB implementation. Existing lock exports are available in checkout.

Implement strict purpose-separated HS256 tokens and revalidation described in
P4-HOST-DESIGN. Session hashes only. Token <=8h and <=session expiry. Token audience
fixed fdrive:wopi, issuer fdrive. Known-algorithm signing only. No bearer fallback
from cookies for callbacks. Every callback validates token, UUID, session expiry,
identity/account/provider, current mapped path, and storage read authorization.
View mode never mutates. Explicit edit/convert is intent; real SFTPGo write/rename
permission enforced on every mutation. No guessed permission map/write probes.

Mount WOPI routes on top-level app `/wopi/files/:id` and `/contents` after
createApp; they use proof and token auth, not browser CSRF middleware. Errors
follow WOPI statuses/headers and never return upstream private URLs or credentials.
Callback proof URL configured WOPI base plus original raw request suffix/query;
never trust Host/Forwarded. Validate proof for EVERY operation, refresh discovery
once on signature failure and on rotation. Do not log query tokens or signed URLs.

## WOPI operations

GET file: CheckFileInfo. Send required fields, identity-based UserId/name,
provider-based OwnerId, Name/Size/Version/LastModifiedTime, edit-intent capabilities,
UserCanNotWriteRelative for view, SupportsLocks/Update/Rename, breadcrumb/close URLs,
PostMessageOrigin, file-name byte limit. Build URLs from configured app origin only.
Content version includes streaming SHA256, not HTTP seconds alone; bound the stream
and timeout. Each new open must detect equal-size same-second external replacements.

GET contents: streamed file with relevant content headers; enforce
X-WOPI-MaxExpectedSize (412 when exceeded) and configured maximum. Propagate abort.

POST file dispatch X-WOPI-Override: LOCK, REFRESH_LOCK, UNLOCK, GET_LOCK,
UNLOCK_AND_RELOCK, PUT_RELATIVE, RENAME_FILE; LOCK plus X-WOPI-OldLock means relock
too. Unknown override501. Missing/malformed required headers400. Lock validation
max1024ASCII, no unsafe response-header controls. Conflict409 ALWAYS X-WOPI-Lock
including empty when absent. Success no conflict header except GET_LOCK response.
Read-only LOCK returns200 without checking/changing current lock; other mutations
403. Matching lock works across sessions/users (not user-owned). Use repository
withFileLock for lock check plus upload/rename; bound external work with timeout.

POST contents with X-WOPI-Override PUT: PutFile. Nonempty unlocked target409;
matching lock required when locked; stream bounded upload under user's storage.
Return X-WOPI-ItemVersion after successful save; publish SSE update and refresh
metadata. Never claim success if upload/readback fails.

PUT_RELATIVE: support UTF-7 SuggestedTarget or RelativeTarget (exactly one),
overwrite flag only with RelativeTarget, scoped sibling safe filenames. Suggested
extension preserves source basename; collision generates unique name preserving
extension. Sanitize invalid suggested names into legal siblings; malformed UTF-7
or mutually supplied headers still400. Never silently overwrite on suggested target.
Microsoft PutRelativeFile does not require a source lock header: locked source
with absent header must succeed. Honor a supplied source lock if present, release
source serialization before acquiring target lock to avoid reciprocal deadlocks.
Reject every locked overwrite target, including one matching a supplied source
lock. Restrict mutations to edit token. Use same caller identity,
mint new file-bound token with original session expiry cap, return Name/Url and
HostViewUrl/HostEditUrl. Support FileConversion true. HTTP200 per WOPI.

RENAME_FILE: UTF-7 RequestedName without extension, retain source extension,
reject traversal/NUL/slashes/control/overlong names, collision400, same-name no-op.
Check lock, move using storage, update registry preserving UUID, metadata and SSE.
Return Name without extension. On invalid name400 X-WOPI-InvalidFileNameError.

Strict UTF-7 decoder: reject malformed shifts/surrogates, never guess UTF-8.
Consult Microsoft operation specs in addition to ONLYOFFICE docs; use tests for
Swedish/non-ASCII filenames, extension-only suggested targets and collision.

## Registry event wiring

Add optional awaited onStorageEvent callback to indexer listener, called once per
parsed event BEFORE per-identity fanout. Composition maps global root/path events
to current provider registry (moves/deletes only); no per-user duplicate mapping.
For fdrive-originated changes, pass fs routes a wrapper around metadataService
whose onMoved/onDeleted updates registry using that identity's canonical scopes
then delegates original metadata method. Index listener uses original metadata.
Handle errors through existing logger without unhandled async rejections.
Opening after rename resolves current path; removed or out-of-scope file fails.

## Verification/report

Unit tests all routes and helpers with independent generated proof keys; failed
proof, session revocation, token file/identity mismatch, expiry, readonly write,
lock matrix, streaming limit/abort, traversal/collision, cache hash invalidation,
cross-user same UUID, save emits SSE, keys rotation. API+contracts typecheck and
full coverage thresholds; Biome touched files. Real SFTP integration verifies
saved bytes and rename behavior under separate credentials; no live dev mutation.
Report contracts/interfaces first, final files/gate output/gaps and branch/path.
