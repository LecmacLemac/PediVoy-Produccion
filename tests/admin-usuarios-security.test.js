import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';

import { createAdminUsuariosRouter } from '../src/routes/adminUsuarios.js';

const initSql = fs.readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');

async function withServer(app, fn) {
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function tokenFor(user) {
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

function buildApp({
  query = async () => [],
  withTransaction,
  onAuth = () => {},
  actorRow = { id: 10, role: 'admin', empresa_id: 3, activo: true },
} = {}) {
  const app = express();
  const runTransaction = withTransaction || (async work => {
    const txQuery = async (sql, params) => {
      if (/FROM usuarios[\s\S]*FOR SHARE/i.test(sql)) {
        const row = typeof actorRow === 'function' ? actorRow(params?.[0]) : actorRow;
        return row ? [{ ...row }] : [];
      }
      return query(sql, params);
    };
    const client = {
      async query(sql, params) {
        const rows = await txQuery(sql, params);
        if (/^(UPDATE|DELETE)/i.test(sql.trim()) && rows.length === 0) {
          return { rows: [{ id: params.at(-2) ?? params[0] }], rowCount: 1 };
        }
        return { rows, rowCount: rows.length };
      },
    };
    return work(txQuery, client);
  });
  app.use(express.json());
  app.use('/api/admin', createAdminUsuariosRouter({
    query,
    withTransaction: runTransaction,
    withAuth(req, res, next) {
      onAuth();
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
      req.user = JSON.parse(Buffer.from(header.slice(7), 'base64url').toString('utf8'));
      return next();
    },
    isSuper: req => String(req.user?.role || '').toLowerCase() === 'super',
    getEmpresaIdFromToken: req => req.user?.empresa_id,
  }));
  return app;
}

async function request(baseUrl, user, method, path = '/api/admin/usuarios', body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokenFor(user)}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const usuarioOperations = [
  { method: 'GET' },
  { method: 'POST', body: { username: 'intruso', password: 'secreto1', role: 'admin', empresa_id: 999 } },
  { method: 'PUT', path: '/api/admin/usuarios/1', body: { role: 'admin' } },
  { method: 'DELETE', path: '/api/admin/usuarios/1' },
];

test('GET/POST/PUT/DELETE /usuarios bloquean type no-user antes de consultar DB', async () => {
  const blockedUsers = [
    { uid: 6, role: 'admin', type: 'client', empresa_id: 1 },
  ];

  for (const user of blockedUsers) {
    let authCalls = 0;
    const queries = [];
    const app = buildApp({
      onAuth: () => { authCalls += 1; },
      query: async (...args) => { queries.push(args); return []; },
    });

    await withServer(app, async baseUrl => {
      for (const operation of usuarioOperations) {
        const response = await request(baseUrl, user, operation.method, operation.path, operation.body);
        assert.equal(response.status, 403, `${user.type || user.role}: ${operation.method}`);
      }
    });

    assert.equal(authCalls, usuarioOperations.length);
    assert.equal(queries.length, 0, `${user.type || user.role} no debe consultar`);
  }
});

test('admin lista exclusivamente su empresa aunque intente override', async () => {
  const calls = [];
  const app = buildApp({ query: async (sql, params) => {
    calls.push({ sql, params });
    return [{ id: 8, username: 'operador', role: 'user', empresa_id: 3 }];
  } });

  await withServer(app, async baseUrl => {
    const response = await request(baseUrl, { uid: 10, role: 'admin', empresa_id: 3 }, 'GET', '/api/admin/usuarios?empresa_id=999');
    assert.equal(response.status, 200);
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE empresa_id=\$1/);
  assert.deepEqual(calls[0].params, [3]);
});

test('admin sin tenant válido y super con filtro inválido fallan cerrado antes de listar', async () => {
  for (const scenario of [
    { user: { uid: 10, role: 'admin' }, actor: { id: 10, role: 'admin', empresa_id: null, activo: true }, path: '/api/admin/usuarios', status: 403 },
    { user: { uid: 11, role: 'super' }, actor: { id: 11, role: 'super', empresa_id: null, activo: true }, path: '/api/admin/usuarios?empresa_id=invalida', status: 400 },
  ]) {
    const calls = [];
    const app = buildApp({ actorRow: scenario.actor, query: async (...args) => { calls.push(args); return []; } });
    await withServer(app, async baseUrl => {
      const response = await request(baseUrl, scenario.user, 'GET', scenario.path);
      assert.equal(response.status, scenario.status);
    });
    assert.equal(calls.length, 0);
  }
});

test('admin solo crea roles operativos en su tenant y valida la empresa antes del hash/insert', async () => {
  for (const role of ['admin', 'super', 'inventado']) {
    const calls = [];
    const app = buildApp({ query: async (...args) => { calls.push(args); return []; } });
    await withServer(app, async baseUrl => {
      const response = await request(baseUrl, { uid: 10, role: 'admin', empresa_id: 3 }, 'POST', '/api/admin/usuarios', {
        username: `nuevo-${role}`,
        password: 'secreto1',
        role,
        empresa_id: 999,
      });
      assert.equal(response.status, role === 'inventado' ? 400 : 403, role);
    });
    assert.equal(calls.length, 0, role);
  }

  const calls = [];
  const app = buildApp({ query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM empresas')) return [{ id: 3 }];
    if (sql.includes('INSERT INTO usuarios')) return [{ id: 20, username: 'operador' }];
    throw new Error(`SQL inesperado: ${sql}`);
  } });
  await withServer(app, async baseUrl => {
    const response = await request(baseUrl, { uid: 10, role: 'admin', empresa_id: 3 }, 'POST', '/api/admin/usuarios', {
      username: 'operador', password: 'secreto1', role: 'referente', empresa_id: 999,
    });
    assert.equal(response.status, 200);
  });
  assert.match(calls[0].sql, /FROM empresas/);
  assert.deepEqual(calls[0].params, [3]);
  assert.equal(calls[1].params[2], 'referente');
  assert.equal(calls[1].params[3], 3);
});

test('super valida tenant y puede crear admin y super', async () => {
  const calls = [];
  const app = buildApp({ actorRow: { id: 1, role: 'super', empresa_id: null, activo: true }, query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM empresas')) return params[0] === 7 ? [{ id: 7 }] : [];
    if (sql.includes('INSERT INTO usuarios')) return [{ id: 30, username: params[0] }];
    throw new Error(`SQL inesperado: ${sql}`);
  } });

  await withServer(app, async baseUrl => {
    const bad = await request(baseUrl, { uid: 1, role: 'super' }, 'POST', '/api/admin/usuarios', {
      username: 'admin-mal', password: 'secreto1', role: 'admin', empresa_id: 999,
    });
    assert.equal(bad.status, 400);

    const badSuperEmpresa = await request(baseUrl, { uid: 1, role: 'super' }, 'POST', '/api/admin/usuarios', {
      username: 'super-mal', password: 'secreto1', role: 'super', empresa_id: 7,
    });
    assert.equal(badSuperEmpresa.status, 400);

    const admin = await request(baseUrl, { uid: 1, role: 'super' }, 'POST', '/api/admin/usuarios', {
      username: 'admin-ok', password: 'secreto1', role: 'admin', empresa_id: 7,
    });
    assert.equal(admin.status, 200);

    const superUser = await request(baseUrl, { uid: 1, role: 'super' }, 'POST', '/api/admin/usuarios', {
      username: 'super-ok', password: 'secreto1', role: 'super', empresa_id: null,
    });
    assert.equal(superUser.status, 200);
  });

  const inserts = calls.filter(call => call.sql.includes('INSERT INTO usuarios'));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map(call => [call.params[2], call.params[3]]), [['admin', 7], ['super', null]]);
});

