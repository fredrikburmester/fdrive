# Authentication

fdrive authenticates against the storage provider in credential mode: a user
signs in with the credential their provider's module asks for (for SFTPGo:
username, password and an optional one-time code, sent as
`{ providerId?, credential: { username, password, otp? } }`), and fdrive keeps
that credential (and, for SFTPGo, the short-lived JWT it issues) so it can act
on the user's behalf for every subsequent storage call, without asking them
to log in again on every request. Providers are rows in `app.providers`; an
identity is bound to one row and a stored credential is only ever sent to
that row's endpoint (see
[Adding a storage provider](STORAGE-PROVIDERS.md#isolation-and-lifecycle-requirements)). This document describes that design as implemented in `apps/api/src/auth/` and
`apps/api/src/providers/`.

`FDRIVE_ADMIN_USERS` grants apply only to usernames on the SFTPGo endpoint named
by `SFTPGO_URL`. The same username on another provider gains no administrator
access. Persisted `accounts.is_admin` grants remain account-wide.

## What is stored, and how it is encrypted

On a successful login (`POST /api/v1/auth/login`, `apps/api/src/auth/service.ts`):

- fdrive finds or creates an `account` and a `provider`-scoped `identity` for
  the SFTPGo username (one account can hold several identities, one per
  SFTPGo user it is linked to).
- The plaintext password is sealed and written to the `credentials` table as
  `{ identityId, ciphertext, keyId }`. It is never stored in plaintext and
  never logged.
- The SFTPGo JWT that `sftpgo.login` already returned for this same call is
  sealed and cached on the same row (`prime`, see below), rather than being
  re-minted.
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
rather than a crash, so the practical effect of a key rotation is that every
signed-in user is asked to log in again the next time their cached token
needs to be read or re-minted.

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
    request's own URL scheme.

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

## Token minting and re-minting

fdrive never asks the browser for SFTPGo credentials outside of `/auth/login`.
Every storage call instead goes through a `TokenSource`
(`apps/api/src/auth/token-source.ts`), which is responsible for producing a
currently-valid SFTPGo JWT for an identity:

1. `get(identityId)` first checks its in-process cache, then the database's
   cached (sealed) token, and only mints a fresh one from the stored,
   unsealed password as a last resort. A token is treated as due for
   re-minting once fewer than 2 minutes remain before it expires, not only
   once it has actually expired, so a request in flight does not race an
   expiry.
2. `sessionFor(identityId, username)` hands the provider module a
   `StorageSession` with `getToken`, `invalidateToken` and `getCredential`.
   The SFTPGo module's storage runs each call with the current token and,
   on a `401` from SFTPGo, invalidates the cached token, mints a fresh one,
   and retries exactly once (`packages/sftpgo/src/module.ts`). This is what
   lets fdrive recover transparently from SFTPGo revoking a token early (for
   example, an admin forcing a logout) without surfacing an error to the
   user. Minting itself is the module's `mint`; a provider module without
   one (a backend that signs every request from the credential) gets `null`
   tokens and never touches this cache.
3. `prime(identityId, token)` seals and stores a token the caller already
   has, without minting a new one. `authService.login` calls `prime` with
   the token its own `sftpgo.login` call just returned, so a fresh fdrive
   login mints exactly one SFTPGo token, not two: one from the login itself,
   plus a would-be second one if the token cache were instead filled by
   calling `get` right after.

## The `reauth_required` flow

Three situations end a storage or token operation with the API error kind
`reauth_required` (HTTP 401, distinct from a plain `unauthorized`, so a
client can tell "you were never signed in" apart from "you were signed in,
but fdrive can no longer act on your behalf"):

- The stored password is rejected by SFTPGo when fdrive tries to mint a
  token with it (the user changed their SFTPGo password outside of fdrive,
  or an admin disabled/removed the account).
- A sealed credential or cached token fails to decrypt (`CryptoError` from
  `open`), most commonly because `FDRIVE_MASTER_KEY` was rotated after the
  secret was sealed under the previous key.
- The identity or its stored credential row no longer exists.

In every case the fdrive session itself may still be valid; the user simply
has to sign in again (`POST /api/v1/auth/login`) to re-establish a usable
SFTPGo credential. fdrive does not attempt to distinguish these cases in the
response beyond the error kind and message, since the remedy is the same.

## Login rate limiting

`apps/api/src/auth/login-limiter.ts` implements a simple, in-memory,
per-process limiter. Every credential check (login, setup, and the owner
re-authentication that identity linking requires) consults two keys: a
`${ip}|${username}` key, and an independent `login-ip|${ip}` key shared by
every username tried from that address, so one address cannot spray a
password across many usernames. Each key follows the same policy: after 5
failed attempts within a 60-second window it is blocked for 60 seconds
(`rate_limited`, with `retryAfterMs` in the error details). A successful
login clears the `ip|username` key's failure history immediately but never
the address key, so knowing one valid login cannot reset the spraying
bound; the address key only drains as its window and block expire. Because
the limiter is in-memory, it resets on process restart and is not shared
across multiple api instances; this is an accepted simplification for
fdrive's current single-instance deployment shape.

## Re-authentication and session revocation

Linking another SFTPGo login (`POST /api/v1/account/identities`) requires
the signed-in login's own password (`currentPassword`, plus `currentOtp`
when SFTPGo enforces TOTP for it) in addition to the new login's
credentials, and unlinking one (`DELETE /api/v1/account/identities/:id`)
requires the same fields as its JSON body. A stolen cookie is therefore not
enough to plant a durable login path on the account, nor to detach and sign
out the owner's other logins.

Two events revoke sessions server-side:

- A login whose password differs from the credential fdrive has stored for
  that identity (or whose stored credential is missing or undecryptable)
  deletes every other session of the account inside the same transaction
  that stores the new credential. Changing the SFTPGo password and signing
  in again is how a user locks a stolen session out. Logging in again with
  the unchanged password leaves other devices signed in.
- Unlinking a login deletes every session that was using it as its active
  identity, except the requesting session, which moves to a remaining login
  and is rotated as before.

## Known limitation: SFTPGo TOTP enforced for HTTP

SFTPGo can require a one-time password (`otp`) on `GET /api/v2/user/token`
per user. fdrive's login endpoint accepts and forwards an `otp` for the
initial login, so signing in works normally for such a user. However,
`TokenSource`'s re-minting path (used whenever a cached token expires or is
revoked) calls the same SFTPGo login endpoint again using only the stored
password, with no way to supply a fresh one-time code. For a user with TOTP
enforced for HTTP, re-minting therefore fails with `reauth_required` as soon
as their cached token expires (by default, roughly every 20 minutes, per
SFTPGo's own token TTL), even though their fdrive session cookie is still
valid. In practice this means such a user is asked to sign back in to fdrive
periodically, more often than a user without TOTP enforced. There is no
current workaround beyond disabling TOTP enforcement for HTTP on the SFTPGo
side, or accepting the more frequent re-authentication.
