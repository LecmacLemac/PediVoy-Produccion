// src/routes/retornables.js
import express from 'express';
import {
  withAuth as defaultWithAuth,
  checkLicencia as defaultCheckLicencia,
  isSuper as defaultIsSuper,
  getEmpresaIdFromToken as defaultGetEmpresaIdFromToken
} from '../services.js';
import { query as defaultQuery, pool as defaultPool } from '../db.js';
import {
  ensureRetornablesLedgerSchema,
  normalizeRetornableSujetoTipo,
  registrarRetornableMovimiento,
} from '../services/retornablesLedger.js';

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(value, max = 240) {
  return String(value || '').trim().slice(0, max);
}

function normalizeLimit(value, fallback = 50, max = 500) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function createRetornablesRouter({
  query: queryFn = defaultQuery,
  pool: dbPool = defaultPool,
  withAuth: withAuthFn = defaultWithAuth,
  checkLicencia: checkLicenciaFn = defaultCheckLicencia,
  isSuper: isSuperFn = defaultIsSuper,
  getEmpresaIdFromToken: getEmpresaIdFromTokenFn = defaultGetEmpresaIdFromToken,
} = {}) {
  const router = express.Router();
  const dbQuery = queryFn;
  const authMiddleware = withAuthFn;
  const licenciaMiddleware = checkLicenciaFn;

  const ensureSchemaPromise = (async () => {
    try {
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS cliente_retornables_saldos (
          empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
          punto_entrega_id INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
          producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
          saldo NUMERIC(12,2) NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (empresa_id, punto_entrega_id, producto_id)
        )
      `);
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS cliente_retornables_movimientos (
          id SERIAL PRIMARY KEY,
          empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
          punto_entrega_id INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
          pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
          chofer_id INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
          producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
          entregados NUMERIC(12,2) NOT NULL DEFAULT 0,
          devueltos NUMERIC(12,2) NOT NULL DEFAULT 0,
          delta NUMERIC(12,2) NOT NULL DEFAULT 0,
          saldo_resultante NUMERIC(12,2),
          observacion TEXT,
          fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cliente_retornables_saldos_empresa ON cliente_retornables_saldos (empresa_id, producto_id, saldo)`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cliente_retornables_mov_cliente ON cliente_retornables_movimientos (empresa_id, punto_entrega_id, producto_id, fecha DESC)`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cliente_retornables_mov_chofer ON cliente_retornables_movimientos (empresa_id, chofer_id, fecha DESC)`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_cliente_retornables_mov_pedido ON cliente_retornables_movimientos (pedido_id)`);
      await ensureRetornablesLedgerSchema(dbQuery);
    } catch (e) {
      console.error('retornables/schema warning:', e?.message || e);
    }
  })();

  function resolveEmpresaId(req) {
    const esSuperUser = isSuperFn(req);
    return esSuperUser && req.query?.empresa_id
      ? Number(req.query.empresa_id)
      : Number(getEmpresaIdFromTokenFn(req));
  }

  async function withTransaction(fn) {
    if (!dbPool?.connect) {
      return fn(async (sql, params = []) => dbQuery(sql, params));
    }

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      const txQuery = async (sql, params = []) => {
        const result = await client.query(sql, params);
        return result.rows;
      };
      const result = await fn(txQuery);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  router.get('/saldos', authMiddleware, licenciaMiddleware, async (req, res) => {
    try {
      await ensureSchemaPromise;
      const empresaId = resolveEmpresaId(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const sujetoTipo = normalizeRetornableSujetoTipo(req.query?.sujeto_tipo || req.query?.tipo_sujeto || 'cliente');
      if (!sujetoTipo) return res.status(400).json({ error: 'sujeto_tipo inválido' });
      const sujetoId = toNumber(req.query?.sujeto_id, null);
      const productoId = toNumber(req.query?.producto_id, null);
      const q = cleanText(req.query?.q, 120).toLowerCase();
      const saldo = String(req.query?.saldo || 'pendientes').toLowerCase();
      const limit = normalizeLimit(req.query?.limit, 100, 500);

      const rows = await dbQuery(
        `
        WITH ultimo_mov AS (
          SELECT DISTINCT ON (empresa_id, sujeto_tipo, sujeto_id, producto_id)
                 empresa_id, sujeto_tipo, sujeto_id, producto_id, fecha, tipo, observacion, referencia
            FROM retornables_movimientos
           WHERE empresa_id = $1
             AND sujeto_tipo = $2
           ORDER BY empresa_id, sujeto_tipo, sujeto_id, producto_id, fecha DESC, id DESC
        )
        SELECT
          s.empresa_id,
          s.sujeto_tipo,
          s.sujeto_id,
          CASE s.sujeto_tipo
            WHEN 'cliente' THEN COALESCE(pe.cliente, pe.nombre, 'Cliente #' || s.sujeto_id::text)
            WHEN 'chofer' THEN COALESCE(ch.nombre, ch.username, 'Chofer #' || s.sujeto_id::text)
            WHEN 'proveedor' THEN COALESCE(prv.nombre, 'Proveedor #' || s.sujeto_id::text)
            WHEN 'deposito' THEN COALESCE(dep.nombre, 'Depósito #' || s.sujeto_id::text)
            ELSE s.sujeto_tipo || ' #' || s.sujeto_id::text
          END AS sujeto_nombre,
          COALESCE(pe.direccion_completa, pe.direccion, dep.direccion, '') AS sujeto_detalle,
          s.producto_id,
          COALESCE(p.nombre, 'Producto #' || s.producto_id::text) AS producto,
          s.saldo,
          s.updated_at,
          um.fecha AS ultimo_movimiento_at,
          um.tipo AS ultimo_tipo,
          um.observacion AS ultimo_movimiento,
          um.referencia AS ultimo_referencia,
          CASE WHEN s.saldo > 0 THEN 'pendiente' WHEN s.saldo < 0 THEN 'a_favor' ELSE 'ok' END AS estado
        FROM retornables_saldos s
        LEFT JOIN puntos_entrega pe ON s.sujeto_tipo = 'cliente' AND pe.id = s.sujeto_id AND pe.empresa_id = s.empresa_id
        LEFT JOIN choferes ch ON s.sujeto_tipo = 'chofer' AND ch.id = s.sujeto_id AND ch.empresa_id = s.empresa_id
        LEFT JOIN proveedores prv ON s.sujeto_tipo = 'proveedor' AND prv.id = s.sujeto_id AND prv.empresa_id = s.empresa_id
        LEFT JOIN depositos dep ON s.sujeto_tipo = 'deposito' AND dep.id = s.sujeto_id AND dep.empresa_id = s.empresa_id
        LEFT JOIN productos p ON p.id = s.producto_id AND p.empresa_id = s.empresa_id
        LEFT JOIN ultimo_mov um ON um.empresa_id = s.empresa_id AND um.sujeto_tipo = s.sujeto_tipo AND um.sujeto_id = s.sujeto_id AND um.producto_id = s.producto_id
        WHERE s.empresa_id = $1
          AND s.sujeto_tipo = $2
          AND ($3::int IS NULL OR s.sujeto_id = $3)
          AND ($4::int IS NULL OR s.producto_id = $4)
          AND ($5::text IS NULL OR LOWER(COALESCE(pe.cliente, pe.nombre, ch.nombre, ch.username, prv.nombre, dep.nombre, '') || ' ' || COALESCE(pe.direccion_completa, pe.direccion, dep.direccion, '') || ' ' || COALESCE(p.nombre, '')) LIKE '%' || $5 || '%')
          AND (
            $6::text = 'todos'
            OR ($6::text = 'pendientes' AND s.saldo <> 0)
            OR ($6::text = 'deuda' AND s.saldo > 0)
            OR ($6::text = 'favor' AND s.saldo < 0)
            OR ($6::text = 'ok' AND s.saldo = 0)
          )
        ORDER BY ABS(s.saldo) DESC, s.updated_at DESC
        LIMIT $7
        `,
        [empresaId, sujetoTipo, sujetoId, productoId, q || null, saldo, limit]
      );

      const kpiRows = await dbQuery(
        `
        SELECT
          COALESCE(SUM(CASE WHEN saldo > 0 THEN saldo ELSE 0 END), 0) AS total_pendiente,
          COALESCE(SUM(CASE WHEN saldo < 0 THEN ABS(saldo) ELSE 0 END), 0) AS total_a_favor,
          COUNT(*) FILTER (WHERE saldo <> 0) AS cuentas_con_saldo,
          COUNT(*) FILTER (WHERE saldo > 0) AS sujetos_deudores,
          COUNT(DISTINCT producto_id) FILTER (WHERE saldo <> 0) AS productos_con_saldo
        FROM retornables_saldos
        WHERE empresa_id = $1
          AND sujeto_tipo = $2
          AND ($3::int IS NULL OR sujeto_id = $3)
          AND ($4::int IS NULL OR producto_id = $4)
        `,
        [empresaId, sujetoTipo, sujetoId, productoId]
      );

      return res.json({
        ok: true,
        sujeto_tipo: sujetoTipo,
        kpis: {
          total_pendiente: Number(kpiRows?.[0]?.total_pendiente || 0),
          total_a_favor: Number(kpiRows?.[0]?.total_a_favor || 0),
          cuentas_con_saldo: Number(kpiRows?.[0]?.cuentas_con_saldo || 0),
          sujetos_deudores: Number(kpiRows?.[0]?.sujetos_deudores || 0),
          productos_con_saldo: Number(kpiRows?.[0]?.productos_con_saldo || 0),
        },
        rows: (rows || []).map((r) => ({ ...r, saldo: Number(r.saldo || 0) })),
      });
    } catch (e) {
      console.error('GET /api/retornables/saldos', e);
      return res.status(500).json({ error: 'Error cargando saldos de retornables' });
    }
  });

  router.get('/resumen', authMiddleware, licenciaMiddleware, async (req, res) => {
    try {
      await ensureSchemaPromise;
      const empresaId = resolveEmpresaId(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const productoId = toNumber(req.query?.producto_id, null);
      const puntoEntregaId = toNumber(req.query?.punto_entrega_id, null);
      const choferId = toNumber(req.query?.chofer_id, null);
      const q = cleanText(req.query?.q, 120).toLowerCase();
      const saldo = String(req.query?.saldo || 'pendientes').toLowerCase();
      const limit = normalizeLimit(req.query?.limit, 100, 500);

      const params = [empresaId, productoId, puntoEntregaId, choferId, q || null, saldo, limit];
      const rows = await dbQuery(
        `
        WITH ultimo_mov AS (
          SELECT DISTINCT ON (empresa_id, punto_entrega_id, producto_id)
                 empresa_id, punto_entrega_id, producto_id, fecha, chofer_id, observacion
            FROM cliente_retornables_movimientos
           WHERE empresa_id = $1
           ORDER BY empresa_id, punto_entrega_id, producto_id, fecha DESC, id DESC
        )
        SELECT
          s.empresa_id,
          s.punto_entrega_id,
          COALESCE(pe.cliente, pe.nombre, 'Cliente #' || s.punto_entrega_id::text) AS cliente,
          COALESCE(pe.direccion_completa, pe.direccion, '') AS direccion,
          s.producto_id,
          COALESCE(p.nombre, 'Producto #' || s.producto_id::text) AS producto,
          s.saldo,
          s.updated_at,
          um.fecha AS ultimo_movimiento_at,
          um.chofer_id AS ultimo_chofer_id,
          ch.nombre AS ultimo_chofer,
          um.observacion AS ultimo_movimiento,
          CASE
            WHEN s.saldo > 0 THEN 'pendiente'
            WHEN s.saldo < 0 THEN 'a_favor_cliente'
            ELSE 'ok'
          END AS estado
        FROM cliente_retornables_saldos s
        LEFT JOIN puntos_entrega pe ON pe.id = s.punto_entrega_id AND pe.empresa_id = s.empresa_id
        LEFT JOIN productos p ON p.id = s.producto_id AND p.empresa_id = s.empresa_id
        LEFT JOIN ultimo_mov um ON um.empresa_id = s.empresa_id AND um.punto_entrega_id = s.punto_entrega_id AND um.producto_id = s.producto_id
        LEFT JOIN choferes ch ON ch.id = um.chofer_id AND ch.empresa_id = s.empresa_id
        WHERE s.empresa_id = $1
          AND ($2::int IS NULL OR s.producto_id = $2)
          AND ($3::int IS NULL OR s.punto_entrega_id = $3)
          AND ($4::int IS NULL OR um.chofer_id = $4)
          AND ($5::text IS NULL OR LOWER(COALESCE(pe.cliente, pe.nombre, '') || ' ' || COALESCE(pe.direccion_completa, pe.direccion, '') || ' ' || COALESCE(p.nombre, '')) LIKE '%' || $5 || '%')
          AND (
            $6::text = 'todos'
            OR ($6::text = 'pendientes' AND s.saldo <> 0)
            OR ($6::text = 'deuda' AND s.saldo > 0)
            OR ($6::text = 'favor' AND s.saldo < 0)
            OR ($6::text = 'ok' AND s.saldo = 0)
          )
        ORDER BY ABS(s.saldo) DESC, s.updated_at DESC
        LIMIT $7
        `,
        params
      );

      const kpiRows = await dbQuery(
        `
        SELECT
          COALESCE(SUM(CASE WHEN saldo > 0 THEN saldo ELSE 0 END), 0) AS total_pendiente,
          COALESCE(SUM(CASE WHEN saldo < 0 THEN ABS(saldo) ELSE 0 END), 0) AS total_a_favor,
          COUNT(*) FILTER (WHERE saldo <> 0) AS cuentas_con_saldo,
          COUNT(*) FILTER (WHERE saldo > 0) AS clientes_deudores,
          COUNT(DISTINCT producto_id) FILTER (WHERE saldo <> 0) AS productos_con_saldo
        FROM cliente_retornables_saldos
        WHERE empresa_id = $1
          AND ($2::int IS NULL OR producto_id = $2)
          AND ($3::int IS NULL OR punto_entrega_id = $3)
        `,
        [empresaId, productoId, puntoEntregaId]
      );

      return res.json({
        ok: true,
        kpis: {
          total_pendiente: Number(kpiRows?.[0]?.total_pendiente || 0),
          total_a_favor: Number(kpiRows?.[0]?.total_a_favor || 0),
          cuentas_con_saldo: Number(kpiRows?.[0]?.cuentas_con_saldo || 0),
          clientes_deudores: Number(kpiRows?.[0]?.clientes_deudores || 0),
          productos_con_saldo: Number(kpiRows?.[0]?.productos_con_saldo || 0),
        },
        rows: (rows || []).map((r) => ({
          ...r,
          saldo: Number(r.saldo || 0),
        })),
      });
    } catch (e) {
      console.error('GET /api/retornables/resumen', e);
      return res.status(500).json({ error: 'Error cargando cuenta corriente de retornables' });
    }
  });

  router.get('/ledger/movimientos', authMiddleware, licenciaMiddleware, async (req, res) => {
    try {
      await ensureSchemaPromise;
      const empresaId = resolveEmpresaId(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const sujetoTipo = req.query?.sujeto_tipo ? normalizeRetornableSujetoTipo(req.query.sujeto_tipo) : null;
      if (req.query?.sujeto_tipo && !sujetoTipo) return res.status(400).json({ error: 'sujeto_tipo inválido' });
      const sujetoId = toNumber(req.query?.sujeto_id, null);
      const productoId = toNumber(req.query?.producto_id, null);
      const origen = cleanText(req.query?.origen, 60) || null;
      const tipo = cleanText(req.query?.tipo, 80) || null;
      const limit = normalizeLimit(req.query?.limit, 100, 500);

      const rows = await dbQuery(
        `
        SELECT
          m.*,
          COALESCE(p.nombre, 'Producto #' || m.producto_id::text) AS producto,
          CASE m.sujeto_tipo
            WHEN 'cliente' THEN COALESCE(pe.cliente, pe.nombre, 'Cliente #' || m.sujeto_id::text)
            WHEN 'chofer' THEN COALESCE(ch.nombre, ch.username, 'Chofer #' || m.sujeto_id::text)
            WHEN 'proveedor' THEN COALESCE(prv.nombre, 'Proveedor #' || m.sujeto_id::text)
            WHEN 'deposito' THEN COALESCE(dep.nombre, 'Depósito #' || m.sujeto_id::text)
            ELSE m.sujeto_tipo || ' #' || m.sujeto_id::text
          END AS sujeto_nombre
        FROM retornables_movimientos m
        LEFT JOIN productos p ON p.id = m.producto_id AND p.empresa_id = m.empresa_id
        LEFT JOIN puntos_entrega pe ON m.sujeto_tipo = 'cliente' AND pe.id = m.sujeto_id AND pe.empresa_id = m.empresa_id
        LEFT JOIN choferes ch ON m.sujeto_tipo = 'chofer' AND ch.id = m.sujeto_id AND ch.empresa_id = m.empresa_id
        LEFT JOIN proveedores prv ON m.sujeto_tipo = 'proveedor' AND prv.id = m.sujeto_id AND prv.empresa_id = m.empresa_id
        LEFT JOIN depositos dep ON m.sujeto_tipo = 'deposito' AND dep.id = m.sujeto_id AND dep.empresa_id = m.empresa_id
        WHERE m.empresa_id = $1
          AND ($2::text IS NULL OR m.sujeto_tipo = $2)
          AND ($3::int IS NULL OR m.sujeto_id = $3)
          AND ($4::int IS NULL OR m.producto_id = $4)
          AND ($5::text IS NULL OR m.origen = $5)
          AND ($6::text IS NULL OR m.tipo = $6)
        ORDER BY m.fecha DESC, m.id DESC
        LIMIT $7
        `,
        [empresaId, sujetoTipo, sujetoId, productoId, origen, tipo, limit]
      );

      return res.json({
        ok: true,
        rows: (rows || []).map((r) => ({
          ...r,
          cantidad_llenos: Number(r.cantidad_llenos || 0),
          cantidad_vacios: Number(r.cantidad_vacios || 0),
          delta_saldo: Number(r.delta_saldo || 0),
          saldo_resultante: Number(r.saldo_resultante || 0),
        })),
      });
    } catch (e) {
      console.error('GET /api/retornables/ledger/movimientos', e);
      return res.status(500).json({ error: 'Error cargando ledger de retornables' });
    }
  });

  router.get('/movimientos', authMiddleware, licenciaMiddleware, async (req, res) => {
    try {
      await ensureSchemaPromise;
      const empresaId = resolveEmpresaId(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const productoId = toNumber(req.query?.producto_id, null);
      const puntoEntregaId = toNumber(req.query?.punto_entrega_id, null);
      const choferId = toNumber(req.query?.chofer_id, null);
      const pedidoId = toNumber(req.query?.pedido_id, null);
      const limit = normalizeLimit(req.query?.limit, 80, 500);

      const rows = await dbQuery(
        `
        SELECT
          m.id,
          m.fecha,
          m.punto_entrega_id,
          COALESCE(pe.cliente, pe.nombre, 'Cliente #' || m.punto_entrega_id::text) AS cliente,
          COALESCE(pe.direccion_completa, pe.direccion, '') AS direccion,
          m.producto_id,
          COALESCE(p.nombre, 'Producto #' || m.producto_id::text) AS producto,
          m.pedido_id,
          m.chofer_id,
          ch.nombre AS chofer,
          m.entregados,
          m.devueltos,
          m.delta,
          m.saldo_resultante,
          m.observacion,
          m.created_at
        FROM cliente_retornables_movimientos m
        LEFT JOIN puntos_entrega pe ON pe.id = m.punto_entrega_id AND pe.empresa_id = m.empresa_id
        LEFT JOIN productos p ON p.id = m.producto_id AND p.empresa_id = m.empresa_id
        LEFT JOIN choferes ch ON ch.id = m.chofer_id AND ch.empresa_id = m.empresa_id
        WHERE m.empresa_id = $1
          AND ($2::int IS NULL OR m.producto_id = $2)
          AND ($3::int IS NULL OR m.punto_entrega_id = $3)
          AND ($4::int IS NULL OR m.chofer_id = $4)
          AND ($5::int IS NULL OR m.pedido_id = $5)
        ORDER BY m.fecha DESC, m.id DESC
        LIMIT $6
        `,
        [empresaId, productoId, puntoEntregaId, choferId, pedidoId, limit]
      );

      return res.json({
        ok: true,
        rows: (rows || []).map((r) => ({
          ...r,
          entregados: Number(r.entregados || 0),
          devueltos: Number(r.devueltos || 0),
          delta: Number(r.delta || 0),
          saldo_resultante: Number(r.saldo_resultante || 0),
        })),
      });
    } catch (e) {
      console.error('GET /api/retornables/movimientos', e);
      return res.status(500).json({ error: 'Error cargando movimientos de retornables' });
    }
  });

  router.post('/ajustes', authMiddleware, licenciaMiddleware, express.json({ limit: '80kb' }), async (req, res) => {
    try {
      await ensureSchemaPromise;
      const empresaId = Number(isSuperFn(req) && req.body?.empresa_id ? req.body.empresa_id : getEmpresaIdFromTokenFn(req));
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const sujetoTipo = normalizeRetornableSujetoTipo(req.body?.sujeto_tipo || (req.body?.punto_entrega_id ? 'cliente' : 'cliente'));
      const sujetoId = Number(req.body?.sujeto_id || req.body?.punto_entrega_id || 0);
      const puntoEntregaId = sujetoTipo === 'cliente' ? sujetoId : Number(req.body?.punto_entrega_id || 0);
      const productoId = Number(req.body?.producto_id || 0);
      const cantidad = Number(req.body?.cantidad || 0);
      const modo = String(req.body?.modo || 'sumar').toLowerCase(); // sumar | restar | fijar
      const observacion = cleanText(req.body?.observacion, 500) || 'Ajuste manual de cuenta corriente';
      const choferId = req.body?.chofer_id ? Number(req.body.chofer_id) : null;

      if (!sujetoTipo) return res.status(400).json({ error: 'sujeto_tipo inválido' });
      if (!sujetoId) return res.status(400).json({ error: 'Sujeto requerido' });
      if (!productoId) return res.status(400).json({ error: 'Producto retornable requerido' });
      if (!Number.isFinite(cantidad) || cantidad < 0) return res.status(400).json({ error: 'Cantidad inválida' });
      if (!['sumar', 'restar', 'fijar'].includes(modo)) return res.status(400).json({ error: 'Modo de ajuste inválido' });

      const result = await withTransaction(async (txQuery) => {
        const sujetoTables = {
          cliente: ['puntos_entrega', 'Cliente'],
          chofer: ['choferes', 'Chofer'],
          proveedor: ['proveedores', 'Proveedor'],
          deposito: ['depositos', 'Depósito'],
        };
        const [tablaSujeto, labelSujeto] = sujetoTables[sujetoTipo];
        const sujetoRows = await txQuery(
          `SELECT id FROM ${tablaSujeto} WHERE id = $1 AND empresa_id = $2 LIMIT 1`,
          [sujetoId, empresaId]
        );
        if (!sujetoRows.length) {
          const err = new Error(`${labelSujeto} inválido para la empresa`);
          err.statusCode = 400;
          throw err;
        }

        const productoRows = await txQuery(
          `SELECT id, nombre FROM productos WHERE id = $1 AND empresa_id = $2 AND COALESCE(retornable, FALSE) = TRUE AND deleted_at IS NULL LIMIT 1`,
          [productoId, empresaId]
        );
        if (!productoRows.length) {
          const err = new Error('El producto no es retornable o no pertenece a la empresa');
          err.statusCode = 400;
          throw err;
        }

        if (choferId) {
          const choferRows = await txQuery(
            `SELECT id FROM choferes WHERE id = $1 AND empresa_id = $2 LIMIT 1`,
            [choferId, empresaId]
          );
          if (!choferRows.length) {
            const err = new Error('Chofer inválido para la empresa');
            err.statusCode = 400;
            throw err;
          }
        }

        const saldoActualRows = await txQuery(
          `SELECT saldo FROM retornables_saldos WHERE empresa_id = $1 AND sujeto_tipo = $2 AND sujeto_id = $3 AND producto_id = $4 FOR UPDATE`,
          [empresaId, sujetoTipo, sujetoId, productoId]
        );
        const saldoActual = Number(saldoActualRows?.[0]?.saldo || 0);
        const delta = modo === 'fijar'
          ? cantidad - saldoActual
          : modo === 'restar'
            ? -cantidad
            : cantidad;

        const ledger = await registrarRetornableMovimiento(txQuery, {
          empresaId,
          sujetoTipo,
          sujetoId,
          productoId,
          deltaSaldo: delta,
          cantidadLlenos: delta > 0 ? delta : 0,
          cantidadVacios: delta < 0 ? Math.abs(delta) : 0,
          tipo: 'ajuste',
          origen: 'admin',
          choferId,
          observacion: `${observacion} (${modo}: ${cantidad})`,
          referencia: `ajuste_manual:${sujetoTipo}:${sujetoId}`,
          createdBy: req.user?.username || req.user?.id || null,
        });

        let movRows = [ledger.movimiento].filter(Boolean);
        let saldoResultante = Number(ledger.saldo_resultante || 0);

        if (sujetoTipo === 'cliente') {
          const saldoRows = await txQuery(
            `
            INSERT INTO cliente_retornables_saldos
              (empresa_id, punto_entrega_id, producto_id, saldo, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (empresa_id, punto_entrega_id, producto_id)
            DO UPDATE SET saldo = cliente_retornables_saldos.saldo + EXCLUDED.saldo, updated_at = NOW()
            RETURNING saldo
            `,
            [empresaId, puntoEntregaId, productoId, delta]
          );
          saldoResultante = Number(saldoRows?.[0]?.saldo || saldoResultante);

          movRows = await txQuery(
            `
            INSERT INTO cliente_retornables_movimientos
              (empresa_id, punto_entrega_id, pedido_id, chofer_id, producto_id, entregados, devueltos, delta, saldo_resultante, observacion, fecha)
            VALUES
              ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, NOW())
            RETURNING id, fecha
            `,
            [
              empresaId,
              puntoEntregaId,
              choferId,
              productoId,
              delta > 0 ? delta : 0,
              delta < 0 ? Math.abs(delta) : 0,
              delta,
              saldoResultante,
              `${observacion} (${modo}: ${cantidad})`,
            ]
          );
        }

        return {
          movimiento: movRows?.[0] || null,
          producto: productoRows?.[0] || null,
          sujeto_tipo: sujetoTipo,
          sujeto_id: sujetoId,
          saldo_anterior: saldoActual,
          delta,
          saldo_resultante: saldoResultante,
        };
      });

      return res.json({ ok: true, ...result });
    } catch (e) {
      console.error('POST /api/retornables/ajustes', e);
      return res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Error registrando ajuste de retornables' });
    }
  });

  return router;
}