test('admin edita y elimina operativos solo dentro de su tenant, nunca admin/super', async () => {
  const calls = [];
  const targets = new Map([
    ['10', { id: 10, role: 'user', empresa_id: 3 }],
    ['11', { id: 11, role: 'admin', empresa_id: 3 }],
  ]);
  const app = buildApp({ actorRow: actorId => ({
    id: actorId,
    role: 'admin',
    empresa_id: Number(actorId) === 2 ? 4 : 3,
    activo: true,
  }), query: async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM usuarios[\s\S]*FOR UPDATE/i.test(sql)) {
      const target = targets.get(String(params[0]));
      return target && Number(params[1]) === target.empresa_id ? [target] : [];
    }
    if (sql.includes('FROM empresas')) return [{ id: params[0] }];
    if (sql.includes('UPDATE usuarios') || sql.includes('DELETE FROM usuarios')) return [];
    throw new Error(`SQL inesperado: ${sql}`);
  } });

  await withServer(app, async baseUrl => {
    const update = await request(baseUrl, { uid: 1, role: 'admin', empresa_id: 3 }, 'PUT', '/api/admin/usuarios/10', { username: 'nuevo' });
    assert.equal(update.status, 200);
    const remove = await request(baseUrl, { uid: 1, role: 'admin', empresa_id: 3 }, 'DELETE', '/api/admin/usuarios/10');
    assert.equal(remove.status, 200);
    const privileged = await request(baseUrl, { uid: 1, role: 'admin', empresa_id: 3 }, 'PUT', '/api/admin/usuarios/11', { activo: false });
    assert.equal(privileged.status, 403);
    const crossTenant = await request(baseUrl, { uid: 2, role: 'admin', empresa_id: 3 }, 'DELETE', '/api/admin/usuarios/10');
    assert.equal(crossTenant.status, 404);
    const override = await request(baseUrl, { uid: 1, role: 'admin', empresa_id: 3 }, 'PUT', '/api/admin/usuarios/10', { empresa_id: 4 });
    assert.equal(override.status, 403);
  });

  const writes = calls.filter(call => /UPDATE usuarios|DELETE FROM usuarios/.test(call.sql));
  assert.equal(writes.length, 2);
  for (const call of writes) {
    assert.match(call.sql, /empresa_id/);
    assert.equal(call.params.at(-1), 3);
  }
});

