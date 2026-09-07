# P4-DEPLOY

Implementer chunk, PLAN.md §8 and P4-HOST-DESIGN.md. Worktree supplied at launch.
Never stash, mutate Git state or delegate. Other agents own API/DB/web. Preserve
their edits. Own deploy/compose.office*.yaml, deploy/office/**, tools/office/**,
docs/OFFICE.md only. No root manifests or existing compose/proxy files in this
chunk; use overlays with their own proxy config if necessary. Tell parent exact
shared-file additions needed.

Build opt-in ONLYOFFICE and Collabora product overlays for production and host-run
dev. Pinned images onlyoffice/documentserver:9.4.0.1 and collabora/code:26.04.2.2.1
(verify available image architecture/digest; primary pulling both). Office is off
unless selected, not a dependency of normal dev environment. Each dev service
binds loopback (58090 ONLYOFFICE, 58091 Collabora), callback URL uses
http://host.docker.internal:3001/wopi. Production callbacks http://api:3001/wopi.
Do not edit live .env files. Document required API settings proposed below.

Verify actual pinned ONLYOFFICE entrypoint before configuring keys. Current source
sets key files under DATA_DIR regardless of similarly named env variables. Persist
deployment-generated keys in a dedicated volume, ensure discovery modulus matches
that private key, restart preserves it, and two fresh deployments have distinct
keys. No source-controlled secrets. Fixed deployment JWT secret must be supplied
from operator environment, generated dev secret into ignored local data by helper.
Private-IP requests enabled for internal callback; metadata IP access disabled.
Never disable TLS verification. Configure external URL forwarding correctly.

Collabora requires generated RSA PEM/OpenSSH proof pair (`coolconfig
generate-proof-key`), readable by its service user, persisted privately. Verify
discovery actually publishes current proof keys; host will require signatures.
Use minimum documented capabilities, no privileged mode. Pin callback allowlist,
frame-ancestor host and TLS termination configuration. Smoke discovery and basic
editor assets; actual document edit tests follow host implementation.

API settings reserved by primary: FDRIVE_OFFICE_PRODUCT=onlyoffice|collabora,
FDRIVE_OFFICE_URL trusted internal discovery URL, FDRIVE_OFFICE_PUBLIC_URL browser
reachable origin/base path, FDRIVE_WOPI_URL callback base ending /wopi,
FDRIVE_PUBLIC_URL app origin, FDRIVE_OFFICE_MAX_BYTES default104857600.
Dev can use direct editor port rather than same-origin proxy; production include
documented reverse proxy routing with websocket support and correct origin.

Tools may be Node24 TS run with existing tsx; pure helpers get colocated Vitest
tests using existing config. No new dependencies or manifests. Setup helper must
be idempotent, avoid overwriting keys, never print private key/secret, and avoid
accidental cleanup of unrelated volumes/containers. Run compose config validation,
new helper tests/typecheck/Biome, and start disposable office containers to prove
discovery/assets/key persistence. Record precise commands in docs/OFFICE.md.
Report changed files, gate output, image digest/platform, live containers/ports,
shared-file requests and limitations. Leave only explicitly named dev services
running; remove disposable verification fixtures after checking keys.
