#!/bin/bash
set -euo pipefail

# The pinned upstream script interpolates this value into JavaScript strings.
if [[ ! "${JWT_SECRET:-}" =~ ^[A-Za-z0-9_-]{32,}$ ]]; then
  echo "ONLYOFFICE_JWT_SECRET must contain at least 32 letters, digits, underscores or hyphens." >&2
  exit 1
fi

directory=/var/www/onlyoffice/Data
mkdir -p "$directory"
if [[ ! -f "$directory/wopi_private.key" ]]; then
  if [[ -e "$directory/wopi_public.key" ]]; then
    echo "Refusing to replace an incomplete ONLYOFFICE proof key pair." >&2
    exit 1
  fi
  (umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$directory/wopi_private.key" 2>/dev/null)
fi
chmod 600 "$directory/wopi_private.key"
# Upstream derives its MS PUBLICKEYBLOB public file from this persisted private key.
exec /app/ds/run-document-server.sh "$@"