test('super opera cross-tenant y puede modificar/eliminar admin o super', async () => {
  const calls = [];
  const app = buildApp({ actorRow: { id: 1, role: 'super', empresa_id: null, activo: true }, query: async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM usuarios[\s\S]*FOR UPDATE/i.test(sql)) return [{ id: Number(params[0]), role: 'admin', empresa_id: 8 }];
    if (sql.includes('FROM empresas')) return [{ id: 9 }];
    if (sql.includes('UPDATE usuarios') || sql.includes('DELETE FROM usuarios')) return [];
    throw new Error(`SQL inesperado: ${sql}`);
  } });

  await withServer(app, async baseUrl => {
    const update = await request(baseUrl, { uid: 1, role: 'super' }, 'PUT', '/api/admin/usuarios/40', { role: 'super', empresa_id: null });
    assert.equal(update.status, 200);
    const moveAdmin = await request(baseUrl, { uid: 1, role: 'super' }, 'PUT', '/api/admin/usuarios/41', { role: 'admin', empresa_id: 9 });
    assert.equal(moveAdmin.status, 200);
    const remove = await request(baseUrl, { uid: 1, role: 'super' }, 'DELETE', '/api/admin/usuarios/42');
    assert.equal(remove.status, 200);
  });

  assert.equal(calls.filter(call => /UPDATE usuarios|DELETE FROM usuarios/.test(call.sql)).length, 3);
});

test('allowlist acepta roles backoffice reales y rechaza roles desconocidos también al editar', async () => {
  for (const role of ['facturacion', 'contable']) {
    const calls = [];
    const app = buildApp({ query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM empresas')) return [{ id: 3 }];
      if (sql.includes('INSERT INTO usuarios')) return [{ id: 50, username: params[0] }];
      throw new Error(`SQL inesperado: ${sql}`);
    } });
    await withServer(app, async baseUrl => {
      const response = await request(baseUrl, { uid: 1, role: 'admin', empresa_id: 3 }, 'POST', '/api/admin/usuarios', {
        username: role, password: 'secreto1', role,
      });
      assert.equal(response.status, 200, role);
    });
    assert.equal(calls.at(-1).params[2], role);
  }

  const calls = [];
  const app = buildApp({ query: async (...args) => { calls.push(args); return []; } });
  await withServer(app, async baseUrl => {
    const response = await request(baseUrl, { uid: 1, role: 'super' }, 'PUT', '/api/admin/usuarios/8', { role: 'inventado' });
    assert.equal(response.status, 400);
  });
  assert.equal(calls.length, 0);
});

test('al promover a super se elimina el tenant aunque empresa_id sea omitido', async () => {
  const calls = [];
  const app = buildApp({ actorRow: { id: 1, role: 'super', empresa_id: null, activo: true }, query: async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM usuarios[\s\S]*FOR UPDATE/i.test(sql)) return [{ id: 8, role: 'admin', empresa_id: 4 }];
    if (sql.includes('UPDATE usuarios')) return [];
    throw new Error(`SQL inesperado: ${sql}`);
  } });

  await withServer(app, async baseUrl => {
    const response = await request(baseUrl, { uid: 1, role: 'super' }, 'PUT', '/api/admin/usuarios/8', { role: 'super' });
    assert.equal(response.status, 200);
  });

  const update = calls.find(call => call.sql.includes('UPDATE usuarios'));
  assert.match(update.sql, /empresa_id=/);
  assert.equal(update.params.includes(null), true);
});

