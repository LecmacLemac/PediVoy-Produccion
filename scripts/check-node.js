#!/usr/bin/env node
// scripts/check-node.js
// Enforce engines.node=20.x (project uses native addons like canvas)

const major = Number(process.versions.node.split('.')[0] || 0);
const expectedMajor = 20;

if (Number.isNaN(major) || major <= 0) {
  console.error('[check-node] No pude detectar la versión de Node.');
  process.exit(1);
}

if (major !== expectedMajor) {
  const msg = `[check-node] Node ${process.versions.node} detectado. Este proyecto requiere Node ${expectedMajor}.x (ver package.json engines) para evitar fallos con addons nativos (p.ej. canvas).`;
  if (process.env.ALLOW_NODE_MISMATCH === '1') {
    console.warn(msg);
    console.warn('[check-node] Continuando porque ALLOW_NODE_MISMATCH=1');
    process.exit(0);
  }
  console.error(msg);
  console.error('[check-node] Solución rápida con nvm:');
  console.error('  nvm install 20');
  console.error('  nvm use 20');
  process.exit(1);
}

process.exit(0);
