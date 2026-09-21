import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('..', import.meta.url).pathname;
const backupScript = join(root, 'scripts/postgres-backup.sh');
const restoreScript = join(root, 'scripts/postgres-restore-smoke.sh');
const secretUrl = 'postgresql://backup_user:never-print-this@db.invalid:5432/pedivoy?sslmode=require';

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pedivoy-backup-'));
  const bin = join(dir, 'bin');
  const backups = join(dir, 'backups');
  spawnSync('mkdir', ['-p', bin, backups]);
  const calls = join(dir, 'calls.log');
  executable(join(bin, 'pg_dump'), `
    printf 'pg_dump %s\\n' "$*" >> "$CALLS_LOG"
    if [ "\${1:-}" = "--version" ]; then echo "pg_dump (PostgreSQL) \${PG_DUMP_VERSION:-16.4}"; exit 0; fi
    [ "\${DUMP_FAIL:-0}" != 1 ] || { echo 'dump failed' >&2; exit 31; }
    [ -z "\${DUMP_WAIT_FILE:-}" ] || { : > "$DUMP_WAIT_FILE.ready"; while [ ! -f "$DUMP_WAIT_FILE" ]; do sleep 0.05; done; }
    out=''; while [ "$#" -gt 0 ]; do case "$1" in --file=*) out="\${1#--file=}";; --file) shift; out="$1";; esac; shift; done
    printf 'custom dump fixture' > "$out"
  `);
  executable(join(bin, 'psql'), `
    printf 'psql %s\\n' "$*" >> "$CALLS_LOG"
    [ -z "\${PGHOSTADDR:-}" ] || { echo 'unsafe PGHOSTADDR inherited' >&2; exit 97; }
    if [ -n "\${PGSERVICEFILE:-}" ] && grep -q "^port='" "$PGSERVICEFILE"; then echo 'quoted service port is invalid' >&2; exit 98; fi
    case "$*" in
      *server_version_num*) echo "\${SERVER_VERSION_NUM:-160004}";;
      *pg_catalog.pg_extension*) echo "\${PSQL_EXTENSION_COUNT:-\${PSQL_OUTPUT:-1}}";;
      *pg_catalog.pg_tables*) echo "\${PSQL_TABLE_COUNT:-\${PSQL_OUTPUT:-1}}";;
      *) echo "\${PSQL_OUTPUT:-1}";;
    esac
  `);
  executable(join(bin, 'pg_restore'), `
    printf 'pg_restore %s\\n' "$*" >> "$CALLS_LOG"
    [ -z "\${PGHOSTADDR:-}" ] || { echo 'unsafe PGHOSTADDR inherited' >&2; exit 97; }
    [ "\${LIST_FAIL:-0}" != 1 ] || { echo 'list failed' >&2; exit 32; }
    case " $* " in *' --list '*) echo '; Archive created at fixture';; esac
  `);
  executable(join(bin, 'initdb'), `printf 'initdb %s\\n' "$*" >> "$CALLS_LOG"`);
  executable(join(bin, 'pg_ctl'), `printf 'pg_ctl %s\\n' "$*" >> "$CALLS_LOG"`);
  executable(join(bin, 'createdb'), `printf 'createdb %s\\n' "$*" >> "$CALLS_LOG"`);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DATABASE_URL: secretUrl,
    BACKUP_DIR: backups,
    BACKUP_LOCK_FILE: join(dir, 'backup.lock'),
    BACKUP_TIMESTAMP: '20260920T120000Z',
    BACKUP_RETENTION_DAYS: '7',
    CALLS_LOG: calls,
  };
  return { dir, bin, backups, calls, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(script, env, args = [], options = {}) {
  return spawnSync('bash', [script, ...args], { cwd: root, env, encoding: 'utf8', ...options });
}

function output(result) { return `${result.stdout || ''}${result.stderr || ''}`; }

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  let timer;
  const exited = await Promise.race([
    new Promise(resolve => child.once('close', () => resolve(true))),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
  ]);
  clearTimeout(timer);
  return exited;
}

