import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createTransferenciasRouter } from '../src/routes/transferencias.js';


async function withServer(app, fn) {
  const server = app.listen(0);
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

async function buildApp({ approveManualFn, associateReceiptFn } = {}) {
  const transferDir = await mkdtemp(path.join(tmpdir(), 'pedivoy-transfer-auth-'));
  const calls = [];
  const queryFn = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/ALTER TABLE|CREATE INDEX/i.test(sql)) return [];
    if (sql.includes('FROM empresa_cuentas_bancarias')) return [];
    if (sql.includes('FROM comprobantes_transferencia ct')) return [];
    if (sql.includes('SELECT id, empresa_id, archivo_path FROM comprobantes_transferencia')) return [];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  const checkLicenciaFn = (req, res, next) => {
    if (req.headers['x-test-license'] !== 'active') {
      return res.status(403).json({ error: 'licencia_inactiva' });
    }
    return next();
  };
  const withAuthFn = (req, res, next) => {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    try {
      req.user = JSON.parse(Buffer.from(header.slice(7), 'base64url').toString('utf8'));
      return next();
    } catch {
      return res.status(401).json({ error: 'Token inválido' });
    }
  };

  const app = express();
  app.use(express.json());
  app.use('/api/transferencias', createTransferenciasRouter({
    TRANSF_DIR: transferDir,
    queryFn,
    withAuthFn,
    checkLicenciaFn,
    approveManualFn,
    associateReceiptFn,
  }));
  return {
    app,
    calls,
    cleanup: () => rm(transferDir, { recursive: true, force: true }),
  };
}

const financialOperations = [
  { method: 'GET', path: '/api/transferencias/cuentas-bancarias' },
  { method: 'GET', path: '/api/transferencias' },
  { method: 'GET', path: '/api/transferencias/sin-comprobante' },
  { method: 'POST', path: '/api/transferencias/pedidos/1/solicitar-comprobante' },
  { method: 'GET', path: '/api/transferencias/resumen' },
  { method: 'GET', path: '/api/transferencias/export.csv' },
  { method: 'POST', path: '/api/transferencias/upload' },
  { method: 'POST', path: '/api/transferencias/1/verificar' },
  { method: 'POST', path: '/api/transferencias/1/asociar-pedido' },
  { method: 'DELETE', path: '/api/transferencias/1' },
];

function businessCalls(calls) {
  return calls.filter(call => !/ALTER TABLE|CREATE INDEX/i.test(call.sql));
}

test('todas las operaciones financieras exigen token antes de consultar datos', async () => {
  const { app, calls, cleanup } = await buildApp();
  try {
    await withServer(app, async baseUrl => {
      for (const operation of financialOperations) {
        const response = await fetch(`${baseUrl}${operation.path}`, { method: operation.method });
        assert.equal(response.status, 401, `${operation.method} ${operation.path}`);
      }
    });
    assert.equal(businessCalls(calls).length, 0);
  } finally {
    await cleanup();
  }
});

test('todas las operaciones financieras exigen licencia antes de consultar datos', async () => {
  const { app, calls, cleanup } = await buildApp();
  try {
    const authorization = `Bearer ${tokenFor({ uid: 10, role: 'admin', empresa_id: 3 })}`;
    await withServer(app, async baseUrl => {
      for (const operation of financialOperations) {
        const response = await fetch(`${baseUrl}${operation.path}`, {
          method: operation.method,
          headers: { authorization },
        });
        assert.equal(response.status, 403, `${operation.method} ${operation.path}`);
      }
    });
    assert.equal(businessCalls(calls).length, 0);
  } finally {
    await cleanup();
  }
});

test('todas las operaciones financieras bloquean clientes, repartidores y otros roles sin tocar datos', async () => {
  const blockedUsers = [
    { uid: 1, role: 'admin', type: 'client', empresa_id: 3 },
    { uid: 2, role: 'admin', type: 'repartidor', empresa_id: 3 },
    { uid: 3, role: 'admin', type: 'unknown', empresa_id: 3 },
    { uid: 4, role: 'repartidor', empresa_id: 3 },
    { uid: 5, role: 'user', type: 'user', empresa_id: 3 },
  ];

  for (const user of blockedUsers) {
    const { app, calls, cleanup } = await buildApp();
    try {
      const authorization = `Bearer ${tokenFor(user)}`;
      await withServer(app, async baseUrl => {
        for (const operation of financialOperations) {
          const response = await fetch(`${baseUrl}${operation.path}`, {
            method: operation.method,
            headers: { authorization, 'x-test-license': 'active' },
          });
          assert.equal(response.status, 403, `${user.type || user.role}: ${operation.method} ${operation.path}`);
        }
      });
      assert.equal(businessCalls(calls).length, 0);
    } finally {
      await cleanup();
    }
  }
});

