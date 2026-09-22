import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink, access, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  clearStaleCompanyChromiumSingletons,
  getCompanySessionPaths,
} from '../src/wpp/companySession.js';

test('company session base path follows documented environment precedence', () => {
  const cwd = '/srv/app';
  const cases = [
    [{ EMPRESA_WPP_SESSION_PATH: '/empresa', DISK_PATH: '/disk', WPP_SESSION_PATH: '/legacy' }, '/empresa'],
    [{ DISK_PATH: '/disk', WPP_SESSION_PATH: '/legacy' }, '/disk'],
    [{ WPP_SESSION_PATH: '/legacy' }, '/legacy'],
    [{}, path.join(cwd, 'wpp_sessions')],
  ];

  for (const [env, expected] of cases) {
    assert.equal(getCompanySessionPaths({ empresaId: 8, env, cwd }).basePath, expected);
  }
});

test('LocalAuth dataPath and company sessionDir share the exact same base', () => {
  const paths = getCompanySessionPaths({
    empresaId: 31,
    env: { EMPRESA_WPP_SESSION_PATH: './persistent/company-wpp' },
    cwd: '/srv/pedivoy',
  });

  assert.equal(paths.dataPath, '/srv/pedivoy/persistent/company-wpp');
  assert.equal(paths.sessionDir, path.join(paths.dataPath, 'session-empresa_31'));
  assert.equal(paths.devToolsActivePortFile, path.join(paths.sessionDir, 'DevToolsActivePort'));
});

test('stale company Chromium singleton cleanup is disabled by default', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'company-session-cleanup-disabled-'));
  try {
    const sessionDir = path.join(root, 'session-empresa_1');
    await mkdir(sessionDir);
    await symlink('old-render-host-123', path.join(sessionDir, 'SingletonLock'));

    const result = clearStaleCompanyChromiumSingletons({
      env: { EMPRESA_WPP_SESSION_PATH: root },
      cwd: '/unused',
      fs,
      logger: { info() {} },
    });

    assert.deepEqual(result, { enabled: false, removed: [] });
    await lstat(path.join(sessionDir, 'SingletonLock'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('opt-in cleanup unlinks only singleton entries in valid company session directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'company-session-cleanup-enabled-'));
  try {
    const validOne = path.join(root, 'session-empresa_1');
    const validTwo = path.join(root, 'session-empresa_27');
    const invalidZero = path.join(root, 'session-empresa_0');
    const invalidSuffix = path.join(root, 'session-empresa_3-backup');
    await Promise.all([
      mkdir(validOne),
      mkdir(validTwo),
      mkdir(invalidZero),
      mkdir(invalidSuffix),
    ]);
    await Promise.all([
      symlink('old-render-lock', path.join(validOne, 'SingletonLock')),
      symlink('/tmp/old-render-socket', path.join(validOne, 'SingletonSocket')),
      writeFile(path.join(validTwo, 'SingletonCookie'), 'stale'),
      writeFile(path.join(validOne, 'Cookies'), 'keep'),
      writeFile(path.join(invalidZero, 'SingletonLock'), 'keep'),
      writeFile(path.join(invalidSuffix, 'SingletonSocket'), 'keep'),
      writeFile(path.join(root, 'SingletonCookie'), 'keep'),
    ]);

    const logs = [];
    const result = clearStaleCompanyChromiumSingletons({
      env: {
        EMPRESA_WPP_CLEAR_STALE_SINGLETONS_ON_BOOT: '1',
        EMPRESA_WPP_SESSION_PATH: root,
      },
      cwd: '/unused',
      fs,
      logger: { info(...args) { logs.push(args); } },
    });

    assert.deepEqual(result, {
      enabled: true,
      removed: [
        'session-empresa_1/SingletonLock',
        'session-empresa_1/SingletonSocket',
        'session-empresa_27/SingletonCookie',
      ],
    });
    for (const relative of result.removed) {
      assert.equal(fs.existsSync(path.join(root, relative)), false);
    }
    await Promise.all([
      access(path.join(validOne, 'Cookies')),
      access(path.join(invalidZero, 'SingletonLock')),
      access(path.join(invalidSuffix, 'SingletonSocket')),
      access(path.join(root, 'SingletonCookie')),
    ]);
    assert.deepEqual(logs, [[
      '[WPP EMPRESA] stale Chromium singleton cleanup:',
      { count: 3, paths: result.removed },
    ]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