test('POST valida chofer y referente por rol y tenant antes de insertar', async () => {
  const calls = [];
  const app = buildApp({ actorRow: actorId => Number(actorId) === 2
    ? { id: 2, role: 'super', empresa_id: null, activo: true }
    : { id: 1, role: 'admin', empresa_id: 3, activo: true }, query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM empresas')) return [{ id: params[0] }];
    if (sql.includes('FROM choferes')) {
      const sameTenant = (params[0] === 11 && params[1] === 3)
        || (params[0] === 44 && params[1] === 4);
      return sameTenant ? [{ id: params[0] }] : [];
    }
    if (sql.includes('FROM referentes')) return params[0] === 31 && params[1] === 3 ? [{ id: 31 }] : [];
    if (sql.includes('INSERT INTO usuarios')) return [{ id: 70, username: params[0] }];
    throw new Error(`SQL inesperado: ${sql}`);
  } });

  const actor = { uid: 1, role: 'admin', empresa_id: 3 };
  const scenarios = [
    { body: { username: 'chofer-cross', password: 'secreto1', role: 'repartidor', chofer_id: 22 }, status: 400 },
    { body: { username: 'chofer-missing', password: 'secreto1', role: 'repartidor', chofer_id: 99 }, status: 400 },
    { body: { username: 'ref-cross', password: 'secreto1', role: 'referente', referente_id: 42 }, status: 400 },
    { body: { username: 'ref-missing', password: 'secreto1', role: 'referente', referente_id: 99 }, status: 400 },
    { body: { username: 'user-chofer', password: 'secreto1', role: 'user', chofer_id: 11 }, status: 400 },
    { body: { username: 'user-chofer-empty', password: 'secreto1', role: 'user', chofer_id: '' }, status: 400 },
    { body: { username: 'rep-chofer-empty', password: 'secreto1', role: 'repartidor', chofer_id: '' }, status: 400 },
    { body: { username: 'user-ref', password: 'secreto1', role: 'user', referente_id: 31 }, status: 400 },
    { body: { username: 'rep-ref', password: 'secreto1', role: 'repartidor', chofer_id: 11, referente_id: 31 }, status: 400 },
    { body: { username: 'ref-chofer', password: 'secreto1', role: 'referente', referente_id: 31, chofer_id: 11 }, status: 400 },
    { body: { username: 'chofer-ok', password: 'secreto1', role: 'repartidor', chofer_id: 11 }, status: 200 },
    { body: { username: 'ref-ok', password: 'secreto1', role: 'referente', referente_id: 31 }, status: 200 },
    { body: { username: 'user-null', password: 'secreto1', role: 'user', chofer_id: null, referente_id: null }, status: 200 },
  ];

  await withServer(app, async baseUrl => {
    for (const scenario of scenarios) {
      const response = await request(baseUrl, actor, 'POST', '/api/admin/usuarios', scenario.body);
      assert.equal(response.status, scenario.status, scenario.body.username);
    }

    const superActor = { uid: 2, role: 'super' };
    const crossTenant = await request(baseUrl, superActor, 'POST', '/api/admin/usuarios', {
      username: 'super-chofer-cross', password: 'secreto1', role: 'repartidor', empresa_id: 4, chofer_id: 11,
    });
    assert.equal(crossTenant.status, 400);
    const sameTenant = await request(baseUrl, superActor, 'POST', '/api/admin/usuarios', {
      username: 'super-chofer-ok', password: 'secreto1', role: 'repartidor', empresa_id: 4, chofer_id: 44,
    });
    assert.equal(sameTenant.status, 200);
  });

  const inserts = calls.filter(call => call.sql.includes('INSERT INTO usuarios'));
  assert.equal(inserts.length, 4);
  assert.deepEqual(inserts.map(call => [call.params[2], call.params[3], call.params[4], call.params[5]]), [
    ['repartidor', 3, 11, null],
    ['referente', 3, null, 31],
    ['user', 3, null, null],
    ['repartidor', 4, 44, null],
  ]);
  for (const insert of inserts.filter(call => call.params[2] !== 'user')) {
    const insertIndex = calls.indexOf(insert);
    const relationLookupIndex = calls.findIndex((call, index) => index < insertIndex && /FROM (choferes|referentes)/.test(call.sql));
    assert.notEqual(relationLookupIndex, -1, 'el vínculo se valida antes del hash/insert');
  }
});

