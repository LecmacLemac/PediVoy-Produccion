#!/usr/bin/env node
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function arg(name) {
  const idx = process.argv.indexOf('--' + name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

async function openssl(args) {
  const { stdout } = await execFileAsync('openssl', args, { timeout: 15000, maxBuffer: 1024 * 1024 });
  return stdout;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function main() {
  const cert = arg('cert');
  const key = arg('key');

  if (!cert) {
    console.error('Uso: node scripts/arca-credentials-check.js --cert <cert.pem> [--key <clave.pem>]');
    process.exit(2);
  }

  await fs.access(cert);
  const certInfo = await openssl(['x509', '-in', cert, '-noout', '-subject', '-issuer', '-serial', '-dates']);
  console.log(certInfo.trim());

  if (!key) {
    console.log('Clave privada no informada: se valido solo el certificado.');
    return;
  }

  await fs.access(key);
  const certPub = await openssl(['x509', '-in', cert, '-pubkey', '-noout']);
  const keyPub = await openssl(['pkey', '-in', key, '-pubout']);

  if (sha256(certPub) !== sha256(keyPub)) {
    console.error('ERROR: la clave privada no corresponde a este certificado.');
    process.exit(1);
  }

  console.log('OK: certificado y clave privada corresponden al mismo par.');
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
