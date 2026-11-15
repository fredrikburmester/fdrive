# Authentication

A user signs in with `{ username, password }`, and fdrive checks the password
against the scrypt hash in `app.local_users` (see [Local users](#local-users)).
fdrive keeps no other copy of any password. The files folder is one row in
`app.providers`, created from `FDRIVE_STORAGE_ROOT`, and every identity is bound
to it (see [storage](STORAGE.md)). This document describes that
design as implemented in `apps/api/src/auth/` and `apps/api/src/local/`.

Administrators are the accounts with `accounts.is_admin`: the setup owner, and
anyone an administrator makes one under System > Users.

## What is stored, and how it is encrypted

On a successful login (`POST /api/v1/auth/login`, `apps/api/src/auth/service.ts`):

- The password is checked once (`apps/api/src/auth/password.ts`, behind the
  [limiter](#login-rate-limiting)) and is never stored or logged.
- fdrive finds the user's login (`identities` row) by username, without regard
  to case, and records the sign-in on it. Every user has exactly one login
  from the moment they exist, and an account has exactly one login
  (`identities.account_id` is unique).
- A session row is created (`sessions` table) holding only a SHA-256 hash of
  a randomly generated session id and the login it acts as (`identity_id`);
  the raw id is set as an HttpOnly cookie and never persisted itself. Every
  request on the session acts as that login; there is no header or parameter
  that selects another.

The secrets fdrive does keep (backup destination keys, AI provider keys) and share link cookies are sealed by an envelope scheme
(`apps/api/src/auth/crypto.ts`); Office tokens are signed with a key derived
from the same master key:

- `FDRIVE_MASTER_KEY` is a 32-byte AES-256 key, base64-encoded in the
  environment.
- Each secret is encrypted under its own fresh random 32-byte data key with
  AES-256-GCM.
- That data key is itself wrapped (encrypted) with AES-256-GCM under the
  master key.
- Both encryption layers use what the secret belongs to (such as
  `backup-destination:<id>`) as additional authenticated data (AAD), so a
  sealed blob cannot be decrypted, even with the right master key, for
  anything else.
- The wire format is a single versioned byte string:
  `0x01 | wrapIv(12) | wrappedKey(32) | wrapTag(16) | iv(12) | tag(16) | ciphertext`.

This means rotating `FDRIVE_MASTER_KEY` invalidates every previously sealed
secret at once: backup destinations and AI keys have to be entered again, and
share link cookies and Office tokens stop working. Sign-ins and sessions are
unaffected, since no password is sealed.

## Setup ownership

Setup is open only on a fresh install: no owner record (`setup.owner.v1`), no
row in `app.local_users`, no account and no login. Once anyone has used fdrive
it never reopens, whatever any setting says, and deleting every user does not
reopen it either, since their logins and accounts remain. Setup runs in one
transaction under the advisory lock that every user-creating or
administrator-removing write takes: it checks the install is still fresh,
creates the owner's `local_users` row, a new administrator account and a new
login (never one left behind), and inserts the owner record, which is never
overwritten (`setup_claimed` if it already exists). A refused setup writes
nothing, and of two racing setups exactly one owner remains. The owner record
names who manages [backups](BACKUPS.md). The owner is then signed in through
the same password check as anyone else.

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

## Storage sessions

fdrive asks for a password only at sign-in, setup, password change and
unlocking backups. Storage for a request is built by the identity storage
factory (`apps/api/src/auth/storage-factory.ts`) from the login's username
alone. Before storage is built, the files folder's `admit` refuses a disabled
or removed user, so disabling someone stops them at once rather than at their
next sign-in: every request of theirs gets `forbidden`, since signing in again
would not help. A login that no longer exists gets `unauthorized`.

## The `reauth_required` flow

Backup administration is the one place that asks for the password again: its
sensitive routes answer `reauth_required` (HTTP 401, distinct from a plain
`unauthorized`) until the owner confirms their password, and System > Backups
locks itself on that kind instead of signing out.

## Login rate limiting

`apps/api/src/auth/login-limiter.ts` implements a simple, in-memory,
per-process limiter. Every password check goes through one function
(`apps/api/src/auth/password.ts`): sign-in, setup's sign-in, changing one's own
password and unlocking backups, so a failure at any of them counts at all of
them. It consults two keys: a `${block}|${username}` key, the name in lower
case since names are unique in any case, and an independent
`login-ip|${block}` key shared by every username tried from that address,
so one address cannot spray a password across many usernames. `block` is
the caller's address block (`apps/api/src/auth/address-block.ts`): an IPv4
address as it stands, and an IPv6 address folded into its /64, because a
single IPv6 host is routinely handed a whole /64 to source from and would
otherwise draw a fresh allowance for every attempt. Each key follows the
same policy: after 5 failed attempts within a 60-second window it is
blocked for 60 seconds (`rate_limited`, with `retryAfterMs` in the error
details). A name no user can have counts as a wrong password; a disabled
user with the right password gets `forbidden` and counts nothing. A
successful login clears that username key's failure history
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

## Session revocation

These events revoke sessions server-side:

- A local user changing their own password, or an administrator resetting it,
  disabling the user or removing them (see [Local users](#local-users)).

Every way fdrive changes a password ends that account's other sessions, so
signing in never needs to: signing in again leaves other devices signed in.

## Local users

`app.local_users` holds one row per local user: a username, unique in any case
because homes may sit on a case-insensitive disk, a scrypt hash and a
disabled flag. Each user's files are `<FDRIVE_STORAGE_ROOT>/<username>`.
Administration is `apps/api/src/local/service.ts` behind
`/api/v1/admin/users` (administrators only, System > Users):

- **Setup** creates the first user from the username and password the owner
  chooses, in one transaction (see [Setup ownership](#setup-ownership)).
- **Add** creates the user, an account and their login in one transaction, so
  they can be made an administrator before they first sign in. Every user has
  a login from the moment they exist, and sign-in only looks it up.
- **Reset password** and **disable** end every session of that user, except
  the administrator's own when they act on themselves. Nobody can disable
  themselves or remove their own administrator rights, and the last enabled
  administrator account can be neither disabled, demoted nor removed: the
  check runs in the same locked transaction as the change, so two
  administrators removing each other leave one.
- **Remove** stops the user signing in, ends their sessions, deletes their API
  tokens and removes administrator rights. Their files and fdrive data (tags,
  favorites, shares, activity) stay with the name, so adding the same name
  again gives them back, without the access that was revoked. The same name
  in another case is refused, since on a case-sensitive disk it is another
  home folder.

A local login changes its own password with `POST /api/v1/auth/password`
(Account > Password): the current password is checked like a sign-in, behind
the same limiter, the hash is replaced, and the account's other sessions end.

## MCP token grants

Every personal token persists required `app.api_tokens.access` JSON with `mode` and normalized
virtual `paths`. A token acts as the login of the session that created it
(`api_tokens.identity_id`, required, deleted with the login), with Read access unless asked
otherwise. Token principal resolution validates stored grants and includes them on every
request; malformed access fails closed.
See [MCP](MCP.md) for the mode matrix.
