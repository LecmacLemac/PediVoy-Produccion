import test from 'node:test';
import assert from 'node:assert/strict';

import { assertProductionEnv } from '../src/bootstrap/env.js';

test('production startup requires an exact canonical public origin', () => {
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

    const reject = value => {
      process.env.PUBLIC_BASE_URL = value;
      assert.throws(() => assertProductionEnv(), errorValue => errorValue?.code === 1, value || '<missing>');
    };

    assert.throws(() => assertProductionEnv(), value => value?.code === 1, 'missing origin');
    for (const value of [
      'javascript:alert(1)',
      'http://example.com',
      'http://localhost:3000',
      'https://www.pedivoy.com/',
      'https://www.pedivoy.com/facturas',
      'https://www.pedivoy.com?tenant=7',
      'https://www.pedivoy.com#fragment',
      'https://user:pass@www.pedivoy.com',
    ]) reject(value);
    process.env.PUBLIC_BASE_URL = 'https://www.pedivoy.com';
    assert.doesNotThrow(() => assertProductionEnv());

    process.env.LOCAL_HTTP_DEV = 'true';
    delete process.env.PUBLIC_BASE_URL;
    assert.throws(() => assertProductionEnv(), value => value?.code === 1, 'local flag does not make the origin optional');
    for (const value of [
      'http://localhost:3000/',
      'http://localhost:3000/path',
      'http://localhost:3000?query=1',
      'http://localhost:3000#fragment',
      'http://user:pass@localhost:3000',
      'http://example.localhost.invalid:3000',
      'http://127.0.0.1.example.test:3000',
      'http://192.168.1.10:3000',
    ]) reject(value);
    for (const value of [
      'http://localhost:3000',
      'http://dev.localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
    ]) {
      process.env.PUBLIC_BASE_URL = value;
      assert.doesNotThrow(() => assertProductionEnv(), value);
    }
  } finally {
    process.exit = exit;
    console.error = error;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
