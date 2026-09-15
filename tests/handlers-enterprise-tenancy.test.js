import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTenantCommandQueries,
  createWhatsAppContextResolver,
  resolveCommandEmpresaId,
  shouldSuggestGlobalCompanies,
} from '../src/handlers.js';
import handlers from '../src/handlers.js';

const PHONE = '5491112345678@c.us';

function scriptedQuery(respond) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    return respond(String(sql), params);
  };
  return { query, calls };
}

test('worker empresarial limita clientes desconocidos al tenant', async () => {
  const db = scriptedQuery((sql) => {
    if (sql.includes('FROM usuarios')) return [];
    if (sql.includes('FROM choferes')) return [];
    if (sql.includes('FROM puntos_entrega')) return [];
    throw new Error(`consulta inesperada: ${sql}`);
  });
  const resolve = createWhatsAppContextResolver(db.query);

  const ctx = await resolve(PHONE, { empresaId: 7 });

  assert.deepEqual(ctx, {
    role: 'cliente',
    empresa_id: 7,
    chofer_id: null,
    source: 'desconocido',
    tenantLocked: true,
  });
  const identities = db.calls.filter(({ sql }) => /FROM usuarios|FROM choferes/.test(sql));
  assert.ok(identities.every(({ params }) => params[0] === '5491112345678'));
  const historical = db.calls.find(({ sql }) => /FROM puntos_entrega/.test(sql));
  assert.match(historical.sql, /empresa_id = \$2/);
  assert.deepEqual(historical.params, ['1112345678', 7]);
});

test('worker empresarial reconoce únicamente super global activo', async () => {
  const db = scriptedQuery((sql, params) => {
    if (sql.includes('FROM usuarios') && params[0] === '5491112345678') {
      return [{ id: 1, role: 'super', activo: true, empresa_id: null, chofer_id: null, referente_id: null, username: PHONE.replace('@c.us', '') }];
    }
    throw new Error(`consulta inesperada: ${sql}`);
  });

  const ctx = await createWhatsAppContextResolver(db.query)(PHONE, { empresaId: 7 });

  assert.equal(ctx.role, 'super');
  assert.equal(ctx.empresa_id, 7);
  assert.equal(ctx.tenantLocked, true);
});

test('start rechaza empresaId inválido antes de registrar listener', () => {
  let listeners = 0;
  const client = { on() { listeners += 1; } };

  assert.throws(
    () => handlers.start(client, { empresaId: '7.5' }),
    /empresaId/
  );
  assert.equal(listeners, 0);

  handlers.start(client, { empresaId: 7, contextResolver: async () => ({ role: 'cliente', empresa_id: 7 }) });
  assert.equal(listeners, 1);
});

test('comando empresarial ignora empresa indicada por texto', () => {
  const ctx = { empresa_id: 7, tenantLocked: true };

  assert.equal(resolveCommandEmpresaId(ctx, 'rentabilidad empresa 8'), 7);
  assert.equal(resolveCommandEmpresaId(ctx, 'estadistica emp=8'), 7);
});

test('resumen resuelve chofer exclusivamente dentro del tenant', async () => {
  const db = scriptedQuery(() => []);
  const commands = createTenantCommandQueries(db.query);

  await commands.findActiveDriver(7, '42');

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /empresa_id\s*=\s*\$1/);
  assert.match(db.calls[0].sql, /activo\s*=\s*TRUE/);
  assert.deepEqual(db.calls[0].params, [7, 42, '42']);
});

test('reposición busca el punto de entrega exclusivamente dentro del tenant', async () => {
  const db = scriptedQuery(() => []);
  const commands = createTenantCommandQueries(db.query);

  await commands.findLatestDeliveryPoint(7, PHONE);

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /empresa_id\s*=\s*\$1/);
  assert.deepEqual(db.calls[0].params, [7, '1112345678']);
});

test('worker empresarial reconoce chofer activo del tenant', async () => {
  const db = scriptedQuery((sql) => {
    if (sql.includes('FROM usuarios')) return [];
    if (sql.includes('FROM choferes')) {
      return [{ chofer_id: 70, empresa_id: 7, nombre: 'Chofer 7', activo: true }];
    }
    throw new Error(`consulta inesperada: ${sql}`);
  });

  const ctx = await createWhatsAppContextResolver(db.query)(PHONE, { empresaId: 7 });

  assert.equal(ctx.role, 'repartidor');
  assert.equal(ctx.chofer_id, 70);
  assert.equal(ctx.empresa_id, 7);
});

