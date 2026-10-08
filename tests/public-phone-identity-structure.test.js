import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('estructura: los tres lectores públicos inyectan withTransaction canónico desde producción', () => {
  const app = read('src/app.js');
  const mounts = read('src/routes/mountApiModules.js');
  assert.match(app, /createPublicLegacyCatalogRouter\(\{\s*query,\s*withTransaction\s*\}\)/);
  assert.match(mounts, /createPublicLandingRouter\(\{\s*query,\s*withTransaction\s*\}\)/);
});

test('estructura: resolución, lock global y consulta de negocio usan txQuery en cada endpoint', () => {
  const legacy = read('src/routes/publicLegacyCatalog.js');
  const landing = read('src/routes/publicLanding.js');

  assert.match(legacy, /falta withTransaction\(fn\)/);
  assert.match(landing, /falta withTransaction\(fn\)/);
  assert.doesNotMatch(legacy, /work\(query\)/);
  assert.doesNotMatch(landing, /work\(query\)/);
  assert.match(legacy, /router\.post\('\/contacto'[\s\S]*runInTransaction\(async txQuery[\s\S]*lockGeneralPhoneIdentity\(txQuery[\s\S]*resolveTenantDeliveryPointByPhone\(txQuery[\s\S]*const rows = await txQuery/);
  assert.match(legacy, /router\.get\('\/ultimo-pedido'[\s\S]*runInTransaction\(async txQuery[\s\S]*lockGeneralPhoneIdentity\(txQuery[\s\S]*resolveTenantDeliveryPointByPhone\(txQuery[\s\S]*let pedRows = await txQuery/);
  assert.match(landing, /router\.get\('\/pedidos\/ultimo'[\s\S]*runInTransaction\(async txQuery[\s\S]*lockGeneralPhoneIdentity\(txQuery[\s\S]*resolveTenantDeliveryPointByPhone\(txQuery[\s\S]*const rows = await txQuery/);

  for (const source of [legacy, landing]) {
    assert.match(source, /assertPublicPedidoEmpresaActive\(txQuery/);
    assert.match(source, /TRANSACTION_OUTCOME_UNKNOWN[\s\S]*status\(503\)/);
  }
});

test('estructura: lock de readers reutiliza namespace global exacto de deliveryPointIdentity', () => {
  const identity = read('src/services/deliveryPointIdentity.js');
  assert.match(identity, /GENERAL_PHONE_LOCK_CLASS\s*=\s*0x57505047/);
  assert.match(identity, /`whatsapp-general-phone:\$\{phone\}`/);
  assert.match(identity, /lockGeneralPhoneIdentity[\s\S]*lockGeneralPhoneIdentities/);
});