test('backup fails closed when DATABASE_URL is absent', () => {
  const f = fixture();
  try {
    const env = { ...f.env }; delete env.DATABASE_URL;
    const result = run(backupScript, env);
    assert.notEqual(result.status, 0);
    assert.match(output(result), /DATABASE_URL/);
    assert.deepEqual(readdirSync(f.backups), []);
  } finally { f.cleanup(); }
});

test('backup rejects a malformed URL without leaking its value', () => {
  const f = fixture();
  try {
    const malformed = 'postgresql://user:super-secret-value@[bad/pedivoy';
    const result = run(backupScript, { ...f.env, DATABASE_URL: malformed });
    assert.notEqual(result.status, 0);
    assert.ok(!output(result).includes(malformed));
    assert.ok(!output(result).includes('super-secret-value'));
  } finally { f.cleanup(); }
});

test('backup rejects a pg_dump/server major version mismatch', () => {
  const f = fixture();
  try {
    const result = run(backupScript, { ...f.env, SERVER_VERSION_NUM: '150009' });
    assert.notEqual(result.status, 0);
    assert.match(output(result), /major/i);
    assert.deepEqual(readdirSync(f.backups), []);
  } finally { f.cleanup(); }
});

test('backup creates validated custom dump and checksum privately without logging secrets', () => {
  const f = fixture();
  try {
    const result = run(backupScript, f.env);
    assert.equal(result.status, 0, output(result));
    const dump = join(f.backups, 'pedivoy-20260920T120000Z.dump');
    const checksum = `${dump}.sha256`;
    const complete = `${dump}.complete`;
    assert.equal(existsSync(dump), true);
    assert.equal(existsSync(checksum), true);
    assert.equal(existsSync(complete), true);
    assert.equal(statSync(dump).mode & 0o777, 0o600);
    assert.equal(statSync(checksum).mode & 0o777, 0o600);
    assert.equal(statSync(complete).mode & 0o777, 0o600);
    assert.match(readFileSync(checksum, 'utf8'), /^[a-f0-9]{64}  pedivoy-20260920T120000Z\.dump\n$/);
    assert.ok(!readdirSync(f.backups).some(name => name.includes('.partial')));
    const allOutput = output(result) + readFileSync(f.calls, 'utf8');
    assert.ok(!allOutput.includes('never-print-this'));
    assert.ok(!allOutput.includes(secretUrl));
    assert.match(readFileSync(f.calls, 'utf8'), /pg_dump .*--format=custom/);
    assert.match(readFileSync(f.calls, 'utf8'), /pg_restore .*--list/);
  } finally { f.cleanup(); }
});

test('dump and archive-list failures return nonzero and never publish or prune', () => {
  for (const failure of [{ DUMP_FAIL: '1' }, { LIST_FAIL: '1' }]) {
    const f = fixture();
    try {
      const old = join(f.backups, 'pedivoy-20200101T000000Z.dump');
      writeFileSync(old, 'old');
      writeFileSync(`${old}.sha256`, 'old checksum');
      const ancient = new Date('2020-01-01T00:00:00Z');
      utimesSync(old, ancient, ancient); utimesSync(`${old}.sha256`, ancient, ancient);
      const result = run(backupScript, { ...f.env, ...failure });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(old), true);
      assert.equal(existsSync(`${old}.sha256`), true);
      assert.ok(!readdirSync(f.backups).some(name => name.includes('20260920T120000Z')));
    } finally { f.cleanup(); }
  }
});

test('retention runs only after a valid backup', () => {
  const f = fixture();
  try {
    const old = join(f.backups, 'pedivoy-20200101T000000Z.dump');
    writeFileSync(old, 'old'); writeFileSync(`${old}.sha256`, 'old checksum');
    const ancient = new Date('2020-01-01T00:00:00Z');
    utimesSync(old, ancient, ancient); utimesSync(`${old}.sha256`, ancient, ancient);
    const result = run(backupScript, f.env);
    assert.equal(result.status, 0, output(result));
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(`${old}.sha256`), false);
  } finally { f.cleanup(); }
});