test('repartidor con chofer cross-tenant detiene la resolución', async () => {
  const db = scriptedQuery((sql) => {
    if (sql.includes('FROM usuarios')) {
      return [{ role: 'repartidor', activo: true, empresa_id: 7, chofer_id: 80, referente_id: null, chofer_valid: false, username: 'usuario7' }];
    }
    if (sql.includes('FROM choferes')) return [];
    throw new Error(`consulta inesperada: ${sql}`);
  });

  const ctx = await createWhatsAppContextResolver(db.query)(PHONE, { empresaId: 7 });

  assert.equal(ctx, null);
  assert.equal(db.calls.length, 1);
});

test('roles fuera de allowlist no reciben privilegios empresariales', async () => {
  const db = scriptedQuery((sql) => {
    if (sql.includes('FROM usuarios')) {
      return [{ role: 'owner_global', empresa_id: 7, chofer_id: null, username: 'usuario7' }];
    }
    throw new Error(`consulta inesperada: ${sql}`);
  });

  const ctx = await createWhatsAppContextResolver(db.query)(PHONE, { empresaId: 7 });

  assert.equal(ctx, null);
  assert.equal(db.calls.length, 1);
});

test('resolución empresarial consulta todas las identidades exactas incluyendo inactivas', async () => {
  const db = scriptedQuery(() => []);

  await createWhatsAppContextResolver(db.query)(PHONE, { empresaId: 7 });

  const identityQueries = db.calls.filter(({ sql }) => /FROM (usuarios|choferes)/.test(sql));
  assert.equal(identityQueries.length, 2);
  assert.ok(identityQueries.every(({ sql }) => /activo/.test(sql)));
  assert.ok(identityQueries.every(({ sql }) => !/LIMIT|LIKE|WHERE.*activo\s*=/s.test(sql)));
  assert.ok(identityQueries.every(({ sql, params }) => /regexp_replace/.test(sql) && params[0] === '5491112345678'));
});

test('canal General conserva selección de empresa por texto', () => {
  assert.equal(
    resolveCommandEmpresaId({ empresa_id: 7 }, 'rentabilidad empresa 8'),
    8
  );
});

test('cliente desconocido empresarial no dispara búsqueda global de empresas', () => {
  assert.equal(
    shouldSuggestGlobalCompanies({ source: 'desconocido', tenantLocked: true }),
    false
  );
  assert.equal(shouldSuggestGlobalCompanies({ source: 'desconocido' }), true);
});

for (const empresaId of [undefined, 7]) {
  for (const identity of [
    { role: 'super', empresa_id: 7 },
    { role: 'SUPER', empresa_id: null },
    { role: ' super ', empresa_id: null },
    { role: 'admin', empresa_id: null },
    { role: 'user', empresa_id: 7, activo: false },
  ]) {
    test(`resolver compartido rechaza ${JSON.stringify(identity)} con worker=${empresaId}`, async () => {
      const db = scriptedQuery((sql) => {
        assert.match(sql, /FROM usuarios/);
        return [{ activo: true, chofer_id: null, referente_id: null, ...identity }];
      });
      assert.equal(await createWhatsAppContextResolver(db.query)(PHONE, { empresaId }), null);
      assert.equal(db.calls.length, 1, 'Una identidad inválida no permite fallback');
    });
  }
}

for (const role of ['admin', 'user', 'facturacion', 'contable']) {
  test(`worker mantiene ${role} en su tenant sin elevar privilegios`, async () => {
    const db = scriptedQuery(() => [{ role, activo: true, empresa_id: 7, chofer_id: null, referente_id: null }]);
    const resolve = createWhatsAppContextResolver(db.query);
    const ctx = await resolve(PHONE, { empresaId: 7 });
    assert.equal(ctx.role, role);
    assert.equal(ctx.empresa_id, 7);
    assert.equal(ctx.tenantLocked, true);
    assert.equal(await resolve(PHONE, { empresaId: 8 }), null);
  });
}
