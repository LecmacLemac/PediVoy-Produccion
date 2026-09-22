import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { getCompanySessionPaths } from '../src/wpp/companySession.js';

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
