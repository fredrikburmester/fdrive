#!/bin/sh
# Started as root with FDRIVE_RUN_AS_UID set, as deploy/compose.yaml does,
# this hands the directories the indexer writes to over to that uid, then
# drops to it for good before any indexer code runs. Started any other way
# (the image's own user, the test scripts, the dev stack) it runs the
# command as is.
set -eu

if [ "$(id -u)" != 0 ] || [ -z "${FDRIVE_RUN_AS_UID:-}" ]; then
  exec "$@"
fi

uid=$FDRIVE_RUN_AS_UID
case "$uid" in
  '' | *[!0-9]* | 0)
    echo "FDRIVE_RUN_AS_UID must be a numeric uid other than 0, not '$uid'" >&2
    exit 64
    ;;
esac

for dir in "${THUMBS_DIR:-}" "${INDEXER_LOG_DIR:-}"; do
  # Only when the owner is wrong, which is a new volume or a changed uid:
  # walking every thumbnail on each start would delay a large library.
  if [ -n "$dir" ] && [ -d "$dir" ] && [ "$(stat -c %u "$dir")" != "$uid" ]; then
    if ! chown -R "$uid:$uid" "$dir"; then
      echo "cannot make $dir writable for uid $uid" >&2
      exit 1
    fi
  fi
done

# The home of that uid when the image knows it, as a plain `USER` would set.
HOME=$(getent passwd "$uid" | cut -d: -f6)
export HOME="${HOME:-/}"
exec setpriv --reuid "$uid" --regid "$uid" --clear-groups "$@"
