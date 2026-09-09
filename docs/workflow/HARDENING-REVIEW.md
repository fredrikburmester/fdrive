# Deployment hardening review (2026-09-07)

Read-only review of the production deployment, requested by the user as the next safety
step after trash. Findings are ordered by how much risk they remove; sizes are rough lines
of change. Items 1–4 should land before connecting a real instance to the internet.

Update 2026-09-08: the user selected direct LAN onboarding as the default. The fixed-HTTPS
assumption in item 4 and loopback web binding in item 8 are superseded: web listens on all
interfaces and uses HTTP by default. HTTPS edges need no setting: the bundled proxy passes a
private-network edge's `X-Forwarded-Proto` through (2026-09-09: replaced `FDRIVE_PROXY_SCHEME`
and `FDRIVE_PUBLIC_URL`; a LAN client forging `https` only breaks its own session);
see [current network setup](../../deploy/REFERENCE.md#network-placement--reverse-proxies).

| # | Change | Severity | Where | Size |
| --- | --- | --- | --- | --- |
| 1 | Loopback-bind SFTPGo's admin port in the opt-in overlay (`127.0.0.1:…:8080`), comment out the SFTP port, move the host port off the `FDRIVE_HTTP_PORT` default (8090 collides) | High | `deploy/compose.sftpgo.yaml` | 5 |
| 2 | Exclude `.env*` (keep `.env.example`), `.worktrees`, `deploy/dev/.data`, `.pnpm-store` from the Docker build context | High | `.dockerignore` | 8 |
| 3 | Stop trusting the first `X-Forwarded-For` hop (Caddy appends, so the first hop is attacker-chosen); take the last hop or a configured trusted-hop count. Every rate limit (share, login, setup, account link) keys on it | High | `apps/api/src/net.ts`, `config.ts` | 15 |
| 4 | Session cookies are never `Secure` in the documented deployment: Caddy listens on `:80` and sets `X-Forwarded-Proto: http`, `FDRIVE_COOKIE_SECURE=auto` follows it. Default `true` in `.env.example` and add `header_up X-Forwarded-Proto https` for the api/web upstreams | High | `deploy/.env.example`, `deploy/Caddyfile`, `deploy/office/Caddyfile.*` | 7 |
| 5 | Bound the login limiter map (capacity + sweep like `shares/limiter.ts`); today an attacker forging IPs grows it without bound | Medium | `apps/api/src/auth/login-limiter.ts` | 8 |
| 6 | Security headers for the web app: CSP with `frame-ancestors 'self'` and `frame-src` for the office origin, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy` | Medium | `apps/web/next.config.ts` | 25 |
| 7 | Redact `/mcp/t/:token` in the request log; `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on MCP responses | Medium | `apps/api/src/app.ts`, `apps/api/src/mcp/routes.ts` | 5 |
| 8 | Remove the public `/wopi/*` Caddy routes (callbacks use the internal `http://api:3001/wopi`); loopback-bind the published proxy port | Medium | `deploy/Caddyfile`, `deploy/office/Caddyfile.*`, `deploy/compose.yaml` | 10 |
| 9 | Run the indexer as non-root; pin `text-embeddings-inference:cpu-latest` and `ocrmypdf:latest` to version plus digest | Medium | `services/indexer/Dockerfile`, `deploy/compose.yaml`, `services/ocr/Dockerfile` | 6 |
| 10 | `no-new-privileges`, `cap_drop: [ALL]`, log rotation and `pids_limit` on proxy/web/api/db; `0600` on generated env files; a "Network placement" section in `deploy/README.md` | Medium | `deploy/compose.yaml`, `tools/dev/ensure-env.ts`, `deploy/README.md` | 35 |

Lower priority: setup token is logged at info (write to a 0600 file instead); `/about` reveals
the SFTPGo host to anonymous callers; `parseBody` has no size cap; `PUT share upload` has no
byte ceiling; outbound probes follow redirects; `web` image has no healthcheck; `ci.yml` and
`performance.yml` lack `permissions:` and timeouts.

Verified as correct and worth keeping as-is: share traffic is fully proxied with no redirect
or base URL leak and a well-built credential cookie; office editing is deny-by-default in
every overlay with fail-closed evaluation re-checked inside the file lock; WOPI proof
verification has no off-switch and the proof URL comes from config, not the Host header;
office containers are unpublished in production; the default compose has no SFTPGo; CSRF
uses `sec-fetch-site` plus the custom header; no CORS; setup cannot be re-run; CI never
runs fork code with secrets.

Planned as chunk `hardening-1` (items 1–5 and 7–8, deploy files plus `net.ts`,
`login-limiter.ts`, `app.ts`) and `hardening-2` (items 6, 9, 10 and the lower-priority list).
