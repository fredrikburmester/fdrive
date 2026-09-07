# P5 production deployment completion (queued)

Primary review found production compose API never receives index roots/indexer/embed/thumb configuration although index services exist. Phase completion requires a deployable stack, not only dev wiring.

Ownership when assigned: deploy/compose.yaml, deploy/.env.example, new docs/DEPLOYMENT.md, README deployment link, focused deployment validation tooling/tests. Office worker temporarily owns .env.example; wait for release. No model/provider feature work; preserve current pinned project defaults.

Decisions: explicit optional API env FDRIVE_INDEX_ROOTS (JSON array of name/sftpgoPath/indexerPath), FDRIVE_INDEXER_URL, FDRIVE_EMBED_URL, FDRIVE_THUMBS_DIR and admin usernames. Empty roots keep no-index base stack usable. Document exact index-enabled env values and --profile index startup; match indexer INDEX_ROOTS and filesystem volume mappings. API thumbnail volume read-only; indexer existing write volume retained. API does not need originals mounted. Internal services remain unpublished; Caddy owns public origin and overwrites forwarded headers. No automatic connections to user's live SFTPGo.

Production Docker images must build with Node24/pnpm frozen lockfile and all workspace prerequisites; verify both base and index/Office overlay compose configs with nonsecret fixture values. Build actual API/web images and exercise isolated composed app login/list/upload/download/share public route through proxy plus index status/thumbnail with disposable mounted fixtures. Preserve unrelated dev services and volumes; unique compose project/temp dirs. Don't use production user data. Resolve actual build/config errors rather than claiming local dev proves deployability. Document migrations, secrets, required trusted mappings and explicit Office default-deny edit policy. No default passwords in production config. No deployment to external server requested.

Parent reviews all env/config/security changes, runs final full gates and records proof. Workers never Git mutate/stash/delegate. No worker assigned yet.
