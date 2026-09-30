import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);

function source(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('inventario estructural: General y routers públicos no resuelven tenant/identidad con primer o último id', () => {
  const files = [
    'src/handlers.js',
    'src/routes/publicClientApp.js',
    'src/routes/publicLegacyCatalog.js',
    'src/routes/publicLanding.js',
  ];
  for (const relative of files) {
    const text = source(relative);
    assert.doesNotMatch(
      text,
      /SELECT\s+id\s+FROM\s+empresas\s+ORDER\s+BY\s+id\s+(?:ASC\s+|DESC\s+)?LIMIT\s+1/i,
      relative
    );
    assert.doesNotMatch(
      text,
      /FROM\s+puntos_entrega[\s\S]{0,500}ORDER\s+BY\s+(?:pe\.)?id\s+DESC[\s\S]{0,100}LIMIT\s+1/i,
      relative
    );
    const identityQueries = [...text.matchAll(
      /`[^`]*\bFROM\s+(?:empresas|usuarios|choferes|puntos_entrega)\b[^`]*`/gi
    )].map(match => match[0]);
    for (const sql of identityQueries) {
      assert.doesNotMatch(
        sql,
        /ORDER\s+BY[\s\S]*?(?:\bid\b|\.id\b)[\s\S]*?LIMIT\s+1/i,
        `${relative}: consulta de identidad no puede seleccionar primera/última fila`
      );
    }
  }
});

test('inventario estructural: último pedido sólo se ordena después de un punto cardinalmente único', () => {
  const legacy = source('src/routes/publicLegacyCatalog.js');
  const modern = source('src/routes/publicLanding.js');
  const resolver = source('src/services/deliveryPointIdentity.js');

  assert.match(resolver, /LIMIT 2[\s\S]*rows\.length !== 1[\s\S]*status: 'ambiguous'/);
  const legacyResolutionAt = legacy.indexOf('resolveTenantDeliveryPointByPhone');
  const legacyUniqueGateAt = legacy.indexOf("identity.status !== 'unique'", legacyResolutionAt);
  const legacyLatestAt = legacy.indexOf('ORDER BY p.fecha DESC, p.id DESC', legacyUniqueGateAt);
  const legacyAmbiguityAt = legacy.indexOf("identityStatus === 'ambiguous'", legacyLatestAt);
  assert.ok(legacyResolutionAt >= 0 && legacyUniqueGateAt > legacyResolutionAt
    && legacyLatestAt > legacyUniqueGateAt && legacyAmbiguityAt > legacyLatestAt);

  const modernResolutionAt = modern.indexOf('resolveTenantDeliveryPointByPhone');
  const modernUniqueGateAt = modern.indexOf("identity.status !== 'unique'", modernResolutionAt);
  const modernLatestAt = modern.indexOf('ORDER BY p.fecha DESC, p.id DESC', modernUniqueGateAt);
  const modernAmbiguityAt = modern.indexOf("status === 'ambiguous'", modernLatestAt);
  assert.ok(modernResolutionAt >= 0 && modernUniqueGateAt > modernResolutionAt
    && modernLatestAt > modernUniqueGateAt && modernAmbiguityAt > modernLatestAt);
});

test('inventario estructural: OTP/OAuth ligan sesión a profile_id y bloquean namespaces canónicos', () => {
  const text = source('src/routes/publicClientApp.js');
  assert.match(text, /profile_id: profileId/);
  assert.match(text, /lockGeneralPhoneIdentity[\s\S]*public-client:\$\{kind\}:\$\{value\}/);
  assert.match(text, /identityStatus: identity\.status/);
  assert.match(text, /resolved\.status !== otp\.identityStatus \|\| currentProfileId !== otp\.profileId/);
  assert.match(text, /resolveProfileByEmail[\s\S]*status === 'ambiguous'/);
});
