import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const renderPath = new URL('../render.yaml', import.meta.url);

function loadRenderBlueprint() {
  const script = [
    'import json, sys, yaml',
    'with open(sys.argv[1], encoding="utf-8") as source:',
    '    print(json.dumps(yaml.safe_load(source)))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', script, renderPath.pathname], { encoding: 'utf8' }));
}

test('Render declara un worker Cloud separado con DB y secreto de cifrado existentes', () => {
  const blueprint = loadRenderBlueprint();
  const web = blueprint.services.find(service => service.type === 'web');
  const worker = blueprint.services.find(service => service.type === 'worker');

  assert.ok(web, 'falta servicio web');
  assert.ok(worker, 'falta background worker');
  assert.equal(worker.runtime, web.runtime);
  assert.equal(worker.rootDir, web.rootDir);
  assert.equal(worker.buildCommand, web.buildCommand);
  assert.equal(worker.startCommand, 'npm run worker:whatsapp-cloud');

  const workerEnv = new Map(worker.envVars.map(entry => [entry.key, entry]));
  assert.deepEqual(workerEnv.get('DATABASE_URL'), {
    key: 'DATABASE_URL',
    fromDatabase: { name: 'pedivoy-db-staging', property: 'connectionString' },
  });
  assert.deepEqual(workerEnv.get('ARCA_TOKEN_ENCRYPTION_KEY'), {
    key: 'ARCA_TOKEN_ENCRYPTION_KEY',
    fromService: {
      name: 'pedivoy-web-staging',
      type: 'web',
      envVarKey: 'ARCA_TOKEN_ENCRYPTION_KEY',
    },
  });
  assert.equal(workerEnv.get('NODE_VERSION')?.value, 22);
  assert.equal(workerEnv.get('NODE_ENV')?.value, 'production');
  assert.equal(blueprint.databases.find(database => database.name === 'pedivoy-db-staging')?.postgresMajorVersion, '16');

  assert.equal(web.startCommand, 'npm start');
  assert.equal(readFileSync(renderPath, 'utf8').includes('npm start && npm run worker:whatsapp-cloud'), false);
});
