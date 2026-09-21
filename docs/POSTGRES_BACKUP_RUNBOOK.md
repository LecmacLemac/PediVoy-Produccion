# PostgreSQL Backup and Restore Smoke Runbook

## Scope and safety

These procedures create logical PostgreSQL backups and validate restores. They do **not** install or enable systemd units automatically, and the restore smoke never connects to `DATABASE_URL`: it initializes a disposable cluster under a private temporary directory, disables TCP listening, and connects only through its private Unix socket.

Never point the restore smoke at a production cluster. The script has no option to accept a target connection string.

## Requirements

- Node.js (used only to convert `DATABASE_URL` into a mode-`0600` temporary libpq service file).
- Matching PostgreSQL client/server major versions for backup: `pg_dump`, `pg_restore`, and `psql`.
- Restore smoke additionally requires `initdb`, `pg_ctl`, and `createdb`, and must run as a non-root OS user.
- GNU/Linux tools: `bash`, `flock`, `sha256sum`, `find`, `mktemp`, and `realpath`.
- The source database must contain critical extensions `pg_trgm` and `postgis` unless `CRITICAL_EXTENSIONS` is explicitly adjusted for a documented schema change.

## Create a backup

Provide the URL without placing it on the command line:

```bash
export DATABASE_URL='postgresql://...'
export BACKUP_DIR=/var/lib/pedivoy/backups
export BACKUP_RETENTION_DAYS=14
npm run db:backup
```

The script:

1. applies `umask 077` and takes a non-blocking `flock`;
2. writes credentials to a temporary `0600` libpq service file, then unsets `DATABASE_URL` before invoking PostgreSQL tools;
3. rejects a `pg_dump`/server major-version mismatch;
4. writes a custom-format archive to a private partial file;
5. verifies the archive with `pg_restore --list`;
6. creates a SHA-256 sidecar, atomically renames each artifact, and publishes a `.complete` marker last so consumers never select a partial pair;
7. performs age-based retention only after successful publication.

Success produces:

```text
pedivoy-YYYYMMDDTHHMMSSZ.dump
pedivoy-YYYYMMDDTHHMMSSZ.dump.sha256
pedivoy-YYYYMMDDTHHMMSSZ.dump.complete
```

Any missing prerequisite, concurrent run, dump/list/checksum error, or invalid configuration returns a non-zero exit status. Logs contain paths and version numbers but never the database URL or password.

## Verify a restore

```bash
npm run db:restore-smoke -- /var/lib/pedivoy/backups/pedivoy-YYYYMMDDTHHMMSSZ.dump
```

Before starting PostgreSQL, the script requires the completion marker, verifies that the adjacent checksum names and authenticates the requested archive exactly, and validates the archive listing. It clears inherited libpq connection variables before creating a disposable cluster with `listen_addresses=''`, a private mode-`0700` Unix socket directory, and a fixed internal port used only with that socket. It restores with `--exit-on-error`, verifies these default critical tables:

- `empresas`
- `usuarios`
- `pedidos`
- `items_pedido`
- `productos`
- `puntos_entrega`

It also verifies `pg_trgm` and `postgis`, stops the cluster, and removes the sandbox even on failure.

Override object lists only when an approved migration changes the contract:

```bash
CRITICAL_TABLES='empresas usuarios pedidos' \
CRITICAL_EXTENSIONS='pg_trgm postgis' \
npm run db:restore-smoke -- /path/to/archive.dump
```

## Systemd templates (not installed)

Versioned templates live in `ops/systemd/`:

- `pedivoy-postgres-backup.service` and `.timer` (daily);
- `pedivoy-postgres-restore-smoke.service` and `.timer` (weekly, newest named archive).

They assume:

- checkout: `/opt/pedivoy/current`;
- service account: `pedivoy`;
- backup directory: `/var/lib/pedivoy/backups`;
- runtime directory: `/run/pedivoy`;
- secret environment file: `/etc/pedivoy/backup.env`, owned by root and mode `0600`, containing only `DATABASE_URL=...` and optional non-secret settings.

Review paths, account, PostgreSQL binaries, disk capacity, retention, and monitoring before installation. Installation/enabling is an explicit operator action and is intentionally not performed by this repository change.

After an approved installation, verify manually:

```bash
sudo systemd-analyze verify /etc/systemd/system/pedivoy-postgres-*.service /etc/systemd/system/pedivoy-postgres-*.timer
sudo systemctl start pedivoy-postgres-backup.service
sudo systemctl status pedivoy-postgres-backup.service
sudo systemctl start pedivoy-postgres-restore-smoke.service
sudo systemctl status pedivoy-postgres-restore-smoke.service
```

Only enable timers after both one-shot services pass and alerting is configured.

## Monitoring and incident handling

Alert on any non-zero service result, missed timer, stale newest backup, checksum mismatch, or restore-smoke failure. Do not delete the last known-good archive while investigating. Preserve the failing archive and sidecar together, rotate database credentials if accidental secret logging is suspected, and rerun only after correcting the root cause.

## Test coverage and current validation boundary

`tests/postgres-backup.test.js` uses deterministic stub binaries to cover missing URL, client/server major mismatch, lock contention, dump/list failures, checksums, permissions, retention ordering, secret-free logs, and isolated restore orchestration. This validates control flow without touching any database.

A real restore integration requires local PostgreSQL server binaries plus PostGIS and is intentionally not claimed by the stub suite. Run the restore smoke against a real non-production backup in the approved host environment before enabling its timer.
