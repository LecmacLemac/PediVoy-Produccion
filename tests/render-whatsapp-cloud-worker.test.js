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

function envMap(service) {
  return new Map((service.envVars || []).map(entry => [entry.key, entry]));
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

  const workerEnv = envMap(worker);
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

test('cada web Render de producción declara un origen público HTTPS canónico alineado con CORS y arranca el gate', () => {
  const blueprint = loadRenderBlueprint();
  const productionWebServices = blueprint.services.filter(service => {
    const env = envMap(service);
    return service.type === 'web' && env.get('NODE_ENV')?.value === 'production';
  });

  assert.ok(productionWebServices.length > 0, 'falta un servicio web de producción para validar');
  for (const service of productionWebServices) {
    const env = envMap(service);
    const canonical = env.get('PUBLIC_BASE_URL')?.value || env.get('APP_PUBLIC_URL')?.value;
    assert.ok(canonical, `${service.name}: falta PUBLIC_BASE_URL/APP_PUBLIC_URL explícita`);

    const parsed = new URL(canonical);
    assert.equal(parsed.protocol, 'https:', `${service.name}: el origen público debe usar HTTPS`);
    assert.equal(parsed.origin, canonical, `${service.name}: debe ser un origen exacto, sin path/query/hash`);
    assert.equal(parsed.username, '');
    assert.equal(parsed.password, '');

    const corsOrigins = String(env.get('CORS_ALLOWED_ORIGINS')?.value || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    assert.ok(corsOrigins.includes(canonical), `${service.name}: el origen canónico debe estar permitido por CORS`);

    const probe = [
      "import { assertProductionEnv } from './src/bootstrap/env.js';",
      'assertProductionEnv();',
      "process.stdout.write('startup-env-ok');",
    ].join('\n');
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        JWT_SECRET: 'render-blueprint-probe-secret-1234567890',
        PUBLIC_BASE_URL: env.get('PUBLIC_BASE_URL')?.value || '',
        APP_PUBLIC_URL: env.get('APP_PUBLIC_URL')?.value || '',
        LOCAL_HTTP_DEV: '',
      },
    });
    assert.equal(output, 'startup-env-ok');
  }
});
