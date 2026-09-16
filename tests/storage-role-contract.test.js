import test from 'node:test';
import assert from 'node:assert/strict';
import { requireTransferenciaStorageRole } from '../src/transferenciaStorage.js';

test('Transferencia accepts only canonical staff admin/super without any explicit type', () => {
  for (const user of [
    { role: 'admin', type: 'user' }, { role: 'admin', type: '' },
    { role: 'admin', type: null }, { role: 'admin', type: 'client' },
    { role: ' ADMIN ' }, { role: 'SUPER' }, { role: 'user' },
  ]) {
    let status;
    requireTransferenciaStorageRole({ user }, { status(n) { status = n; return this; }, json() {} }, () => { status = 200; });
    assert.equal(status, 403, JSON.stringify(user));
  }
});