test('PUT valida vínculos con rol y tenant efectivos y limpia los incompatibles', async () => {
  async function runScenario({ actor, target, body, expectedStatus }) {
    const calls = [];
    const app = buildApp({ actorRow: {
      id: actor.uid,
      role: actor.role,
      empresa_id: actor.empresa_id ?? null,
      activo: true,
    }, query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM usuarios[\s\S]*FOR UPDATE/i.test(sql)) return [target];
      if (sql.includes('FROM empresas')) return [{ id: params[0] }];
      if (sql.includes('FROM choferes')) {
        const sameTenant = (params[0] === 11 && params[1] === 3)
          || (params[0] === 12 && params[1] === 3)
          || (params[0] === 44 && params[1] === 4);
        return sameTenant ? [{ id: params[0] }] : [];
      }
      if (sql.includes('FROM referentes')) {
        const sameTenant = (params[0] === 31 && params[1] === 3)
          || (params[0] === 32 && params[1] === 3);
        return sameTenant ? [{ id: params[0] }] : [];
      }
      if (sql.includes('UPDATE usuarios')) return [];
      throw new Error(`SQL inesperado: ${sql}`);
    } });

    await withServer(app, async baseUrl => {
      const response = await request(baseUrl, actor, 'PUT', `/api/admin/usuarios/${target.id}`, body);
      assert.equal(response.status, expectedStatus);
    });
    return calls;
  }

  const admin = { uid: 1, role: 'admin', empresa_id: 3 };
  const repartidor = { id: 80, role: 'repartidor', empresa_id: 3, chofer_id: 11, referente_id: null };
  const referente = { id: 81, role: 'referente', empresa_id: 3, chofer_id: null, referente_id: 31 };

  for (const chofer_id of [22, 99]) {
    const calls = await runScenario({ actor: admin, target: repartidor, body: { chofer_id }, expectedStatus: 400 });
    assert.equal(calls.some(call => call.sql.includes('UPDATE usuarios')), false);
  }
  for (const referente_id of [42, 99]) {
    const calls = await runScenario({ actor: admin, target: referente, body: { referente_id }, expectedStatus: 400 });
    assert.equal(calls.some(call => call.sql.includes('UPDATE usuarios')), false);
  }

  const choferHappy = await runScenario({ actor: admin, target: repartidor, body: { chofer_id: 12 }, expectedStatus: 200 });
  const choferUpdate = choferHappy.find(call => call.sql.includes('UPDATE usuarios'));
  assert.match(choferUpdate.sql, /chofer_id=/);
  assert.equal(choferUpdate.params.includes(12), true);

  const referenteHappy = await runScenario({ actor: admin, target: referente, body: { referente_id: 32 }, expectedStatus: 200 });
  const referenteUpdate = referenteHappy.find(call => call.sql.includes('UPDATE usuarios'));
  assert.match(referenteUpdate.sql, /referente_id=/);
  assert.equal(referenteUpdate.params.includes(32), true);

  for (const [target, body] of [
    [repartidor, { role: 'user', chofer_id: 11 }],
    [referente, { role: 'user', referente_id: 31 }],
  ]) {
    const calls = await runScenario({ actor: admin, target, body, expectedStatus: 400 });
    assert.equal(calls.some(call => call.sql.includes('UPDATE usuarios')), false);
  }

  for (const [target, clearedColumn] of [[repartidor, 'chofer_id'], [referente, 'referente_id']]) {
    const calls = await runScenario({ actor: admin, target, body: { role: 'user' }, expectedStatus: 200 });
    const update = calls.find(call => call.sql.includes('UPDATE usuarios'));
    assert.match(update.sql, new RegExp(`${clearedColumn}=`));
    assert.equal(update.params.includes(null), true);
  }

  const superActor = { uid: 2, role: 'super' };
  const crossTenantMove = await runScenario({
    actor: superActor,
    target: repartidor,
    body: { empresa_id: 4, chofer_id: 11 },
    expectedStatus: 400,
  });
  assert.equal(crossTenantMove.some(call => call.sql.includes('UPDATE usuarios')), false);

  const implicitCrossTenantMove = await runScenario({
    actor: superActor,
    target: repartidor,
    body: { empresa_id: 4 },
    expectedStatus: 400,
  });
  assert.equal(implicitCrossTenantMove.some(call => call.sql.includes('UPDATE usuarios')), false);

  const validTenantMove = await runScenario({
    actor: superActor,
    target: repartidor,
    body: { empresa_id: 4, chofer_id: 44 },
    expectedStatus: 200,
  });
  const moveUpdate = validTenantMove.find(call => call.sql.includes('UPDATE usuarios'));
  assert.match(moveUpdate.sql, /empresa_id IS NOT DISTINCT FROM/);
  assert.equal(moveUpdate.params.includes(4), true);
  assert.equal(moveUpdate.params.includes(44), true);
  assert.equal(moveUpdate.params.at(-1), 3);
});

test('cada operación autoriza con el actor efectivo de DB y rechaza revocación o degradación', async () => {
  for (const actorRow of [
    null,
    { id: 1, role: 'admin', empresa_id: 3, activo: false },
    { id: 1, role: 'user', empresa_id: 3, activo: true },
    { id: 1, role: 'admin', empresa_id: null, activo: true },
    { id: 1, role: ' super ', empresa_id: null, activo: true },
    { id: 1, role: 'SUPER', empresa_id: null, activo: true },
    { id: 1, role: 'desconocido', empresa_id: 3, activo: true },
  ]) {
    for (const operation of usuarioOperations) {
      const txCalls = [];
      let globalCalls = 0;
      const app = buildApp({
        query: async () => { globalCalls += 1; return []; },
        withTransaction: async work => work(async (sql, params) => {
          txCalls.push({ sql, params });
          return actorRow ? [actorRow] : [];
        }, { query: async () => { throw new Error('client.query inesperado'); } }),
      });

      await withServer(app, async baseUrl => {
        const response = await request(
          baseUrl,
          { uid: 1, role: 'super', empresa_id: 999 },
          operation.method,
          operation.path,
          operation.body,
        );
        assert.equal(response.status, 403, `${operation.method}: ${JSON.stringify(actorRow)}`);
      });

      assert.equal(globalCalls, 0);
      assert.equal(txCalls.length, 1);
      assert.match(txCalls[0].sql, /WHERE id=\$1[\s\S]*FOR SHARE/i);
      assert.deepEqual(txCalls[0].params, [1]);
    }
  }
});

