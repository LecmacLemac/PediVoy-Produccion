import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = name => readFile(new URL('../' + name, import.meta.url), 'utf8');

test('production installs personal-agent boundary before permissive CORS and general body parser', async () => {
  const app = await source('src/app.js');
  const boundary = app.indexOf('app.use(personalAgentHttpBoundary(');
  assert.ok(boundary > 0, 'Personal integrations need an early HTTP trust boundary');
  assert.ok(boundary < app.indexOf('app.use(cors('));
  assert.ok(boundary < app.indexOf("app.use(express.json({ limit: '1mb'"));
  assert.match(app, /agentCanonicalOrigin:\s*deps\?\.agentCanonicalOrigin/);
});

test('production mount source includes personal management and external agent modules', async () => {
  const mount = await source('src/routes/mountApiModules.js');
  assert.match(mount, /import\s+\{\s*mountPersonalAgentModules\s*\}\s+from\s+'\.\/mountPersonalAgents\.js'/);
  assert.match(mount, /mountPersonalAgentModules\(app, deps\)/);
});

test('factory wiring defaults disabled and uses only explicit canonical origin and injected dependencies', async () => {
  const { mountPersonalAgentModules } = await import('../src/routes/mountPersonalAgents.js');
  const mounts = [], calls = [];
  const query = async () => { throw new Error('No DB calls during module mount'); };
  const withTransaction = async () => { throw new Error('No transactions during module mount'); };
  const withAuth = (_req, _res, next) => next();
  const service = {}, tools = {}, humanRouter = () => {}, apiRouter = () => {};
  const factories = {
    createService: options => { calls.push(['service', options]); return service; },
    createTools: options => { calls.push(['tools', options]); return tools; },
    createManagementRouter: options => { calls.push(['human', options]); return humanRouter; },
    createToolsRouter: options => { calls.push(['api', options]); return apiRouter; },
    env: {},
  };
  const app = { use: (...args) => mounts.push(args) };
  const result = mountPersonalAgentModules(app, { query, withTransaction, withAuth }, factories);
  assert.equal(calls[0][1].enabled, false);
  assert.equal(calls[0][1].canonicalOrigin, '');
  assert.equal(calls[0][1].query, query);
  assert.equal(calls[0][1].withTransaction, withTransaction);
  assert.equal(calls[1][1].query, query);
  assert.equal(calls[2][1].withAuth, withAuth);
  assert.equal(calls[2][1].service, service);
  assert.equal(calls[3][1].service, service);
  assert.equal(calls[3][1].tools, tools);
  assert.deepEqual(mounts, [['/api/mi-agente', humanRouter], ['/api/agent/v1', apiRouter]]);
  assert.deepEqual(result, { service, tools });
  calls.length = 0;
  mountPersonalAgentModules(app, { query, withTransaction, withAuth, personalAgentsEnabled: true, agentCanonicalOrigin: 'https://www.pedivoy.com' }, factories);
  assert.equal(calls[0][1].enabled, true);
  assert.equal(calls[0][1].canonicalOrigin, 'https://www.pedivoy.com');
});
