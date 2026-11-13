# Authentication

fdrive authenticates in credential mode: a user signs in with
`{ providerId?, credential }`, where the credential is `{ username, password }`,
and the local module checks it. fdrive is the authority: the user is a row of
`app.local_users` (see [Local users](#local-users)). The files folder is one row
in `app.providers`, created from `FDRIVE_STORAGE_ROOT`, and every identity is
bound to it (see [storage port](STORAGE-PROVIDERS.md)).
This document describes that design as implemented in `apps/api/src/auth/`,
`apps/api/src/local/` and `apps/api/src/providers/`.

`FDRIVE_ADMIN_USERS` names local usernames: it applies only to logins on the row
the deployment pins (the files folder). Persisted `accounts.is_admin` grants
remain account-wide.

## What is stored, and how it is encrypted

On a successful login (`POST /api/v1/auth/login`, `apps/api/src/auth/service.ts`):

- fdrive finds or creates an `account` and a `provider`-scoped `identity` for
  the username the module returned (one account can hold several identities,
  one per login it is linked to).
- The credential is sealed and written to the `credentials` table as
  `{ identityId, ciphertext, keyId, cachedToken, cachedTokenExpiresAt }`. It is
  never stored in plaintext and never logged. For a local login the password
  itself is checked against the scrypt hash in `app.local_users`; the sealed
  copy lets a later login tell whether the password changed (below).
- A session row is created (`sessions` table) holding only a SHA-256 hash of
  a randomly generated session id; the raw id is set as an HttpOnly cookie
  and never persisted itself.

Encryption (`apps/api/src/auth/crypto.ts`) is an envelope scheme:

- `FDRIVE_MASTER_KEY` is a 32-byte AES-256 key, base64-encoded in the
  environment.
- Each secret (a password or a token) is encrypted under its own fresh
  random 32-byte data key with AES-256-GCM.
- That data key is itself wrapped (encrypted) with AES-256-GCM under the
  master key.
- Both encryption layers use the identity id as additional authenticated
  data (AAD), so a sealed blob cannot be decrypted, even with the right
  master key, against the wrong identity.
- The wire format is a single versioned byte string:
  `0x01 | wrapIv(12) | wrappedKey(32) | wrapTag(16) | iv(12) | tag(16) | ciphertext`.

This means rotating `FDRIVE_MASTER_KEY` invalidates every previously sealed
secret at once: any attempt to unseal one afterwards fails GCM
authentication. fdrive treats that failure as `reauth_required` (see below)
rather than a crash. Local storage reads no stored credential per request, so
a rotation interrupts no one; each user's next sign-in replaces the
undecryptable copy and ends the account's other sessions (see
[Re-authentication](#re-authentication-and-session-revocation)).

## Setup ownership

Setup claims ownership in the same database transaction that persists the candidate login.
A losing claimant rolls back newly created auth records and preserves pre-existing ones;
the setup service then removes the local user it created. The pending owner can resume
after a failure. Granting administrator status still precedes finalizing setup, so a partial
failure does not leave a completed installation without an owner. Without
`FDRIVE_STORAGE_ROOT` setup refuses to complete (`bad_request`).

## Session cookie

The session cookie (`apps/api/src/auth/sessions.ts`) is named
`fdrive_session` and carries only the raw (unhashed) session id. It is set
with:

- `Path=/`
- `HttpOnly` (never readable from JavaScript)
- `SameSite=Lax`
- `Max-Age` set to `FDRIVE_SESSION_TTL_DAYS` (default 30) days, in seconds
- `Secure`, controlled by `FDRIVE_COOKIE_SECURE`:
  - `"true"`: always set.
  - `"false"`: never set (useful for plain-http local development).
  - `"auto"` (default): set when the request arrived over https, judged from
    `X-Forwarded-Proto` (the bundled proxy passes an edge proxy's value through
    and otherwise sets it from the connection) or, without the header, from the
    request's own URL scheme. Only the entry the outermost trusted proxy wrote
    counts: `FDRIVE_TRUSTED_PROXY_HOPS` entries from the right of the header,
    so a client prepending `http` cannot strip `Secure`. A chain shorter than
    the trusted hop count clamps to the outermost entry present instead of
    being ignored, which is where this differs from the `X-Forwarded-For` rule
    in `extractClientIp`: proxies replace `X-Forwarded-Proto` (nginx's
    `proxy_set_header`) rather than append to it, so one entry is what a
    multi-hop deployment normally sends, and a client can only add entries to
    the header, never remove them. `FDRIVE_TRUSTED_PROXY_HOPS=0` still ignores
    the header entirely.

State-changing requests under `/api/v1/*` (`POST`, `PUT`, `PATCH`, `DELETE`)
must also pass a CSRF guard: `Sec-Fetch-Site` must be absent, `same-origin`,
or `none`, and the request must carry `X-Requested-With: fdrive`. Both
conditions together rule out a cross-site page silently reusing the cookie,
since neither header can be forged from a simple cross-site request without
triggering a CORS preflight that fdrive's default same-origin policy denies.

## Session sliding

A session's `expiresAt` is not extended on every request. `resolvePrincipal`
only pushes it forward (to `now + FDRIVE_SESSION_TTL_DAYS`) when the session
has not been touched in the last 5 minutes, and does so lazily as part of
handling the request rather than as a separate background job. This limits
the write load a sliding window would otherwise put on the `sessions` table.

Sliding never extends a session past `FDRIVE_SESSION_MAX_AGE_DAYS` (default
90) from the login that created it: `resolvePrincipal` deletes a session
whose `createdAt` is older than that and treats the request as anonymous, so
a stolen session id cannot be kept valid indefinitely by periodic use.
Session rotation on link and unlink preserves `createdAt`.

## Storage sessions and tokens

fdrive never asks the browser for storage credentials outside of `/auth/login`
and identity link/unlink confirmation. Every storage call instead goes through
a `TokenSource` (`apps/api/src/auth/token-source.ts`), whose
`sessionFor(identityId, username)` hands the provider module a
`StorageSession` with `getCredential`, `getToken` and `invalidateToken`; the
local folder calls none of them. Before storage is built for a request, the module's `admit`
runs where it exists: the local folder refuses a disabled or removed user
there, so disabling someone stops them at once rather than at their next
sign-in.

No shipped module has `mint`, so `getToken` returns `null`. The token cache
remains for a module that mints short-lived tokens: `get(identityId)` checks
its in-process cache, then the sealed cached token, and mints from the stored
credential only as a last resort, treating a token as due once fewer than 2
minutes remain. Concurrent misses for one identity share one mint;
invalidation and `prime` (store a token the login already returned) supersede
pending work, and per-identity database writes are ordered so an older mint
cannot restore a token after a clear or prime.

## The `reauth_required` flow

Three situations end a storage or token operation with the API error kind
`reauth_required` (HTTP 401, distinct from a plain `unauthorized`, so a
client can tell "you were never signed in" apart from "you were signed in,
but fdrive can no longer act on your behalf"):

- Storage answers `unauthorized`; storage routes map it to `reauth_required`.
- A sealed credential or cached token fails to decrypt (`CryptoError` from
  `open`), most commonly because `FDRIVE_MASTER_KEY` was rotated after the
  secret was sealed under the previous key.
- The identity or its stored credential row no longer exists.

In every case the fdrive session itself may still be valid; the user simply
has to sign in again (`POST /api/v1/auth/login`) to re-establish a usable
credential. fdrive does not attempt to distinguish these cases in the
response beyond the error kind and message, since the remedy is the same. A
disabled local user gets `forbidden` instead: signing in again would not help.

## Login rate limiting

`apps/api/src/auth/login-limiter.ts` implements a simple, in-memory,
per-process limiter. Every credential check (login, setup, and the owner
re-authentication that identity linking requires) consults two keys: a
`${block}|${provider}|${username}` key, and an independent
`login-ip|${block}` key shared by every username tried from that address,
so one address cannot spray a password across many usernames. `block` is
the caller's address block (`apps/api/src/auth/address-block.ts`): an IPv4
address as it stands, and an IPv6 address folded into its /64, because a
single IPv6 host is routinely handed a whole /64 to source from and would
otherwise draw a fresh allowance for every attempt. Each key follows the
same policy: after 5 failed attempts within a 60-second window it is
blocked for 60 seconds (`rate_limited`, with `retryAfterMs` in the error
details). A successful login clears that username key's failure history
immediately but never the address key, so knowing one valid login cannot
reset the spraying bound; the address key only drains as its window and
block expire.

The limiter tracks at most 10 000 keys at once and denies any key it has
no room for, so filling that map is a denial of service in itself. Each
username key is therefore passed with the block it belongs to, and one
block may hold at most 8 of them; further usernames from that block are
left untracked and bounded by its `login-ip|${block}` key instead. Nothing
is evicted to make room: dropping live failure counts or blocks under
pressure would let an attacker flush the very state that throttles them.
The number of distinct blocks stays unbounded, so a wide enough botnet can
still fill the map and lock logins out until it stops. Setup's own
`setup|${block}` key (`apps/api/src/setup/routes.ts`) uses the same block,
so onboarding cannot be used to mint a key per address either; it is
passed ungrouped like `login-ip|${block}`, since one block yields exactly
one of it and a group budget would have nothing to bound.

Because the limiter is in-memory, it resets on process restart and is not
shared across multiple api instances; this is an accepted simplification
for fdrive's current single-instance deployment shape.

## Re-authentication and session revocation

Linking another login (`POST /api/v1/account/identities`) requires the
signed-in login's own secret (`currentCredential: { password }`) in addition
to the new login's credentials, and unlinking one
(`DELETE /api/v1/account/identities/:id`) requires
`{ currentCredential: { password } }` as its JSON body. A stolen cookie is
therefore not enough to plant a durable login path on the account, nor to
detach and sign out the owner's other logins.

These events revoke sessions server-side:

- A local user changing their own password, or an administrator resetting it,
  disabling the user or removing them (see [Local users](#local-users)).
- A login whose password differs from the credential fdrive has stored for
  that identity (or whose stored credential is missing or undecryptable)
  deletes every other session of the account inside the same transaction
  that stores the new credential. Logging in again with the unchanged
  password leaves other devices signed in.
  Credential comparison happens under the identity/account persistence locks. A different
  credential committed since upstream authentication began rejects the delayed login;
  concurrent logins presenting the same new credential keep both sessions.
- Unlinking a login deletes every session that was using it as its active
  identity, except the requesting session, which moves to a remaining login
  and is rotated as before.

## Local users

`app.local_users` holds one row per local user: a username, unique in any case
because homes may sit on a case-insensitive disk, a scrypt hash and a
disabled flag. Each user's files are `<FDRIVE_STORAGE_ROOT>/<username>`.
Administration is `apps/api/src/local/service.ts` behind
`/api/v1/admin/users` (administrators only, System > Users):

- **Setup** creates the first user from the username and password the owner
  chooses; an interrupted setup resumes with the same password.
- **Add** creates the user and their login at once, so they can be made an
  administrator before they first sign in.
- **Reset password** and **disable** end every session of that user, except
  the administrator's own when they act on themselves. Nobody can disable
  themselves or remove their own administrator rights.
- **Remove** stops the user signing in, ends their sessions, deletes their API
  tokens and removes administrator rights. Their files and fdrive data (tags,
  favorites, shares, activity) stay with the name, so adding the same name
  again gives them back, without the access that was revoked.

A local login changes its own password with `POST /api/v1/auth/password`
(Account > Password): the current password is checked, the hash and the
sealed credential are replaced, and the account's other sessions end.

Coming from SFTPGo, the first start carries passwords over from fdrive's
sealed credentials: administrators can sign in at once, everyone else is
added disabled until an administrator enables them, and users who never
signed in to fdrive get a password from an administrator.

## MCP token grants

New personal tokens persist nullable `app.api_tokens.access` JSON with `mode` and normalized
virtual `paths`. Absent access identifies legacy tokens and preserves their old admission
rules. Token creation defaults to the authenticated session's active identity and Read access;
an explicitly selected identity must belong to that account. Token principal resolution
validates stored grants and includes them on every request; malformed access fails closed.
See [MCP](MCP.md) for the mode matrix and legacy `FDRIVE_MCP_WRITES` behavior.