test('el tenant actual de DB manda aunque el JWT conserve el tenant anterior', async () => {
  const txCalls = [];
  const app = buildApp({
    query: async () => { throw new Error('no debe usar query global'); },
    withTransaction: async work => work(async (sql, params) => {
      txCalls.push({ sql, params });
      if (/FOR SHARE/i.test(sql)) return [{ id: 10, role: 'admin', empresa_id: 7, activo: true }];
      if (/ORDER BY id ASC/i.test(sql)) return [{ id: 20, empresa_id: 7, role: 'user' }];
      throw new Error(`SQL inesperado: ${sql}`);
    }, { query: async () => { throw new Error('client.query inesperado'); } }),
  });

  await withServer(app, async baseUrl => {
    const response = await request(baseUrl, { uid: 10, role: 'admin', empresa_id: 3 }, 'GET');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id: 20, empresa_id: 7, role: 'user' }]);
  });

  const list = txCalls.find(call => /ORDER BY id ASC/i.test(call.sql));
  assert.deepEqual(list.params, [7]);
});

test('POST bloquea actor y vínculos y escribe por el mismo cliente transaccional', async () => {
  const calls = [];
  let globalCalls = 0;
  const txQuery = async (sql, params) => {
    calls.push({ via: 'tx', sql, params });
    if (/FROM usuarios[\s\S]*FOR SHARE/i.test(sql)) return [{ id: 1, role: 'admin', empresa_id: 3, activo: true }];
    if (/FROM empresas/i.test(sql)) return [{ id: 3 }];
    if (/FROM choferes/i.test(sql)) return [{ id: 11 }];
    if (/INSERT INTO usuarios/i.test(sql)) return [{ id: 90, username: 'nuevo' }];
    throw new Error(`SQL inesperado: ${sql}`);
  };
  const app = buildApp({
    query: async () => { globalCalls += 1; return []; },
    withTransaction: async work => work(txQuery, {
      query: async (sql, params) => ({ rows: await txQuery(sql, params), rowCount: 1 }),
    }),
  });

  await withServer(app, async baseUrl => {
    const response = await request(baseUrl, { uid: 1, role: 'user', empresa_id: 999 }, 'POST', '/api/admin/usuarios', {
      username: 'nuevo', password: 'secreto1', role: 'repartidor', chofer_id: 11,
    });
    assert.equal(response.status, 200);
  });

  assert.equal(globalCalls, 0);
  assert.match(calls[0].sql, /FOR SHARE/i);
  assert.match(calls.find(call => /FROM empresas/i.test(call.sql)).sql, /FOR KEY SHARE/i);
  assert.match(calls.find(call => /FROM choferes/i.test(call.sql)).sql, /activo IS TRUE[\s\S]*FOR SHARE/i);
  assert.ok(calls.some(call => /INSERT INTO usuarios/i.test(call.sql)));
});

test('POST rechaza vínculos inexistentes, inactivos o eliminados sin insertar', async () => {
  for (const field of ['chofer_id', 'referente_id']) {
    const calls = [];
    const app = buildApp({
      withTransaction: async work => work(async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM usuarios[\s\S]*FOR SHARE/i.test(sql)) return [{ id: 1, role: 'admin', empresa_id: 3, activo: true }];
        if (/FROM empresas/i.test(sql)) return [{ id: 3 }];
        if (/FROM (choferes|referentes)/i.test(sql)) return [];
        throw new Error(`SQL inesperado: ${sql}`);
      }, { query: async () => { throw new Error('write inesperado'); } }),
    });
    const role = field === 'chofer_id' ? 'repartidor' : 'referente';
    await withServer(app, async baseUrl => {
      const response = await request(baseUrl, { uid: 1, role: 'admin', empresa_id: 3 }, 'POST', '/api/admin/usuarios', {
        username: 'sin-vinculo', password: 'secreto1', role, [field]: 99,
      });
      assert.equal(response.status, 400);
    });
    const lookup = calls.find(call => /FROM (choferes|referentes)/i.test(call.sql));
    assert.match(lookup.sql, /activo IS TRUE/i);
    assert.match(lookup.sql, /FOR SHARE/i);
    if (field === 'referente_id') assert.match(lookup.sql, /deleted_at IS NULL/i);
    assert.equal(calls.some(call => /INSERT INTO usuarios/i.test(call.sql)), false);
  }
});

