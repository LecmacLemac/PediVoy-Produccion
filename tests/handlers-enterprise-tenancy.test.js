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

test('worker empresarial no hereda super de otro tenant', async () => {
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
  assert.ok(db.calls.every(({ params }) => params.includes(7)));
});

test('worker empresarial reconoce super activo del tenant', async () => {
  const db = scriptedQuery((sql, params) => {
    if (sql.includes('FROM usuarios') && params[0] === 7) {
      return [{ id: 1, role: 'super', empresa_id: 7, chofer_id: null, username: PHONE.replace('@c.us', '') }];
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
      return [{ chofer_id: 70, empresa_id: 7, nombre: 'Chofer 7' }];
    }
    throw new Error(`consulta inesperada: ${sql}`);
  });

  const ctx = await createWhatsAppContextResolver(db.query)(PHONE, { empresaId: 7 });

  assert.equal(ctx.role, 'repartidor');
  assert.equal(ctx.chofer_id, 70);
  assert.equal(ctx.empresa_id, 7);
});

test('repartidor con chofer cross-tenant degrada a cliente', async () => {
  const db = scriptedQuery((sql) => {
    if (sql.includes('FROM usuarios')) {
      return [{ role: 'repartidor', empresa_id: 7, chofer_id: 80, username: 'usuario7' }];
    }
    if (sql.includes('FROM choferes')) return [];
    throw new Error(`consulta inesperada: ${sql}`);
  });

  const ctx = await createWhatsAppContextResolver(db.query)(PHONE, { empresaId: 7 });

  assert.equal(ctx.role, 'cliente');
  assert.equal(ctx.chofer_id, null);
});

test('roles fuera de allowlist no reciben privilegios empresariales', async () => {
  const db = scriptedQuery((sql) => {
    if (sql.includes('FROM usuarios')) {
      return [{ role: 'owner_global', empresa_id: 7, chofer_id: null, username: 'usuario7' }];
    }
    throw new Error(`consulta inesperada: ${sql}`);
  });

  const ctx = await createWhatsAppContextResolver(db.query)(PHONE, { empresaId: 7 });

  assert.equal(ctx.role, 'cliente');
});

test('resolución empresarial exige usuario y chofer activos', async () => {
  const db = scriptedQuery(() => []);

  await createWhatsAppContextResolver(db.query)(PHONE, { empresaId: 7 });

  const identityQueries = db.calls.filter(({ sql }) => /FROM (usuarios|choferes)/.test(sql));
  assert.equal(identityQueries.length, 2);
  assert.ok(identityQueries.every(({ sql }) => /activo\s*=\s*TRUE/.test(sql)));
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
