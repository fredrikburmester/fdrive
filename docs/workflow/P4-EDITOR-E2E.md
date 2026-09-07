# P4 real editor acceptance

Implementer tooling/test chunk; isolated checkout supplied by primary with reviewed
UI and latest API dependencies. No production app edits; report product failures to
primary/API worker. Never stash, change Git state or delegate. Others active.
Own apps/web/office-e2e/**, apps/web/playwright.office.config.ts,
apps/web/e2e/support/environment.ts only for backwards-compatible fixture options,
apps/web/package.json and root package.json for scripts, tools/office test fixture
helpers if needed (no key/runtime production changes), docs/OFFICE-TESTS.md.

Build reproducible opt-in real-browser suite with pinned deployed ONLYOFFICE and
Collabora images/configs from deploy/office. Separate project/container volumes,
random fixture JWT, API/web ports distinct from dev3001/3002 and ordinary e2e.
Suggested39421/39422 API/web,59490/59491 office. Reuse testkit SFTPGo/Postgres and
existing web shadow build machinery; no fake WOPI/storage/proof/office callbacks.
Seed two writers Alice/Bob and readonly Reader sharing one physical SFTP home;
admin setup only touches isolated fixture. Set constant canonical home template so
both users get same registry UUID. Bind host API0.0.0.0 for container callbacks;
configured WOPI URL host.docker.internal:<port>/wopi, public web/browser localhost.
Collabora allowlist/CSP/server_name match fixture ports. Keys persistent during test
but all owned containers/volumes/env state cleaned finally; never touch dev services.
Reuse actual deployment wrappers/keys. Test startup bounded; secrets never printed,
URLs/token-bearing browser traces not committed. Keep generated output ignored.

Acceptance from PLAN: for docx/xlsx/pptx create through UI, open/edit/save/reopen as
TWO different authenticated browser contexts in SAME co-edit session, verify saved
file bytes through SFTPGo (unzip content and assert edits). Readonly opens currently
locked file and cannot mutate; save-as + rename from INSIDE editor land in SFTPGo;
external edit over actual SFTP preserves same-size/same-second where feasible,
next new editor open gets fresh content/version; second configured product passes
Collabora open/edit/save/reopen smoke. Verify trusted postMessage flow and no frame
startup error. Include filenames with literal percent sequences/Unicode.
Do not replace real UI edit with hand-crafted WOPI calls and call it editor e2e.
Use observed editor DOM/accessibility/keyboard interactions. Parent will also inspect
running main app browser pane. Failures can reveal host integration issues; report
precise evidence and keep suite failing until primary integrates fixes. No skips or
weakened assertions simply to reach green. If server restrictions prevent an actual
operation, establish cause with real responses before proposing requirement changes.

Run changed-file Biome, web/tool typecheck and dedicated suite (serial per product).
Never overlap Turbo with Playwright in same checkout. Existing e2e defaults unchanged.
Report measured acceptance matrix, files, failures/gaps, branch and checkout.
