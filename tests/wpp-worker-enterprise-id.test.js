import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEnterpriseId } from '../src/wpp/enterpriseId.js';

test('EMPRESA_ID acepta únicamente enteros seguros positivos', () => {
  assert.equal(parseEnterpriseId('7'), 7);
  for (const value of [undefined, '', '0', '-1', '7.5', '7x', '9007199254740992']) {
    assert.throws(() => parseEnterpriseId(value), /EMPRESA_ID/);
  }
});