test('PUT y DELETE exigen RETURNING id y fallan cerrado cuando rowCount no es uno', async () => {
  for (const method of ['PUT', 'DELETE']) {
    const calls = [];
    const txQuery = async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM usuarios[\s\S]*FOR SHARE/i.test(sql)) return [{ id: 1, role: 'admin', empresa_id: 3, activo: true }];
      if (/FROM usuarios[\s\S]*FOR UPDATE/i.test(sql)) return [{ id: 8, role: 'user', empresa_id: 3, chofer_id: null, referente_id: null }];
      if (/FROM empresas/i.test(sql)) return [{ id: 3 }];
      throw new Error(`SQL inesperado: ${sql}`);
    };
    const app = buildApp({
      withTransaction: async work => work(txQuery, {
        async query(sql, params) {
          calls.push({ sql, params });
          return { rows: [], rowCount: 0 };
        },
      }),
    });
    await withServer(app, async baseUrl => {
      const response = await request(baseUrl, { uid: 1, role: 'admin', empresa_id: 3 }, method, '/api/admin/usuarios/8', method === 'PUT' ? { username: 'cambio' } : undefined);
      assert.equal(response.status, 404);
    });
    const write = calls.find(call => new RegExp(`^${method === 'PUT' ? 'UPDATE' : 'DELETE'}`, 'i').test(call.sql.trim()));
    assert.match(write.sql, /RETURNING id/i);
  }
});

test("activo='false' se rechaza y los errores PG se clasifican por code", async () => {
  const app = buildApp({
    withTransaction: async work => work(async sql => {
      if (/FROM usuarios[\s\S]*FOR SHARE/i.test(sql)) return [{ id: 1, role: 'admin', empresa_id: 3, activo: true }];
      throw new Error(`SQL inesperado: ${sql}`);
    }, { query: async () => { throw new Error('write inesperado'); } }),
  });
  await withServer(app, async baseUrl => {
    const invalid = await request(baseUrl, { uid: 1, role: 'admin', empresa_id: 3 }, 'PUT', '/api/admin/usuarios/8', { activo: 'false' });
    assert.equal(invalid.status, 400);
  });

  for (const [code, expectedStatus] of [['23505', 400], ['23503', 409]]) {
    const failing = buildApp({
      withTransaction: async work => work(async sql => {
        if (/FROM usuarios[\s\S]*FOR SHARE/i.test(sql)) return [{ id: 1, role: 'super', empresa_id: null, activo: true }];
        if (/FROM empresas/i.test(sql)) return [{ id: 3 }];
        throw Object.assign(new Error('mensaje localizado no confiable'), { code });
      }, { query: async () => { throw new Error('write inesperado'); } }),
    });
    await withServer(failing, async baseUrl => {
      const response = await request(baseUrl, { uid: 1, role: 'super' }, 'POST', '/api/admin/usuarios', {
        username: 'duplicado', password: 'secreto1', role: 'user', empresa_id: 3,
      });
      assert.equal(response.status, expectedStatus, code);
    });
  }
});

test('PUT aplica la misma longitud mínima de password que POST', async () => {
  const calls = [];
  const app = buildApp({ query: async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM usuarios[\s\S]*FOR UPDATE/i.test(sql)) {
      return [{ id: 8, role: 'user', empresa_id: 3, chofer_id: null, referente_id: null }];
    }
    if (/FROM empresas/i.test(sql)) return [{ id: 3 }];
    if (/UPDATE usuarios/i.test(sql)) return [];
    throw new Error(`SQL inesperado: ${sql}`);
  } });

  await withServer(app, async baseUrl => {
    const response = await request(baseUrl, { uid: 10, role: 'claim-ignorado' }, 'PUT', '/api/admin/usuarios/8', { password: '12345' });
    assert.equal(response.status, 400);
  });
  assert.equal(calls.some(call => /UPDATE usuarios/i.test(call.sql)), false);
});

test('target con rol DB no canónico no hereda semántica super', async () => {
  const calls = [];
  const app = buildApp({
    withTransaction: async work => work(async (sql, params) => {
      calls.push({ sql, params });
      if (/FOR SHARE/i.test(sql)) return [{ id: 1, role: 'super', empresa_id: null, activo: true }];
      if (/FOR UPDATE/i.test(sql)) return [{ id: 8, role: ' super ', empresa_id: 3, chofer_id: null, referente_id: null }];
      throw new Error(`SQL inesperado: ${sql}`);
    }, { query: async () => { throw new Error('write inesperado'); } }),
  });

  await withServer(app, async baseUrl => {
    const response = await request(baseUrl, { uid: 1, role: 'super' }, 'PUT', '/api/admin/usuarios/8', { username: 'cambio' });
    assert.equal(response.status, 409);
  });
  assert.equal(calls.some(call => /UPDATE usuarios/i.test(call.sql)), false);
});

test('normaliza únicamente input nuevo permitido y guarda el rol canónico', async () => {
  const calls = [];
  const app = buildApp({ query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM empresas')) return [{ id: 3 }];
    if (sql.includes('INSERT INTO usuarios')) return [{ id: 91, username: params[0] }];
    throw new Error(`SQL inesperado: ${sql}`);
  } });

  await withServer(app, async baseUrl => {
    const response = await request(baseUrl, { uid: 10, role: 'claim-ignorado', empresa_id: 999 }, 'POST', '/api/admin/usuarios', {
      username: 'facturacion', password: 'secreto1', role: ' FACTURACION ',
    });
    assert.equal(response.status, 200);
  });
  const insert = calls.find(call => /INSERT INTO usuarios/i.test(call.sql));
  assert.equal(insert.params[2], 'facturacion');
});

