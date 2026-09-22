import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerUrl = new URL('../src/wppWorker.js', import.meta.url);

test('empresa worker acquires distributed ownership before client creation', async () => {
  const source = await readFile(workerUrl, 'utf8');
  assert.match(source, /createCompanyOwnership/);
  assert.match(source, /createCompanyLifecycle/);
  assert.match(source, /import \{ ensureCompanyWorkerSchema \} from '\.\/wpp\/companySchema\.js';/);
  assert.doesNotMatch(source, /async function ensureEmpresaWhatsappSchema/);
  assert.match(source, /createWppClientAdapter/);
  assert.doesNotMatch(source, /removeChromiumSingletonLocks/);
  assert.doesNotMatch(source, /Singleton(?:Lock|Socket|Cookie)/);

  const ownership = source.indexOf('createCompanyOwnership(');
  const lifecycle = source.indexOf('createCompanyLifecycle(');
  const startup = source.indexOf('lifecycle.start({ beforeInitialize: ensureCompanyWorkerSchema })');
  assert.ok(ownership >= 0 && lifecycle > ownership && startup > lifecycle);
  assert.match(source, /clientFactory:\s*\{\s*create:\s*createManagedCompanyClient\s*\}/);
  assert.match(source, /function createManagedCompanyClient[\s\S]*new Client\(/);
  assert.match(source, /lifecycle\.start\(\{\s*beforeInitialize:\s*ensureCompanyWorkerSchema\s*\}\)/);
});

test('empresa worker gates stale events and sends on active ownership', async () => {
  const source = await readFile(workerUrl, 'utf8');
  assert.match(source, /lifecycle\.withClientEvent\(managedClient, generation/);
  assert.match(source, /assertCurrent\(\)[\s\S]*persistStatus[\s\S]*assertCurrent\(\)/);
  assert.match(source, /lifecycle\.withActiveClient\(/);
  assert.match(source, /ownership\.heartbeat\(/);
  assert.match(source, /async sendMessage\([.]{3}args\)[\s\S]*ownership\.heartbeat\([\s\S]*current\(\)/);
  assert.match(source, /ownershipLost\(error\)\.catch\(fatalWorkerExit\)/);
  assert.match(source, /handlers\.start\(managedClient/);
});

test('empresa worker marks reset handled only after successful reset', async () => {
  const source = await readFile(workerUrl, 'utf8');
  const resetCall = source.indexOf('await lifecycle.reset(marker)');
  const clearMarker = source.indexOf('wpp_reset_requested_at = NULL', resetCall);
  const handled = source.indexOf('lastResetHandledAt = marker', resetCall);
  assert.ok(resetCall >= 0 && clearMarker > resetCall && handled > clearMarker);
});

test('empresa worker uses the shared company session path for LocalAuth and reset', async () => {
  const source = await readFile(workerUrl, 'utf8');
  assert.match(source, /getCompanySessionPaths/);
  assert.match(source, /dataPath:\s*sessionPaths\.dataPath/);
  assert.match(source, /fs\.rmSync\(sessionPaths\.sessionDir/);
});

test('web parent keeps child attached with inherited output', async () => {
  const source = await readFile(new URL('../src/routes/empresas.js', import.meta.url), 'utf8');
  assert.match(source, /detached:\s*false/);
  assert.match(source, /stdio:\s*\['ignore',\s*'inherit',\s*'inherit'\]/);
  assert.doesNotMatch(source, /child\.unref\(\)/);
  assert.match(source, /shutdownEmpresaWppWorkers/);
});
