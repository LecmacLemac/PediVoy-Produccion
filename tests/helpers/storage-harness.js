import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { createWithAuth, isSuper } from '../../src/core/auth.js';

export const secret = 'hermetic-storage-test-key';
export async function storageHarness(factory, mount, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-security-'));
  await fs.writeFile(path.join(dir, 'registered.pdf'), 'private PDF');
  await fs.writeFile(path.join(dir, 'manual.pdf'), 'unregistered PDF');
  const state = { identity: { id: 1, role: 'admin', empresa_id: 7, chofer_id: null, referente_id: null, activo: true }, calls: [], objects: 0, fail: false, licenseDenied: false };
  const query = async (sql, args) => {
    state.calls.push({ sql, args });
    if (/FROM usuarios/.test(sql)) return [{ ...state.identity }];
    state.objects++;
    if (state.fail) throw new Error('DB unavailable');
    // The fixture enforces the actual SQL tenant/driver predicates, not the JWT claims.
    if (args[0] !== 'registered.pdf') return [];
    if (state.identity.role !== 'super') {
      if (!/empresa_id\s*=\s*\$2/.test(sql)) throw new Error('Missing tenant predicate');
      if (args[1] !== 7) return [];
    }
    if (state.identity.role === 'repartidor') {
      if (!/chofer_id\s*=\s*\$3/.test(sql)) throw new Error('Missing driver predicate');
      if (args[2] !== 8) return [];
    }
    return [{ id: 10 }];
  };
  const app = express();
  app.use(cookieParser());
  const checkLicencia = (_req, res, next) => state.licenseDenied
    ? res.status(403).json({ error: 'Licencia vencida' })
    : next();
  app.use(mount, factory({ storageDir: dir, query, withAuth: createWithAuth({ queryFn: query, jwtSecret: secret }), checkLicencia, isSuper }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = (filename = 'registered.pdf', claims = { uid: 1, role: 'admin' }, cookie = false) => {
    const token = claims === null ? null : jwt.sign(claims, secret);
    return fetch(`http://127.0.0.1:${server.address().port}${mount}/${filename}`, { headers: token ? cookie ? { Cookie: `token=${token}` } : { Authorization: `Bearer ${token}` } : {} });
  };
  try { await run({ state, request, dir }); }
  finally { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
}
