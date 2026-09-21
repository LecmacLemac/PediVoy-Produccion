#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

[[ -n "${DATABASE_URL:-}" ]] || fail 'DATABASE_URL is required'
for command in node pg_dump pg_restore psql sha256sum flock find; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

BACKUP_DIR=${BACKUP_DIR:-"$(pwd)/backups"}
BACKUP_LOCK_FILE=${BACKUP_LOCK_FILE:-"$BACKUP_DIR/.postgres-backup.lock"}
BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
[[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail 'BACKUP_RETENTION_DAYS must be a non-negative integer'
mkdir -p -- "$BACKUP_DIR" "$(dirname -- "$BACKUP_LOCK_FILE")"
chmod 700 -- "$BACKUP_DIR"

exec 9>"$BACKUP_LOCK_FILE"
flock -n 9 || fail 'backup already running; lock is held'

timestamp=${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
[[ "$timestamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail 'BACKUP_TIMESTAMP has an invalid format'
final_name="pedivoy-${timestamp}.dump"
final_path="$BACKUP_DIR/$final_name"
checksum_path="${final_path}.sha256"
complete_path="${final_path}.complete"
[[ ! -e "$final_path" && ! -e "$checksum_path" && ! -e "$complete_path" ]] || fail "backup already exists for timestamp $timestamp"

service_file=$(mktemp "${TMPDIR:-/tmp}/pedivoy-pg-service.XXXXXX")
tmp_dump=$(mktemp "$BACKUP_DIR/.${final_name}.partial.XXXXXX")
tmp_checksum=$(mktemp "$BACKUP_DIR/.${final_name}.sha256.partial.XXXXXX")
tmp_complete=$(mktemp "$BACKUP_DIR/.${final_name}.complete.partial.XXXXXX")
published=0
cleanup() {
  rm -f -- "$service_file" "$tmp_dump" "$tmp_checksum" "$tmp_complete"
  if [[ "$published" != 1 ]]; then rm -f -- "$final_path" "$checksum_path" "$complete_path"; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s' "$DATABASE_URL" | node "$(dirname -- "${BASH_SOURCE[0]}")/postgres-service-config.js" "$service_file"
unset DATABASE_URL
for name in ${!PG@}; do unset "$name"; done
export PGSERVICEFILE="$service_file" PGSERVICE=pedivoy_backup

local_version=$(pg_dump --version)
local_major=$(sed -nE 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/p' <<<"$local_version")
[[ -n "$local_major" ]] || fail 'could not determine pg_dump major version'
server_version_num=$(psql --no-psqlrc --tuples-only --no-align --command='SHOW server_version_num')
[[ "$server_version_num" =~ ^[0-9]+$ ]] || fail 'could not determine PostgreSQL server version'
server_major=$((server_version_num / 10000))
[[ "$local_major" == "$server_major" ]] || fail "pg_dump/server major mismatch (pg_dump $local_major, server $server_major)"

log "Creating PostgreSQL custom-format backup $final_name"
pg_dump --format=custom --no-owner --no-privileges --file="$tmp_dump"
[[ -s "$tmp_dump" ]] || fail 'pg_dump produced an empty archive'
pg_restore --list "$tmp_dump" >/dev/null
hash=$(sha256sum -- "$tmp_dump" | cut -d' ' -f1)
printf '%s  %s\n' "$hash" "$final_name" > "$tmp_checksum"
printf '%s\n' "$hash" > "$tmp_complete"
chmod 600 -- "$tmp_dump" "$tmp_checksum" "$tmp_complete"

mv -- "$tmp_dump" "$final_path"
mv -- "$tmp_checksum" "$checksum_path"
mv -- "$tmp_complete" "$complete_path"
published=1

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'pedivoy-*.dump' -o -name 'pedivoy-*.dump.sha256' -o -name 'pedivoy-*.dump.complete' \) -mtime "+$BACKUP_RETENTION_DAYS" -delete
log "Backup validated and published: $final_path"
