#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

[[ $# -eq 1 ]] || fail 'usage: postgres-restore-smoke.sh /path/to/backup.dump'
backup=$(realpath -- "$1")
checksum="${backup}.sha256"
complete="${backup}.complete"
[[ -f "$backup" && -f "$checksum" && -f "$complete" ]] || fail 'backup, adjacent .sha256, and .complete files are required'
for command in sha256sum pg_restore initdb pg_ctl createdb psql mktemp; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

backup_dir=$(dirname -- "$backup")
backup_name=$(basename -- "$backup")
checksum_line=$(<"$checksum")
[[ "$checksum_line" =~ ^([0-9a-fA-F]{64})[[:space:]][[:space:]]([^/]+)$ ]] || fail 'invalid checksum sidecar format'
expected_hash=${BASH_REMATCH[1],,}
[[ "${BASH_REMATCH[2]}" == "$backup_name" ]] || fail 'checksum sidecar does not name the requested archive'
actual_hash=$(sha256sum -- "$backup" | cut -d' ' -f1)
[[ "$actual_hash" == "$expected_hash" ]] || fail 'backup checksum verification failed'
[[ "$(<"$complete")" == "$expected_hash" ]] || fail 'backup publication marker is invalid'

unset DATABASE_URL
for name in ${!PG@}; do unset "$name"; done
pg_restore --list "$backup" >/dev/null || fail 'backup archive listing failed'

sandbox=$(mktemp -d "${TMPDIR:-/tmp}/pedivoy-restore-smoke.XXXXXX")
pgdata="$sandbox/data"
socket_dir="$sandbox/socket"
mkdir -m 700 -- "$socket_dir"
start_attempted=0
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$start_attempted" == 1 && -f "$pgdata/postmaster.pid" ]]; then
    if ! pg_ctl --pgdata="$pgdata" --mode=immediate --wait stop >/dev/null 2>&1; then
      printf 'ERROR: could not stop disposable PostgreSQL cluster; sandbox preserved at %s\n' "$sandbox" >&2
      [[ "$status" -ne 0 ]] || status=1
      exit "$status"
    fi
  fi
  rm -rf -- "$sandbox"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

initdb --pgdata="$pgdata" --auth=trust --no-locale --username=pedivoy_smoke >/dev/null
start_attempted=1
pg_ctl --pgdata="$pgdata" --options="-c listen_addresses='' -c unix_socket_directories='$socket_dir' -c port=55439" --wait start >/dev/null
createdb --host="$socket_dir" --port=55439 --username=pedivoy_smoke pedivoy_restore_smoke
pg_restore --host="$socket_dir" --port=55439 --username=pedivoy_smoke --dbname=pedivoy_restore_smoke --exit-on-error --no-owner --no-privileges "$backup" >/dev/null

critical_tables=${CRITICAL_TABLES:-'empresas usuarios pedidos items_pedido productos puntos_entrega'}
critical_extensions=${CRITICAL_EXTENSIONS:-'pg_trgm postgis'}
read -r -a tables <<<"$critical_tables"
read -r -a extensions <<<"$critical_extensions"
[[ ${#tables[@]} -gt 0 && ${#extensions[@]} -gt 0 ]] || fail 'critical table/extension lists cannot be empty'
for name in "${tables[@]}" "${extensions[@]}"; do [[ "$name" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || fail "invalid critical object name: $name"; done

table_csv=$(printf "'%s'," "${tables[@]}"); table_csv=${table_csv%,}
ext_csv=$(printf "'%s'," "${extensions[@]}"); ext_csv=${ext_csv%,}
table_count=$(psql --host="$socket_dir" --port=55439 --username=pedivoy_smoke --dbname=pedivoy_restore_smoke --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command="SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename IN ($table_csv)")
ext_count=$(psql --host="$socket_dir" --port=55439 --username=pedivoy_smoke --dbname=pedivoy_restore_smoke --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command="SELECT count(*) FROM pg_catalog.pg_extension WHERE extname IN ($ext_csv)")
[[ "$table_count" == "${#tables[@]}" ]] || fail "missing critical tables after restore ($table_count/${#tables[@]})"
[[ "$ext_count" == "${#extensions[@]}" ]] || fail "missing critical extensions after restore ($ext_count/${#extensions[@]})"
log 'Restore smoke passed in private disposable PostgreSQL cluster'
