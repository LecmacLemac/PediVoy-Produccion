import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createReferentesRouter } from '../src/routes/referentes.js';
import { withTransaction as dbWithTransaction } from '../src/db.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function createFixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (id integer PRIMARY KEY);
    CREATE TABLE referentes (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      nombre text NOT NULL,
      codigo text NOT NULL,
      porcentaje_comision numeric(5,2) NOT NULL DEFAULT 0,
      vigente_desde date,
      vigente_hasta date,
      activo boolean NOT NULL DEFAULT true,
      notas text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE TABLE productos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      nombre text NOT NULL,
      activo boolean NOT NULL DEFAULT true,
      deleted_at timestamptz
    );
    CREATE TABLE referente_productos (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      referente_id integer NOT NULL REFERENCES referentes(id),
      producto_id integer NOT NULL REFERENCES productos(id),
      porcentaje_comision numeric(5,2),
      vigente_desde date,
      vigente_hasta date,
      activo boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (referente_id, producto_id)
    );
    INSERT INTO empresas VALUES (10), (20);
    INSERT INTO referentes (id, empresa_id, nombre, codigo) VALUES
      (101, 10, 'Referente local', 'LOCAL'),
      (999, 20, 'Referente ajeno', 'AJENO'),
      (102, 10, 'Referente inactivo', 'INACTIVO');
    UPDATE referentes SET activo = false WHERE id = 102;
    INSERT INTO productos (id, empresa_id, nombre, activo) VALUES
      (201, 10, 'Producto local A', true),
      (202, 10, 'Producto local B', true),
      (203, 10, 'Producto local inactivo', false),
      (888, 20, 'Producto ajeno', true);
  `);
}

function buildApp(pool, {
  user = { uid: 10, role: 'admin', empresa_id: 10 },
  withTransaction,
} = {}) {
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const runTransaction = withTransaction || (work => dbWithTransaction(work, {
    pool,
    maxRetries: 0,
    retryDelayMs: 0,
  }));
  const app = express();
  app.use(express.json());
  app.use('/api/referentes', createReferentesRouter({
    query,
    withTransaction: runTransaction,
    withAuth(req, _res, next) { req.user = user; next(); },
    isSuper(req) { return req.user?.role === 'super'; },
    getEmpresaIdFromToken(req) { return req.user?.empresa_id; },
  }));
  return app;
}

async function postProductos(base, referenteId, productos, extra = {}) {
  const response = await fetch(`${base}/api/referentes/${referenteId}/productos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productos, ...extra }),
  });
  return { status: response.status, body: await response.json() };
}

async function relationState(pool) {
  const { rows } = await pool.query(`
    SELECT id, empresa_id, referente_id, producto_id,
           porcentaje_comision::text, vigente_desde::text, vigente_hasta::text,
           activo, created_at::text
      FROM referente_productos
     ORDER BY id
  `);
  return rows;
}

async function localProductIds(pool) {
  const { rows } = await pool.query(`
    SELECT producto_id
      FROM referente_productos
     WHERE empresa_id = 10 AND referente_id = 101
     ORDER BY producto_id
  `);
  return rows.map(row => Number(row.producto_id));
}

