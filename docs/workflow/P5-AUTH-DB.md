# P5 atomic login and session extension

Next implementer DB chunk, after shares repository. Isolated checkout assigned at
launch. Own identity-links.ts/types/tests/integration, provider repo real+memory
implementation/types/tests, DB index exports/config as needed. No API/contracts/UI.
Never stash/git state changes/delegate. Other workers active; preserve their files.

Extend IdentityLinksRepo with:
loginVerified({providerId,username,at,sealCredential,
 session:{idHash,expiresAt,userAgent,ip}})->Promise<{identity:Identity,session:Session}>.
Caller already verified exact upstream credentials. Under same provider+username
advisory gate as link, find or create account+identity atomically; lock existing
account, recheck ownership, seal actualUUID, refresh credentials/cache, touchlogin,
create requesting session on current owning account. No orphan account on races,
no session referencing identity owned by anotheraccount. Newaccount nonadmin.
Input canonical IDs/SHA256hash, validboundedstrings/dates, expiresAt>at.

rotateSession({accountId,oldSessionIdHash,newSessionIdHash,activeIdentityId,at})
 ->Promise<Session>. Lock identity location and account in existing order; require
oldsession nonexpired and owned, targetidentity currentlyowned; atomically create
newsession preserving absoluteexpiresAt/userAgent/IP and revokeold. No expiry
extension; newhashdifferent/canonical. Duplicatehash/error rollsbackoldrevocation.

Optional requestingSessionIdHash on existing linkVerified and unlink input.
When present require live owned session under account/identity locks before any
mutation. ProductionAPI always supplies it; existing repository callers/tests
remain sourcecompatible. Wrong/expired/revoked session->invalid_session withzero
ownership/credential/metadatachanges. Reuse typederrors.

ProviderRepo.get(id)->Promise<Provider|null> in real and memory providers. Validate
IDs matching existing repo conventions. Needed for actual peridentity providerlabel.

Tests: simultaneous ordinarylogin/newlink sameusername fromtwo pools, loginracing
transfer/unlink, no orphanaccounts/foreignsession; credentialssealrollback; live
requestingsession checks; sessionrotationpreservesexpiry/UA/IP, revokesold, duplicate
newhash rollback, logout/transfer races, foreign/expiredsession rejection. RealDB
integration +purevalidators coverage100; fullDB gates and reportbranch/files/results.
