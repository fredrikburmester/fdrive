#!/bin/bash
# Preserve an existing profile-based deployment when update.sh moves it to
# UI-managed workers. Only actually running legacy services opt in; stopped
# services remain off. A fresh database is deliberately untouched.
set -euo pipefail

compose_args=("$@")
services="$(docker compose "${compose_args[@]}" ps --status running --services 2>/dev/null || true)"
[[ -n $services ]] || exit 0

# A managed installation may be freshly initialized, before the API has written
# its first configuration row. Its fixed stack is intentionally all running,
# so service presence cannot be used to infer feature choices. Inspect only the
# explicit marker, never the complete environment (which contains secrets).
api_id="$(docker compose "${compose_args[@]}" ps -q api 2>/dev/null || true)"
if [[ -n $api_id ]] && docker inspect -f '{{range .Config.Env}}{{if eq . "FDRIVE_FEATURES_MANAGED=true"}}managed{{end}}{{end}}' "$api_id" 2>/dev/null | grep -qx managed; then
  exit 0
fi

# Only migrate established legacy installations. Check each relation before
# querying it: PostgreSQL resolves a missing relation before a WHERE guard.
psql_query() {
  docker compose "${compose_args[@]}" exec -T db psql -U fdrive -d fdrive -Atq -c "$1" 2>/dev/null || true
}
[[ "$(psql_query "SELECT to_regclass('app.settings') IS NOT NULL;")" == t ]] || exit 0
[[ "$(psql_query "SELECT to_regclass('app.identities') IS NOT NULL;")" == t ]] || exit 0
[[ "$(psql_query "SELECT EXISTS (SELECT 1 FROM app.identities);")" == t ]] || exit 0
db_ocr_globs="$(psql_query "SELECT EXISTS (SELECT 1 FROM app.settings WHERE key = 'indexer.ocr_image_globs' AND jsonb_typeof(value) = 'array' AND jsonb_array_length(value) > 0);")"

has() { grep -qx "$1" <<<"$services"; }
thumbs=false; text=false; ocr=false; semantic=false; image=false; pdf=false
legacy_ocr_globs=""
has indexer && { thumbs=true; text=true; }
# The legacy default did not OCR images. Preserve only an explicit database
# setting or a non-empty legacy container value; do not create new OCR work.
if has indexer; then
  indexer_id="$(docker compose "${compose_args[@]}" ps -q indexer 2>/dev/null || true)"
  indexer_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$indexer_id" 2>/dev/null || true)"
  legacy_ocr_globs="$(grep '^OCR_IMAGE_GLOBS=.' <<<"$indexer_env" | head -n 1 | cut -d= -f2- || true)"
  if [[ $db_ocr_globs == t ]] || [[ -n $legacy_ocr_globs ]]; then
    ocr=true
  fi
fi
has indexer && has embed && semantic=true
has indexer && has image-embed && image=true
has ocr && pdf=true
json=$(printf '{"version":1,"revision":0,"values":{"thumbnails":%s,"textSearch":%s,"searchOcr":%s,"semanticSearch":%s,"imageSearch":%s,"pdfOcr":%s},"walkthroughComplete":true}' "$thumbs" "$text" "$ocr" "$semantic" "$image" "$pdf")
docker compose "${compose_args[@]}" exec -T db psql -U fdrive -d fdrive -v ON_ERROR_STOP=1 \
  -v feature_json="$json" -v legacy_ocr_globs="$legacy_ocr_globs" --file=- >/dev/null <<'SQL'
INSERT INTO app.settings(key,value)
VALUES ('features.configuration', :'feature_json'::jsonb)
ON CONFLICT (key) DO NOTHING;
INSERT INTO app.settings(key,value)
SELECT 'indexer.ocr_image_globs', to_jsonb(ARRAY(
  SELECT btrim(glob)
  FROM unnest(string_to_array(:'legacy_ocr_globs', ',')) AS glob
  WHERE btrim(glob) <> ''
))
WHERE :'legacy_ocr_globs' <> ''
ON CONFLICT (key) DO NOTHING;
SQL