test('PostgreSQL real: asignación referente-producto queda cerrada por tenant y es atómica', postgresOptions, async t => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);

    await t.test('reproducción exacta: admin empresa 10 no toma ni altera relación empresa 20', async () => {
      await pool.query(`
        INSERT INTO referente_productos
          (empresa_id, referente_id, producto_id, porcentaje_comision, vigente_desde, vigente_hasta, activo)
        VALUES (20, 999, 888, 5, DATE '2026-09-01', DATE '2026-12-31', true)
      `);
      const before = await relationState(pool);
      await withServer(buildApp(pool), async base => {
        const result = await postProductos(base, 999, [{ producto_id: 888, porcentaje_comision: 77, activo: true }]);
        assert.equal(result.status, 404);
      });
      assert.deepEqual(await relationState(pool), before);
      await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
    });

    await t.test('conflicto global corrupto con IDs locales falla cerrado sin takeover', async () => {
      await pool.query(`INSERT INTO referente_productos
        (empresa_id, referente_id, producto_id, porcentaje_comision, activo)
        VALUES (20, 101, 201, 5, true)`);
      const before = await relationState(pool);
      await withServer(buildApp(pool), async base => {
        const result = await postProductos(base, 101, [{ producto_id: 201, porcentaje_comision: 77 }]);
        assert.equal(result.status, 409, JSON.stringify(result));
      });
      assert.deepEqual(await relationState(pool), before);
      await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
    });

    const rejectionCases = [
      ['referente local + producto ajeno', 101, [{ producto_id: 888 }], 404],
      ['referente ajeno + producto local', 999, [{ producto_id: 201 }], 404],
      ['mezcla local y ajeno', 101, [{ producto_id: 201 }, { producto_id: 888 }], 404],
      ['producto inexistente', 101, [{ producto_id: 777 }], 404],
      ['producto inactivo', 101, [{ producto_id: 203 }], 404],
      ['referente inactivo', 102, [{ producto_id: 201 }], 404],
      ['IDs duplicados', 101, [{ producto_id: 201 }, { producto_id: 201 }], 409],
    ];
    for (const [name, referenteId, productos, status] of rejectionCases) {
      await t.test(`${name}: rechaza sin tocar el conjunto anterior`, async () => {
        await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
        await pool.query(`INSERT INTO referente_productos
          (empresa_id, referente_id, producto_id, porcentaje_comision, activo)
          VALUES (10, 101, 202, 9, true)`);
        const before = await relationState(pool);
        await withServer(buildApp(pool), async base => {
          const result = await postProductos(base, referenteId, productos);
          assert.equal(result.status, status, JSON.stringify(result));
        });
        assert.deepEqual(await relationState(pool), before);
      });
    }

    const malformedIds = ['201', true, 201.5, 0, -1, Number.MAX_SAFE_INTEGER + 1, null];
    for (const malformed of malformedIds) {
      await t.test(`producto_id malformado ${String(malformed)} no muta`, async () => {
        await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
        await pool.query(`INSERT INTO referente_productos
          (empresa_id, referente_id, producto_id, porcentaje_comision, activo)
          VALUES (10, 101, 202, 9, true)`);
        const before = await relationState(pool);
        await withServer(buildApp(pool), async base => {
          const result = await postProductos(base, 101, [{ producto_id: malformed }]);
          assert.equal(result.status, 400, JSON.stringify(result));
        });
        assert.deepEqual(await relationState(pool), before);
      });
    }

    for (const [name, patch] of [
      ['fecha inválida', { vigente_desde: 'no-es-fecha' }],
      ['fecha con tipo inválido', { vigente_hasta: true }],
      ['activo con tipo inválido', { activo: 'true' }],
      ['porcentaje inválido', { porcentaje_comision: 101 }],
    ]) {
      await t.test(`${name} no muta`, async () => {
        await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
        await pool.query(`INSERT INTO referente_productos
          (empresa_id, referente_id, producto_id, porcentaje_comision, activo)
          VALUES (10, 101, 202, 9, true)`);
        const before = await relationState(pool);
        await withServer(buildApp(pool), async base => {
          const result = await postProductos(base, 101, [{ producto_id: 201, ...patch }]);
          assert.equal(result.status, 400, JSON.stringify(result));
        });
        assert.deepEqual(await relationState(pool), before);
      });
    }

    for (const malformedReferente of ['101.5', 'true', '9007199254740992']) {
      await t.test(`referente id malformado ${malformedReferente} no muta`, async () => {
        await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
        await pool.query(`INSERT INTO referente_productos
          (empresa_id, referente_id, producto_id, porcentaje_comision, activo)
          VALUES (10, 101, 202, 9, true)`);
        const before = await relationState(pool);
        await withServer(buildApp(pool), async base => {
          const result = await postProductos(base, malformedReferente, [{ producto_id: 201 }]);
          assert.equal(result.status, 400, JSON.stringify(result));
        });
        assert.deepEqual(await relationState(pool), before);
      });
    }

    for (const malformedEmpresa of ['10', true, 10.5]) {
      await t.test(`super exige selector empresa numérico exacto: ${String(malformedEmpresa)}`, async () => {
        await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
        await withServer(buildApp(pool, {
          user: { uid: 1, role: 'super', empresa_id: null },
        }), async base => {
          const result = await postProductos(base, 101, [{ producto_id: 201 }], { empresa_id: malformedEmpresa });
          assert.equal(result.status, 400, JSON.stringify(result));
        });
        assert.deepEqual(await localProductIds(pool), []);
      });
    }

    await t.test('camino válido reemplaza el conjunto completo', async () => {
      await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
      await pool.query(`INSERT INTO referente_productos
        (empresa_id, referente_id, producto_id, porcentaje_comision, activo)
        VALUES (10, 101, 203, 4, false)`);
      await withServer(buildApp(pool), async base => {
        const result = await postProductos(base, 101, [
          { producto_id: 202, porcentaje_comision: 12.5, vigente_desde: '2026-10-01', activo: true },
          { producto_id: 201, porcentaje_comision: null, vigente_hasta: '2026-12-31', activo: true },
        ]);
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.deepEqual(result.body, { ok: true });
      });
      assert.deepEqual(await localProductIds(pool), [201, 202]);
    });

    await t.test('fallo al insertar el item N revierte DELETE e inserts previos', async () => {
      await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
      await pool.query(`INSERT INTO referente_productos
        (empresa_id, referente_id, producto_id, porcentaje_comision, activo)
        VALUES (10, 101, 203, 4, false)`);
      const before = await relationState(pool);
      const failingTransaction = work => dbWithTransaction(async txQuery => {
        let inserts = 0;
        return work(async (sql, params = []) => {
          if (sql.includes('INSERT INTO referente_productos') && ++inserts === 2) {
            throw new Error('fallo inyectado item N');
          }
          return txQuery(sql, params);
        });
      }, { pool, maxRetries: 0, retryDelayMs: 0 });
      await withServer(buildApp(pool, { withTransaction: failingTransaction }), async base => {
        const result = await postProductos(base, 101, [{ producto_id: 201 }, { producto_id: 202 }]);
        assert.equal(result.status, 500);
      });
      assert.deepEqual(await relationState(pool), before);
    });

    await t.test('dos reemplazos concurrentes terminan con un conjunto íntegro, nunca mezclado', async () => {
      await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
      await withServer(buildApp(pool), async base => {
        const [a, b] = await Promise.all([
          postProductos(base, 101, [{ producto_id: 201 }]),
          postProductos(base, 101, [{ producto_id: 202 }]),
        ]);
        assert.equal(a.status, 200, JSON.stringify(a));
        assert.equal(b.status, 200, JSON.stringify(b));
      });
      const finalIds = await localProductIds(pool);
      assert.ok(
        JSON.stringify(finalIds) === JSON.stringify([201])
          || JSON.stringify(finalIds) === JSON.stringify([202]),
        JSON.stringify(finalIds),
      );
    });

    for (const [name, mutation] of [
      ['referente', 'UPDATE referentes SET activo = false WHERE id = 101'],
      ['producto', 'UPDATE productos SET activo = false WHERE id = 201'],
    ]) {
      await t.test(`reasignación espera toggle concurrente de ${name} y falla sin relación parcial`, async () => {
        await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
        await pool.query('UPDATE referentes SET activo = true WHERE id = 101');
        await pool.query('UPDATE productos SET activo = true WHERE id = 201');
        const blocker = await pool.connect();
        let committed = false;
        await blocker.query('BEGIN');
        await blocker.query(mutation);
        try {
          await withServer(buildApp(pool), async base => {
            const pending = postProductos(base, 101, [{ producto_id: 201 }]);
            await new Promise(resolve => setTimeout(resolve, 40));
            await blocker.query('COMMIT');
            committed = true;
            const result = await pending;
            assert.equal(result.status, 404, JSON.stringify(result));
          });
        } finally {
          if (!committed) {
            try { await blocker.query('ROLLBACK'); } catch {}
          }
          blocker.release();
        }
        assert.deepEqual(await localProductIds(pool), []);
      });
    }

    await t.test('COMMIT ambiguo responde 503 sanitizado, no reintenta y conserva resultado durable posible', async () => {
      await pool.query('TRUNCATE referente_productos RESTART IDENTITY');
      await pool.query('UPDATE referentes SET activo = true WHERE id = 101');
      await pool.query('UPDATE productos SET activo = true WHERE id = 201');
      let calls = 0;
      const commitAppliedUnknown = async work => {
        calls += 1;
        await dbWithTransaction(work, { pool, maxRetries: 0, retryDelayMs: 0 });
        const error = new Error('socket privado tras COMMIT');
        error.code = 'TRANSACTION_OUTCOME_UNKNOWN';
        throw error;
      };
      await withServer(buildApp(pool, { withTransaction: commitAppliedUnknown }), async base => {
        const result = await postProductos(base, 101, [{ producto_id: 201 }]);
        assert.equal(result.status, 503);
        assert.deepEqual(result.body, {
          error: 'Resultado de asignación de productos indeterminado',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
        assert.doesNotMatch(JSON.stringify(result.body), /socket|privado/i);
      });
      assert.equal(calls, 1);
      assert.deepEqual(await localProductIds(pool), [201]);
    });
  });
});
