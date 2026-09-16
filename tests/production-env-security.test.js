import test from 'node:test';
import assert from 'node:assert/strict';

import { assertProductionEnv } from '../src/bootstrap/env.js';

test('production startup requires a valid canonical invoice origin', () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    APP_PUBLIC_URL: process.env.APP_PUBLIC_URL,
    LOCAL_HTTP_DEV: process.env.LOCAL_HTTP_DEV,
  };
  const exit = process.exit;
  const error = console.error;
  try {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'x'.repeat(40);
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.APP_PUBLIC_URL;
    process.exit = code => { throw Object.assign(new Error('exit'), { code }); };
    console.error = () => {};

    assert.throws(() => assertProductionEnv(), value => value?.code === 1);
    process.env.PUBLIC_BASE_URL = 'javascript:alert(1)';
    assert.throws(() => assertProductionEnv(), value => value?.code === 1);
    process.env.PUBLIC_BASE_URL = 'http://example.com';
    assert.throws(() => assertProductionEnv(), value => value?.code === 1);
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    assert.throws(() => assertProductionEnv(), value => value?.code === 1);
    process.env.PUBLIC_BASE_URL = 'https://www.pedivoy.com/facturas';
    assert.doesNotThrow(() => assertProductionEnv());

    process.env.LOCAL_HTTP_DEV = 'true';
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    assert.doesNotThrow(() => assertProductionEnv());
    delete process.env.PUBLIC_BASE_URL;
    assert.doesNotThrow(() => assertProductionEnv());
  } finally {
    process.exit = exit;
    console.error = error;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