test('admin legacy, admin type=user y super atraviesan la política uniforme', async () => {
  const allowedUsers = [
    { uid: 10, role: 'admin', empresa_id: 3 },
    { uid: 11, role: 'admin', type: 'user', empresa_id: 3 },
    { uid: 12, role: 'super' },
  ];

  for (const user of allowedUsers) {
    const { app, calls, cleanup } = await buildApp();
    try {
      const headers = {
        authorization: `Bearer ${tokenFor(user)}`,
        'x-test-license': 'active',
      };
      await withServer(app, async baseUrl => {
        for (const operation of financialOperations.slice(0, 2)) {
          const response = await fetch(`${baseUrl}${operation.path}`, { method: operation.method, headers });
          assert.equal(response.status, 200, `${user.role}: ${operation.method} ${operation.path}`);
        }
        const upload = await fetch(`${baseUrl}/api/transferencias/upload`, { method: 'POST', headers });
        assert.equal(upload.status, 400);
        const deletion = await fetch(`${baseUrl}/api/transferencias/1`, { method: 'DELETE', headers });
        assert.equal(deletion.status, 404);
      });
      assert.ok(businessCalls(calls).length >= 3);
    } finally {
      await cleanup();
    }
  }
});

test('cuentas y listado mantienen tenant admin, permiten tenant explícito solo a super y exponen empresa_id', async () => {
  const { app, calls, cleanup } = await buildApp();
  try {
    await withServer(app, async baseUrl => {
      const adminHeaders = {
        authorization: `Bearer ${tokenFor({ uid: 10, role: 'admin', empresa_id: 3 })}`,
        'x-test-license': 'active',
      };
      const superHeaders = {
        authorization: `Bearer ${tokenFor({ uid: 12, role: 'super' })}`,
        'x-test-license': 'active',
      };
      assert.equal((await fetch(`${baseUrl}/api/transferencias/cuentas-bancarias?empresa_id=99`, { headers: adminHeaders })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/transferencias/cuentas-bancarias?empresa_id=7`, { headers: superHeaders })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/transferencias`, { headers: superHeaders })).status, 200);
    });

    const accountCalls = businessCalls(calls).filter(call => call.sql.includes('FROM empresa_cuentas_bancarias'));
    assert.deepEqual(accountCalls[0].params, [3]);
    assert.deepEqual(accountCalls[1].params, [7]);
    const listCall = businessCalls(calls).find(call => call.sql.includes('FROM comprobantes_transferencia ct'));
    assert.match(listCall.sql, /ct\.empresa_id/);
  } finally {
    await cleanup();
  }
});

test('verificación usa empresa del token para admin y empresa enviada por super', async () => {
  const approvals = [];
  const { app, cleanup } = await buildApp({
    approveManualFn: async payload => {
      approvals.push(payload);
      return { id: payload.id, monto: 100, telefono: null };
    },
  });
  try {
    await withServer(app, async baseUrl => {
      const cases = [
        {
          user: { uid: 10, role: 'admin', empresa_id: 3 },
          body: { empresa_id: 99, nro_operacion: 'OP-A', cuenta_bancaria_id: 1, reason: 'admin' },
        },
        {
          user: { uid: 12, role: 'super' },
          body: { empresa_id: 7, nro_operacion: 'OP-S', cuenta_bancaria_id: 2, reason: 'super' },
        },
      ];
      for (const scenario of cases) {
        const response = await fetch(`${baseUrl}/api/transferencias/1/verificar`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokenFor(scenario.user)}`,
            'x-test-license': 'active',
            'content-type': 'application/json',
          },
          body: JSON.stringify(scenario.body),
        });
        assert.equal(response.status, 200);
      }
    });
    assert.deepEqual(approvals.map(call => call.empresaId), [3, 7]);
  } finally {
    await cleanup();
  }
});

test('asociación no confía en empresa enviada y delega adopción solo al super exacto', async () => {
  const associations = [];
  const { app, cleanup } = await buildApp({
    associateReceiptFn: async payload => {
      associations.push(payload);
      return { id: payload.id, empresa_id: 7, pedido_id: payload.pedidoId };
    },
  });
  try {
    await withServer(app, async baseUrl => {
      for (const user of [
        { uid: 10, role: 'admin', empresa_id: 3 },
        { uid: 12, role: 'super', empresa_id: null },
      ]) {
        const response = await fetch(`${baseUrl}/api/transferencias/1/asociar-pedido`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokenFor(user)}`,
            'x-test-license': 'active',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ pedido_id: 99, empresa_id: 666, reason: 'revisión' }),
        });
        assert.equal(response.status, 200);
      }
    });
    assert.deepEqual(associations.map(call => ({
      actorRole: call.actorRole,
      actorEmpresaId: call.actorEmpresaId,
      pedidoId: call.pedidoId,
      hasEmpresaId: Object.hasOwn(call, 'empresaId'),
    })), [
      { actorRole: 'admin', actorEmpresaId: 3, pedidoId: 99, hasEmpresaId: false },
      { actorRole: 'super', actorEmpresaId: null, pedidoId: 99, hasEmpresaId: false },
    ]);
  } finally {
    await cleanup();
  }
});