test('empresas-list exige super activo exacto en DB y no confía en claims JWT', async () => {
  const scenarios = [
    { name: 'uid inexistente', actor: null },
    { name: 'revocado', actor: { id: 1, role: 'super', activo: false } },
    { name: 'degradado', actor: { id: 1, role: 'admin', empresa_id: 3, activo: true } },
    { name: 'super con espacios', actor: { id: 1, role: ' super ', activo: true } },
    { name: 'super mayúsculas', actor: { id: 1, role: 'SUPER', activo: true } },
  ];

  for (const scenario of scenarios) {
    const calls = [];
    let globalCalls = 0;
    const app = buildApp({
      query: async () => { globalCalls += 1; return []; },
      withTransaction: async work => work(async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM usuarios/i.test(sql)) return scenario.actor ? [scenario.actor] : [];
        throw new Error(`query inesperada: ${sql}`);
      }, { query: async () => { throw new Error('client.query inesperado'); } }),
    });
    await withServer(app, async baseUrl => {
      const response = await request(baseUrl, { uid: 1, role: 'super' }, 'GET', '/api/admin/empresas-list');
      assert.equal(response.status, 403, scenario.name);
    });
    assert.equal(globalCalls, 0, scenario.name);
    assert.equal(calls.length, 1, scenario.name);
  }
});

test('empresas-list bloquea token client antes de consultar DB', async () => {
  let queries = 0;
  const app = buildApp({ query: async () => { queries += 1; return []; } });
  await withServer(app, async baseUrl => {
    const response = await request(baseUrl, { uid: 1, role: 'super', type: 'client' }, 'GET', '/api/admin/empresas-list');
    assert.equal(response.status, 403);
  });
  assert.equal(queries, 0);
});

test('empresas-list consulta actor y empresas por la misma transacción', async () => {
  const txCalls = [];
  let globalCalls = 0;
  const expected = [{ id: 2, nombre: 'Dos' }];
  const app = buildApp({
    query: async () => { globalCalls += 1; return []; },
    withTransaction: async work => work(async (sql, params) => {
      txCalls.push({ sql, params });
      if (/FROM usuarios/i.test(sql)) return [{ id: 7, role: 'super', empresa_id: null, activo: true }];
      if (/FROM empresas/i.test(sql)) return expected;
      throw new Error(`SQL inesperado: ${sql}`);
    }, { query: async () => { throw new Error('client.query inesperado'); } }),
  });

  await withServer(app, async baseUrl => {
    const response = await request(baseUrl, { uid: 7, role: 'user', empresa_id: 999 }, 'GET', '/api/admin/empresas-list');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  });
  assert.equal(globalCalls, 0);
  assert.equal(txCalls.length, 2);
  assert.match(txCalls[0].sql, /WHERE id=\$1[\s\S]*FOR SHARE/i);
  assert.deepEqual(txCalls[0].params, [7]);
  assert.match(txCalls[1].sql, /SELECT id, nombre FROM empresas ORDER BY id ASC/i);
});

test('initDb usa user por defecto, limpia roles históricos inválidos y agrega CHECK fail-closed', () => {
  const allowed = "'user', 'repartidor', 'referente', 'facturacion', 'contable', 'admin', 'super'";
  assert.match(initSql, /role\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'user'/i);
  assert.doesNotMatch(initSql, /role\s+TEXT\s+(?:NOT\s+NULL\s+)?DEFAULT\s+'admin'/i);
  assert.match(initSql, /ALTER\s+TABLE\s+usuarios\s+ALTER\s+COLUMN\s+role\s+SET\s+DEFAULT\s+'user'/i);
  assert.match(initSql, /ALTER\s+TABLE\s+usuarios\s+ALTER\s+COLUMN\s+role\s+SET\s+NOT\s+NULL/i);
  assert.match(initSql, new RegExp(`UPDATE\\s+usuarios\\s+SET\\s+role\\s*=\\s*'user'[\\s\\S]*?role\\s+IS\\s+NULL[\\s\\S]*?role\\s+NOT\\s+IN\\s*\\(\\s*${allowed}\\s*\\)`, 'i'));
  assert.match(initSql, /IF\s+NOT\s+EXISTS[\s\S]*?pg_constraint[\s\S]*?usuarios_role_check/i);
  assert.match(initSql, new RegExp(`CHECK\\s*\\(\\s*role\\s+IS\\s+NOT\\s+NULL\\s+AND\\s+role\\s+IN\\s*\\(\\s*${allowed}\\s*\\)\\s*\\)`, 'i'));
  assert.doesNotMatch(initSql, /UPDATE\s+usuarios\s+SET\s+role\s*=\s*['"]super['"]/i);
});