test('flock prevents concurrent backup execution', async () => {
  const f = fixture();
  const gate = join(f.dir, 'release-dump');
  let first;
  try {
    first = spawn('bash', [backupScript], { cwd: root, env: { ...f.env, DUMP_WAIT_FILE: gate }, stdio: 'pipe', detached: true });
    for (let i = 0; i < 100 && !existsSync(`${gate}.ready`); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(`${gate}.ready`), true, 'first backup did not reach pg_dump');
    const second = run(backupScript, f.env, [], { timeout: 1000 });
    assert.notEqual(second.status, 0);
    assert.match(output(second), /already running|lock/i);
    writeFileSync(gate, 'release');
    assert.equal(await waitForExit(first, 1000), true, 'first backup did not exit after release');
    assert.equal(first.exitCode, 0);
  } finally {
    writeFileSync(gate, 'release');
    if (!await waitForExit(first, 1000) && first?.pid) {
      try { process.kill(-first.pid, 'SIGKILL'); } catch {}
      await waitForExit(first, 1000);
    }
    f.cleanup();
  }
});

test('restore smoke validates checksum/list and uses only a private disposable socket cluster', () => {
  const f = fixture();
  try {
    const backup = join(f.backups, 'pedivoy-20260920T120000Z.dump');
    writeFileSync(backup, 'custom dump fixture');
    const sum = spawnSync('sha256sum', [backup], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
    writeFileSync(`${backup}.sha256`, `${sum}  ${backup.split('/').at(-1)}\n`);
    writeFileSync(`${backup}.complete`, `${sum}\n`);
    const env = { ...f.env, CRITICAL_TABLES: 'empresas usuarios pedidos', CRITICAL_EXTENSIONS: 'pg_trgm postgis', PSQL_TABLE_COUNT: '3', PSQL_EXTENSION_COUNT: '2', PGHOSTADDR: '203.0.113.10', PGSERVICE: 'hostile' };
    delete env.DATABASE_URL;
    const result = run(restoreScript, env, [backup]);
    assert.equal(result.status, 0, output(result));
    const calls = readFileSync(f.calls, 'utf8');
    assert.match(calls, /pg_restore .*--list/);
    assert.match(calls, /initdb .*--auth=trust/);
    assert.match(calls, /pg_ctl .*listen_addresses=''/);
    assert.match(calls, /pg_restore .*--exit-on-error/);
    assert.match(calls, /psql .*empresas.*usuarios.*pedidos/s);
    assert.match(calls, /psql .*pg_trgm.*postgis/s);
    assert.ok(!calls.includes('never-print-this'));
    assert.ok(!calls.includes('--host=localhost'));
  } finally { f.cleanup(); }
});

test('restore smoke rejects a sidecar that authenticates a different archive', () => {
  const f = fixture();
  try {
    const backup = join(f.backups, 'pedivoy-20260920T120000Z.dump');
    const other = join(f.backups, 'pedivoy-20260919T120000Z.dump');
    writeFileSync(backup, 'unchecked archive');
    writeFileSync(other, 'valid other archive');
    const sum = spawnSync('sha256sum', [other], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
    writeFileSync(`${backup}.sha256`, `${sum}  ${other.split('/').at(-1)}\n`);
    writeFileSync(`${backup}.complete`, 'complete\n');
    const result = run(restoreScript, f.env, [backup]);
    assert.notEqual(result.status, 0);
    assert.match(output(result), /does not name the requested archive/);
    assert.equal(existsSync(f.calls), false);
  } finally { f.cleanup(); }
});

test('restore smoke fails before cluster startup on a bad checksum', () => {
  const f = fixture();
  try {
    const backup = join(f.backups, 'pedivoy-20260920T120000Z.dump');
    writeFileSync(backup, 'tampered');
    writeFileSync(`${backup}.sha256`, `${'0'.repeat(64)}  ${backup.split('/').at(-1)}\n`);
    writeFileSync(`${backup}.complete`, 'complete\n');
    const result = run(restoreScript, f.env, [backup]);
    assert.notEqual(result.status, 0);
    assert.match(output(result), /checksum verification failed/);
    assert.equal(existsSync(f.calls), false);
  } finally { f.cleanup(); }
});
