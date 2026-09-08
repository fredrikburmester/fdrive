#!/bin/bash
set -u

# Upstream's entrypoint only stops the foreground tail process. Its actual
# server processes are daemonized, so explicitly stop and verify every local
# service before reporting that Office is off.
if curl -fs --max-time 2 http://127.0.0.1:8000/internal/cluster/inactive >/dev/null 2>&1; then
  :
fi

for local_service in supervisor nginx cron postgresql rabbitmq-server redis-server; do
  service "$local_service" stop >/dev/null 2>&1 || true
done

live_named_process() {
  local process_name="$1"
  local pid
  for pid in $(pgrep -x "$process_name" 2>/dev/null); do
    [[ "$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null)" == Z ]] || return 0
  done
  return 1
}

live_matching_process() {
  local pattern="$1"
  local pid
  for pid in $(pgrep -f "$pattern" 2>/dev/null); do
    [[ "$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null)" == Z ]] || return 0
  done
  return 1
}

office_processes_running() {
  live_named_process supervisord \
    || live_named_process nginx \
    || live_named_process cron \
    || live_named_process postgres \
    || live_named_process beam.smp \
    || live_named_process epmd \
    || live_named_process redis-server \
    || live_matching_process '^/var/www/onlyoffice/documentserver/server/DocService/docservice' \
    || live_matching_process '^/var/www/onlyoffice/documentserver/server/FileConverter/converter'
}

for _ in {1..20}; do
  office_processes_running || exit 0
  sleep 1
done

pkill -TERM -x supervisord >/dev/null 2>&1 || true
pkill -TERM -x nginx >/dev/null 2>&1 || true
pkill -TERM -x cron >/dev/null 2>&1 || true
pkill -TERM -x postgres >/dev/null 2>&1 || true
pkill -TERM -x beam.smp >/dev/null 2>&1 || true
pkill -TERM -x epmd >/dev/null 2>&1 || true
pkill -TERM -x redis-server >/dev/null 2>&1 || true
pkill -TERM -f '^/var/www/onlyoffice/documentserver/server/DocService/docservice' >/dev/null 2>&1 || true
pkill -TERM -f '^/var/www/onlyoffice/documentserver/server/FileConverter/converter' >/dev/null 2>&1 || true
sleep 5

if office_processes_running; then
  pkill -KILL -x supervisord >/dev/null 2>&1 || true
  pkill -KILL -x nginx >/dev/null 2>&1 || true
  pkill -KILL -x cron >/dev/null 2>&1 || true
  pkill -KILL -x postgres >/dev/null 2>&1 || true
  pkill -KILL -x beam.smp >/dev/null 2>&1 || true
  pkill -KILL -x epmd >/dev/null 2>&1 || true
  pkill -KILL -x redis-server >/dev/null 2>&1 || true
  pkill -KILL -f '^/var/www/onlyoffice/documentserver/server/DocService/docservice' >/dev/null 2>&1 || true
  pkill -KILL -f '^/var/www/onlyoffice/documentserver/server/FileConverter/converter' >/dev/null 2>&1 || true
  sleep 1
fi

if office_processes_running; then
  echo "ONLYOFFICE processes remained after shutdown" >&2
  exit 1
fi
