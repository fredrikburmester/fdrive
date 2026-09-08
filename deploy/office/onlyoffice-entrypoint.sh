#!/bin/bash
set -euo pipefail

directory=/var/www/onlyoffice/Data
mkdir -p "$directory"
jwt_file="$directory/.fdrive-jwt-secret"
# The secret is private to Document Server's own API. Persist it beside the
# proof key so a normal container replacement never rotates it and operators
# do not need to put another secret in .env.
if [[ -z "${JWT_SECRET:-}" ]]; then
  if [[ ! -f "$jwt_file" ]]; then
    (umask 077; openssl rand -hex 32 >"$jwt_file.tmp")
    mv "$jwt_file.tmp" "$jwt_file"
  fi
  JWT_SECRET="$(cat "$jwt_file")"
fi
if [[ ! "$JWT_SECRET" =~ ^[A-Za-z0-9_-]{32,}$ ]]; then
  echo "The persisted ONLYOFFICE JWT secret is invalid." >&2
  exit 1
fi
export JWT_SECRET
chmod 600 "$jwt_file" 2>/dev/null || true

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
