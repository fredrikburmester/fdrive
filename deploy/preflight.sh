#!/bin/bash
# Fails loudly on common deploy/.env mistakes before `docker compose up`:
# a leftover change-me placeholder, an unknown FDRIVE_* key (a likely
# typo), or a FDRIVE_HOME_TEMPLATE that does not look like
# <root>:<path with {username}>. Prints the resolved FDRIVE_INDEX_ROOTS and
# bind address so the operator sees exactly what will be used. Reads only
# deploy/.env; run automatically by update.sh before `up`, or directly:
#   ./preflight.sh
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="$script_dir/.env"

if [[ ! -f "$env_file" ]]; then
  echo "error: $env_file not found; copy .env.example to .env first (cp .env.example .env && chmod 600 .env)" >&2
  exit 1
fi

fail=0

if grep -q 'change-me' "$env_file"; then
  echo "error: $env_file still has a change-me placeholder value" >&2
  fail=1
fi

# BEGIN GENERATED KNOWN FDRIVE KEYS (tools/deploy/generate-env-example.ts)
KNOWN_FDRIVE_KEYS=(
    "FDRIVE_MASTER_KEY"
    "FDRIVE_HOME_TEMPLATE"
    "FDRIVE_SESSION_TTL_DAYS"
    "FDRIVE_SESSION_MAX_AGE_DAYS"
    "FDRIVE_COOKIE_SECURE"
    "FDRIVE_TRUSTED_PROXY_HOPS"
    "FDRIVE_PUBLIC_URL"
    "FDRIVE_AUTO_MIGRATE"
    "FDRIVE_TMP_DIR"
    "FDRIVE_JOB_MAX_BYTES"
    "FDRIVE_JSON_MAX_BYTES"
    "FDRIVE_ARCHIVE_PEEK_MAX_BYTES"
    "FDRIVE_SHARE_UPLOAD_MAX_BYTES"
    "FDRIVE_ADMIN_USERS"
    "FDRIVE_MCP_WRITES"
    "FDRIVE_OFFICE_PRODUCT"
    "FDRIVE_OFFICE_URL"
    "FDRIVE_OFFICE_PUBLIC_URL"
    "FDRIVE_WOPI_URL"
    "FDRIVE_OFFICE_MAX_BYTES"
    "FDRIVE_OFFICE_EDIT_RULES"
    "FDRIVE_DATA_DIR"
    "FDRIVE_COMPOSE_FILES"
    "FDRIVE_PROFILES"
    "FDRIVE_HTTP_BIND"
    "FDRIVE_PROXY_SCHEME"
    "FDRIVE_HTTP_PORT"
    "FDRIVE_INDEX_SFTPGO_DIR"
    "FDRIVE_INDEX_SFTPGO_PATH"
    "FDRIVE_INDEX_UID"
    "FDRIVE_COLLABORA_HOST"
)
# END GENERATED KNOWN FDRIVE KEYS

# Reads a single key's value out of $env_file: the last assignment wins (matching
# how a shell or `docker compose --env-file` would read a file with a key set
# twice), and a surrounding pair of double quotes is stripped.
read_env_value() {
  local key="$1"
  { grep -E "^${key}=" "$env_file" || true; } | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
  key="${BASH_REMATCH[1]}"
  [[ "$key" == FDRIVE_* ]] || continue
  known=0
  for candidate in "${KNOWN_FDRIVE_KEYS[@]}"; do
    if [[ "$candidate" == "$key" ]]; then
      known=1
      break
    fi
  done
  if [[ "$known" -eq 0 ]]; then
    case "$key" in
      FDRIVE_INDEX_ROOTS|FDRIVE_INDEXER_URL|FDRIVE_EMBED_URL|FDRIVE_IMAGE_EMBED_URL|FDRIVE_OCR_URL|FDRIVE_THUMBS_DIR)
        # compose.yaml fixes these to the stack's own sidecar addresses and
        # the mounted root; a value in .env would be silently ignored, so it
        # is an error rather than a warning.
        echo "error: '$key' in $env_file is set by compose.yaml and has no effect here; remove it (set FDRIVE_INDEX_SFTPGO_PATH to change the indexed root's SFTPGo-side path)" >&2
        ;;
      *)
        echo "error: unknown key '$key' in $env_file (typo?)" >&2
        ;;
    esac
    fail=1
  fi
done < "$env_file"

home_template="$(read_env_value FDRIVE_HOME_TEMPLATE)"
if [[ -n "$home_template" ]] && [[ ! "$home_template" =~ ^[A-Za-z0-9_-]+:.*\{username\}.*$ ]]; then
  echo "error: FDRIVE_HOME_TEMPLATE '$home_template' must look like <root>:<path with {username}>, for example sftpgo:/{username}" >&2
  fail=1
fi

scheme="$(read_env_value FDRIVE_PROXY_SCHEME)"
scheme="${scheme:-http}"
case "$scheme" in
  http|https) ;;
  *) echo "error: FDRIVE_PROXY_SCHEME must be http or https" >&2; fail=1 ;;
esac

# FDRIVE_PROXY_SCHEME is what the bundled proxy sends every upstream as
# X-Forwarded-Proto, and ONLYOFFICE builds the URLs it hands the browser from
# it. Behind an HTTPS edge with the scheme left at http, the editor page
# (loaded over https) is told to fetch documents over http, which browsers
# block as mixed content: every server-side call still returns 200 and the
# only symptom is "Download failed" in the editor. FDRIVE_PUBLIC_URL states
# the scheme users actually reach fdrive over, so the two must agree.
public_url="$(read_env_value FDRIVE_PUBLIC_URL)"
if [[ -n "$public_url" ]]; then
  case "$public_url" in
    http://*) public_scheme=http ;;
    https://*) public_scheme=https ;;
    *) public_scheme="" ;;
  esac
  if [[ -n "$public_scheme" ]] && [[ "$public_scheme" != "$scheme" ]]; then
    echo "error: FDRIVE_PUBLIC_URL is ${public_scheme}:// but FDRIVE_PROXY_SCHEME is ${scheme}; set FDRIVE_PROXY_SCHEME=${public_scheme} (behind an HTTPS reverse proxy the Office editor otherwise fails with \"Download failed\" because its document URLs are blocked as mixed content)" >&2
    fail=1
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

sftpgo_path="$(read_env_value FDRIVE_INDEX_SFTPGO_PATH)"
sftpgo_path="${sftpgo_path:-/srv/sftpgo/data}"
echo "==> FDRIVE_INDEX_ROOTS: [{\"name\":\"sftpgo\",\"sftpgoPath\":\"${sftpgo_path}\",\"indexerPath\":\"/roots/sftpgo\"}]"

bind="$(read_env_value FDRIVE_HTTP_BIND)"
bind="${bind:-0.0.0.0}"
port="$(read_env_value FDRIVE_HTTP_PORT)"
port="${port:-8090}"
echo "==> bind address: ${bind}:${port}"

echo "==> preflight OK"
