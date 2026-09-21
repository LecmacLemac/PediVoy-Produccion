#!/usr/bin/env node
import { chmod, writeFile } from 'node:fs/promises';

const allowed = new Set([
  'application_name', 'channel_binding', 'connect_timeout', 'gssencmode', 'keepalives',
  'keepalives_count', 'keepalives_idle', 'keepalives_interval', 'krbsrvname', 'options',
  'requirepeer', 'sslcert', 'sslcompression', 'sslcrl', 'sslkey', 'sslmode', 'sslpassword',
  'sslrootcert', 'target_session_attrs', 'tcp_user_timeout'
]);

function serviceValue(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('invalid control character');
  return value;
}

async function main() {
  const destination = process.argv[2];
  if (!destination) throw new Error('missing destination');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw || /[\r\n\0]/.test(raw)) throw new Error('invalid input');

  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('invalid protocol');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database) throw new Error('missing connection field');

  const values = {
    host: url.hostname,
    ...(url.port ? { port: url.port } : {}),
    dbname: database,
    ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key)) throw new Error('unsupported connection parameter');
    values[key] = value;
  }
  const body = ['[pedivoy_backup]', ...Object.entries(values).map(([key, value]) => `${key}=${serviceValue(value)}`), ''].join('\n');
  await writeFile(destination, body, { mode: 0o600, flag: 'w' });
  await chmod(destination, 0o600);
}

try {
  await main();
} catch {
  console.error('Invalid PostgreSQL connection configuration');
  process.exitCode = 1;
}
