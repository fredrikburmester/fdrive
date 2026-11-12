#!/bin/sh
# Started as root with FDRIVE_RUN_AS_UID set, as deploy/compose.yaml does,
# this hands the state directory over to that uid, then drops to it for good
# before any worker code runs. Started any other way (the image's own user,
# the test scripts, the dev stack) it runs the command as is.
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

# The directory itself and nothing below it: Docker creates a missing host
# directory as root, and kept originals must never change owner.
dir=${STATE_DIR:-}
if [ -n "$dir" ] && [ -d "$dir" ] && [ "$(stat -c %u "$dir")" != "$uid" ]; then
  if ! chown "$uid:$uid" "$dir"; then
    echo "cannot make $dir writable for uid $uid" >&2
    exit 1
  fi
fi

# The home of that uid when the image knows it, as a plain `USER` would set.
HOME=$(getent passwd "$uid" | cut -d: -f6)
export HOME="${HOME:-/}"
exec setpriv --reuid "$uid" --regid "$uid" --clear-groups "$@"
