#!/bin/sh
# Started as root with FDRIVE_RUN_AS_UID set, as deploy/compose.yaml does,
# this hands the API's own state directories over to that uid, then drops to
# it for good before any API code runs. Files the API writes in
# FDRIVE_STORAGE_ROOT then belong to the uid the indexer and OCR run as.
# Started any other way (the image's own user, a native run) it runs the
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

# Capabilities kept after the drop, such as dac_read_search for the backup
# worker, which reads state other services own. Empty keeps none.
caps=${FDRIVE_RUN_AS_CAPS:-}
case "$caps" in
  *[!a-z_,]*)
    echo "FDRIVE_RUN_AS_CAPS must be a comma-separated list of capability names, not '$caps'" >&2
    exit 64
    ;;
esac

# True when $1 is mounted read-only, like the desktop state the backup worker
# only reads: its owner is the API's to fix.
read_only_mount() {
  awk -v dir="$1" '$2 == dir { ro = ($4 ~ /^ro(,|$)/) } END { exit !ro }' /proc/self/mounts
}

for dir in "${FDRIVE_DESKTOP_STATE_DIR:-}" "${FDRIVE_BACKUP_STATE_DIR:-}"; do
  # Only when the owner is wrong: a new volume, a changed uid, or state an
  # earlier release wrote as the image's own fdrive user. Walking a large
  # directory on every start would delay it.
  if [ -n "$dir" ] && [ -d "$dir" ] && [ "$(stat -c %u "$dir")" != "$uid" ] &&
    ! read_only_mount "$dir"; then
    if ! chown -R "$uid:$uid" "$dir"; then
      echo "cannot make $dir writable for uid $uid" >&2
      exit 1
    fi
  fi
done

# The storage folder itself and only while it is empty: Docker creates a
# missing host directory as root. Files already in it never change owner.
root=${FDRIVE_STORAGE_ROOT:-}
if [ -n "$root" ] && [ -d "$root" ] && ! read_only_mount "$root" &&
  [ "$(stat -c %u "$root")" = 0 ] && [ -z "$(ls -A "$root")" ]; then
  if ! chown "$uid:$uid" "$root"; then
    echo "cannot make $root writable for uid $uid" >&2
    exit 1
  fi
fi

drop="setpriv --reuid $uid --regid $uid --clear-groups"
if [ -n "$caps" ]; then
  keep=$(printf '%s' "$caps" | sed 's/[^,][^,]*/+&/g')
  drop="$drop --inh-caps=-all,$keep --ambient-caps=-all,$keep"
fi
if [ -n "$root" ] && [ -d "$root" ] && ! $drop test -w "$root"; then
  echo "warning: uid $uid cannot write $root; set FDRIVE_RUN_AS_UID to the owner of its files" >&2
fi

# The home of that uid when the image knows it, as a plain `USER` would set.
HOME=$(getent passwd "$uid" | cut -d: -f6)
export HOME="${HOME:-/}"
# $drop is built from validated words above, so splitting it is intended.
# shellcheck disable=SC2086
exec $drop "$@"
