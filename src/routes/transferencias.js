// src/routes/transferencias.js
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { withAuth, isSuper, getEmpresaIdFromToken, enqueueWppMessage } from '../services.js';
import { query } from '../db.js';
import { notificarPedidoTransferencia } from '../services/notificacionesPedidos.js';

function csvCell(v) {
  const s = String(v == null ? '' : v).replace(/"/g, '""');
  return `"${s}"`;
}

/**
 * Router de transferencias (comprobantes_transferencia).
 *
 * Requisitos del caller (server.js):
 * - debe montar static de TRANSF_DIR en /Transferencia (URLs públicas)
 * - debe pasar TRANSF_DIR absoluto como opción
 */
export function createTransferenciasRouter({ TRANSF_DIR }) {
  if (!TRANSF_DIR) throw new Error('createTransferenciasRouter requiere TRANSF_DIR');

  const router = express.Router();
  const VERIFY_TOLERANCE = Number(process.env.TRANSFER_VERIFY_TOLERANCE || 1);

  // Hardening incremental sin romper instalaciones existentes
  // (si la columna ya existe, no hace nada).
  const ensureSchemaPromise = (async () => {
    try {
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS file_hash TEXT`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS estado_revision TEXT DEFAULT 'pendiente'`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS riesgo_score INTEGER DEFAULT 0`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS riesgo_flags TEXT`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS verified_by INTEGER`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS verified_reason TEXT`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS alias_destino TEXT`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS cbu_destino TEXT`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS titular_destino TEXT`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS cuenta_bancaria_id INTEGER REFERENCES empresa_cuentas_bancarias(id) ON DELETE SET NULL`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS cuenta_bancaria_confianza INTEGER DEFAULT 0`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS cuenta_bancaria_match_fuente TEXT`);
      await query(`ALTER TABLE comprobantes_transferencia ADD COLUMN IF NOT EXISTS cuenta_bancaria_match_detalle TEXT`);
      await query(`CREATE INDEX IF NOT EXISTS idx_ct_empresa_file_hash ON comprobantes_transferencia (empresa_id, file_hash)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_ct_estado_revision ON comprobantes_transferencia (estado_revision)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_ct_cuenta_bancaria ON comprobantes_transferencia (empresa_id, cuenta_bancaria_id, fecha DESC)`);
    } catch (e) {
      console.error('transferencias schema hardening error:', e?.message || e);
    }
  })();

  async function calcSha256FromSavedFile(filePath) {
    const buf = await readFile(filePath);
    return createHash('sha256').update(buf).digest('hex');
  }

  function applyTransferFilters({ sql, params, idx, filters }) {
    const { esSuperUser, myEmpresa, empresa_id, fecha, choferId, estado, estadoRevision, cuentaBancariaId } = filters;

    if (!esSuperUser) {
      sql += ` AND ct.empresa_id = $${idx++}`;
      params.push(myEmpresa);
    } else if (empresa_id) {
      sql += ` AND ct.empresa_id = $${idx++}`;
      params.push(Number(empresa_id));
    }

    if (fecha) {
      sql += ` AND ct.fecha >= $${idx}::date AND ct.fecha < ($${idx}::date + INTERVAL '1 day')`;
      params.push(fecha);
      idx += 1;
    }

    if (choferId) {
      sql += ` AND ct.chofer_id = $${idx++}`;
      params.push(choferId);
    }

    if (estado === 'verificado') {
      sql += ` AND (COALESCE(ct.validado, 0) = 1 OR COALESCE(ct.procesado, FALSE) = TRUE)`;
    } else if (estado === 'pendiente') {
      sql += ` AND COALESCE(ct.validado, 0) <> 1 AND COALESCE(ct.procesado, FALSE) <> TRUE`;
    }

    if (estadoRevision && ['pendiente', 'en_revision', 'aprobado', 'rechazado', 'duplicado'].includes(estadoRevision)) {
      sql += ` AND COALESCE(ct.estado_revision, 'pendiente') = $${idx++}`;
      params.push(estadoRevision);
    }

    if (cuentaBancariaId === 'no_detectada') {
      sql += ` AND ct.cuenta_bancaria_id IS NULL`;
    } else if (cuentaBancariaId) {
      const cuentaId = Number(cuentaBancariaId);
      if (Number.isFinite(cuentaId) && cuentaId > 0) {
        sql += ` AND ct.cuenta_bancaria_id = $${idx++}`;
        params.push(cuentaId);
      }
    }

    return { sql, params, idx };
  }

  const transferUploader = multer({
    storage: multer.diskStorage({
      destination: (_, __, cb) => cb(null, TRANSF_DIR),
      filename: (_, file, cb) => {
        const ext = path.extname(file.originalname || '') || '.bin';
        cb(null, `tr-${Date.now()}${ext}`);
      }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_, file, cb) => {
      const ok = /image|pdf/.test(file.mimetype);
      cb(ok ? null : new Error('Tipo no permitido'), ok);
    }
  });

  router.get('/cuentas-bancarias', withAuth, async (req, res) => {
    try {
      await ensureSchemaPromise;
      const { empresa_id } = req.query || {};
      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      let sql = `
        SELECT id, empresa_id, banco, alias, cbu, titular, prioridad
        FROM empresa_cuentas_bancarias
        WHERE COALESCE(activa, TRUE) = TRUE
      `;
      const params = [];
      let idx = 1;

      if (!esSuperUser) {
        sql += ` AND empresa_id = $${idx++}`;
        params.push(Number(myEmpresa));
      } else if (empresa_id) {
        sql += ` AND empresa_id = $${idx++}`;
        params.push(Number(empresa_id));
      }

      sql += ` ORDER BY empresa_id, COALESCE(prioridad, 999), banco NULLS LAST, alias NULLS LAST, id`;
      const rows = await query(sql, params);
      return res.json(rows || []);
    } catch (e) {
      console.error('Error listando cuentas bancarias para transferencias:', e?.message || e);
      return res.status(500).json({ error: 'Error listando cuentas bancarias' });
    }
  });

  // LISTAR TRANSFERENCIAS
  router.get('/', withAuth, async (req, res) => {
    try {
      await ensureSchemaPromise;
      const { empresa_id } = req.query || {};
      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const fecha = (req.query.fecha || '').toString().slice(0, 10);
      const estado = (req.query.estado || '').toString().trim().toLowerCase();
      const estadoRevision = (req.query.estado_revision || '').toString().trim().toLowerCase();
      const cuentaBancariaId = (req.query.cuenta_bancaria_id || '').toString().trim();
      const choferId = Number(req.query.chofer_id || 0) || null;
      const limitRaw = Number(req.query.limit || 0) || 0;
      const offsetRaw = Number(req.query.offset || 0) || 0;
      const beforeId = Number(req.query.before_id || 0) || null;
      const limit = Math.min(Math.max(limitRaw, 0), 1000);
      const offset = Math.max(offsetRaw, 0);

      let sql = `
        SELECT
          ct.id AS transferencia_id,
          ct.id,
          ct.fecha,
          COALESCE(NULLIF(ct.monto, 0), p.monto, 0) AS monto,
          COALESCE(ct.metodo_pago, p.metodo_pago, 'transferencia') AS metodo_pago,
          ct.comprobante_path,
          ct.pedido_id,
          ct.validado,
          ct.procesado,
          ct.estado_revision,
          ct.riesgo_score,
          ct.riesgo_flags,
          ct.verified_reason,
          ct.verified_by,
          ct.verified_at,
          uv.username AS verified_by_username,
          ct.banco_origen,
          ct.banco_destino,
          ct.alias_destino,
          ct.cbu_destino,
          ct.titular_destino,
          ct.cuenta_bancaria_id,
          ct.cuenta_bancaria_confianza,
          ct.cuenta_bancaria_match_fuente,
          ct.cuenta_bancaria_match_detalle,
          cb.banco AS cuenta_banco,
          cb.alias AS cuenta_alias,
          cb.cbu AS cuenta_cbu,
          cb.titular AS cuenta_titular,
          ct.nro_operacion,
          z.nombre AS zona_nombre,
          pe.cliente,
          pe.telefono
        FROM comprobantes_transferencia ct
        LEFT JOIN pedidos p           ON p.id = ct.pedido_id
        LEFT JOIN puntos_entrega pe   ON pe.id = p.punto_entrega_id
        LEFT JOIN zonas_geograficas z ON z.id = ct.zona_id
        LEFT JOIN usuarios uv         ON uv.id = ct.verified_by
        LEFT JOIN empresa_cuentas_bancarias cb ON cb.id = ct.cuenta_bancaria_id
        WHERE 1=1
      `;

      let params = [];
      let idx = 1;

      ({ sql, params, idx } = applyTransferFilters({
        sql,
        params,
        idx,
        filters: { esSuperUser, myEmpresa, empresa_id, fecha, choferId, estado, estadoRevision, cuentaBancariaId }
      }));

      if (beforeId) {
        sql += ` AND ct.id < $${idx++}`;
        params.push(beforeId);
      }

      sql += ` ORDER BY ct.fecha DESC, ct.id DESC`;
      if (limit > 0) {
        sql += ` LIMIT $${idx++}`;
        params.push(limit);
        if (offset > 0) {
          sql += ` OFFSET $${idx++}`;
          params.push(offset);
        }
      }

      const rows = await query(sql, params);
      if (limit > 0) {
        res.setHeader('X-Page-Limit', String(limit));
        res.setHeader('X-Page-Offset', String(offset));
        res.setHeader('X-Page-Count', String(rows.length));
        if (beforeId) res.setHeader('X-Page-Before-Id', String(beforeId));
      }
      res.json(rows);
    } catch (e) {
      console.error('Error listando transferencias:', e?.message || e, {
        estado: req.query?.estado,
        estado_revision: req.query?.estado_revision,
        empresa_id: req.query?.empresa_id,
        chofer_id: req.query?.chofer_id,
        fecha: req.query?.fecha
      });
      res.status(500).json({ error: 'Error listando transferencias' });
    }
  });

  // PEDIDOS CON PAGO POR TRANSFERENCIA SIN COMPROBANTE ADJUNTO
  router.get('/sin-comprobante', withAuth, async (req, res) => {
    try {
      const { empresa_id } = req.query || {};
      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const fecha = (req.query.fecha || '').toString().slice(0, 10);
      const choferId = Number(req.query.chofer_id || 0) || null;
      const limitRaw = Number(req.query.limit || 0) || 0;
      const beforeId = Number(req.query.before_id || 0) || null;
      const limit = Math.min(Math.max(limitRaw, 0), 1000);

      let sql = `
        SELECT
          p.id,
          p.id AS pedido_id,
          p.fecha,
          p.estado,
          p.monto,
          p.metodo_pago,
          p.empresa_id,
          p.chofer_id,
          pe.cliente,
          pe.telefono,
          pe.direccion,
          z.nombre AS zona_nombre,
          c.nombre AS chofer_nombre
        FROM pedidos p
        LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        LEFT JOIN zonas_geograficas z ON z.id = p.zona_id
        LEFT JOIN choferes c ON c.id = p.chofer_id
        WHERE LOWER(COALESCE(p.metodo_pago, '')) LIKE 'transfer%'
          AND COALESCE(p.estado, '') <> 'cancelado'
          AND NOT EXISTS (
            SELECT 1
            FROM comprobantes_transferencia ct
            WHERE ct.pedido_id = p.id
              AND ct.empresa_id = p.empresa_id
              AND NULLIF(TRIM(COALESCE(ct.comprobante_path, '')), '') IS NOT NULL
          )
      `;

      const params = [];
      let idx = 1;

      if (!esSuperUser) {
        sql += ` AND p.empresa_id = $${idx++}`;
        params.push(myEmpresa);
      } else if (empresa_id) {
        sql += ` AND p.empresa_id = $${idx++}`;
        params.push(Number(empresa_id));
      }

      if (fecha) {
        sql += ` AND p.fecha >= $${idx}::date AND p.fecha < ($${idx}::date + INTERVAL '1 day')`;
        params.push(fecha);
        idx += 1;
      }

      if (choferId) {
        sql += ` AND p.chofer_id = $${idx++}`;
        params.push(choferId);
      }

      if (beforeId) {
        sql += ` AND p.id < $${idx++}`;
        params.push(beforeId);
      }

      sql += ` ORDER BY p.fecha DESC, p.id DESC`;
      if (limit > 0) {
        sql += ` LIMIT $${idx++}`;
        params.push(limit);
      }

      const rows = await query(sql, params);
      res.json(rows);
    } catch (e) {
      console.error('Error listando transferencias sin comprobante:', e?.message || e);
      res.status(500).json({ error: 'Error listando transferencias sin comprobante' });
    }
  });

  router.post('/pedidos/:id/solicitar-comprobante', withAuth, async (req, res) => {
    try {
      const pedidoId = Number(req.params.id);
      if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
        return res.status(400).json({ error: 'ID inválido' });
      }

      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        `SELECT p.id, p.empresa_id, p.metodo_pago, pe.telefono
         FROM pedidos p
         LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
         WHERE p.id = $1
           AND ($2::int IS NULL OR p.empresa_id = $2)
         LIMIT 1`,
        [pedidoId, esSuperUser ? null : Number(myEmpresa)]
      );

      if (!rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });

      const pedido = rows[0];
      if (!String(pedido.metodo_pago || '').toLowerCase().startsWith('transfer')) {
        return res.status(409).json({ error: 'El pedido no está marcado como transferencia' });
      }
      if (!String(pedido.telefono || '').replace(/\D+/g, '')) {
        return res.status(409).json({ error: 'El cliente no tiene WhatsApp cargado' });
      }

      await notificarPedidoTransferencia(pedidoId, Number(pedido.empresa_id));
      return res.json({ ok: true });
    } catch (e) {
      console.error('Error solicitando comprobante de transferencia:', e);
      return res.status(500).json({ error: 'Error enviando solicitud de comprobante' });
    }
  });

  // RESUMEN KPI
  router.get('/resumen', withAuth, async (req, res) => {
    try {
      await ensureSchemaPromise;
      const { empresa_id } = req.query || {};
      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);
      const fecha = (req.query.fecha || '').toString().slice(0, 10);
      const estado = (req.query.estado || '').toString().trim().toLowerCase();
      const estadoRevision = (req.query.estado_revision || '').toString().trim().toLowerCase();
      const cuentaBancariaId = (req.query.cuenta_bancaria_id || '').toString().trim();
      const choferId = Number(req.query.chofer_id || 0) || null;

      let sql = `
        SELECT
          COUNT(*)::int AS total_count,
          COALESCE(SUM(CASE WHEN COALESCE(ct.validado, 0) = 1 THEN 1 ELSE 0 END), 0)::int AS verified_count,
          COALESCE(SUM(CASE WHEN COALESCE(ct.validado, 0) <> 1 THEN 1 ELSE 0 END), 0)::int AS pending_count,
          COALESCE(SUM(CASE WHEN COALESCE(ct.estado_revision, 'pendiente') = 'en_revision' THEN 1 ELSE 0 END), 0)::int AS review_count,
          COALESCE(SUM(COALESCE(ct.monto, 0)), 0)::numeric AS total_amount
        FROM comprobantes_transferencia ct
        LEFT JOIN pedidos p ON p.id = ct.pedido_id
        WHERE 1=1
      `;

      let params = [];
      let idx = 1;
      ({ sql, params, idx } = applyTransferFilters({
        sql,
        params,
        idx,
        filters: { esSuperUser, myEmpresa, empresa_id, fecha, choferId, estado, estadoRevision, cuentaBancariaId }
      }));

      const rows = await query(sql, params);
      return res.json(rows?.[0] || {
        total_count: 0,
        verified_count: 0,
        pending_count: 0,
        review_count: 0,
        total_amount: 0
      });
    } catch (e) {
      console.error('Error resumen transferencias:', e);
      return res.status(500).json({ error: 'Error obteniendo resumen' });
    }
  });

  // EXPORTAR CSV
  router.get('/export.csv', withAuth, async (req, res) => {
    try {
      await ensureSchemaPromise;
      const { empresa_id } = req.query || {};
      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);
      const fecha = (req.query.fecha || '').toString().slice(0, 10);
      const estado = (req.query.estado || '').toString().trim().toLowerCase();
      const estadoRevision = (req.query.estado_revision || '').toString().trim().toLowerCase();
      const cuentaBancariaId = (req.query.cuenta_bancaria_id || '').toString().trim();
      const choferId = Number(req.query.chofer_id || 0) || null;

      let sql = `
        SELECT
          ct.id,
          ct.fecha,
          ct.pedido_id,
          pe.cliente,
          pe.telefono,
          ct.monto,
          ct.metodo_pago,
          ct.validado,
          ct.estado_revision,
          ct.riesgo_score,
          ct.riesgo_flags,
          ct.nro_operacion,
          ct.banco_origen,
          ct.banco_destino,
          ct.alias_destino,
          ct.cbu_destino,
          ct.titular_destino,
          ct.cuenta_bancaria_id,
          cb.banco AS cuenta_banco,
          cb.alias AS cuenta_alias,
          cb.titular AS cuenta_titular,
          ct.verified_by,
          uv.username AS verified_by_username,
          ct.verified_at,
          ct.verified_reason,
          ct.comprobante_path
        FROM comprobantes_transferencia ct
        LEFT JOIN puntos_entrega pe ON pe.id = (SELECT p.punto_entrega_id FROM pedidos p WHERE p.id = ct.pedido_id)
        LEFT JOIN usuarios uv       ON uv.id = ct.verified_by
        LEFT JOIN empresa_cuentas_bancarias cb ON cb.id = ct.cuenta_bancaria_id
        WHERE 1=1
      `;

      let params = [];
      let idx = 1;
      ({ sql, params, idx } = applyTransferFilters({
        sql,
        params,
        idx,
        filters: { esSuperUser, myEmpresa, empresa_id, fecha, choferId, estado, estadoRevision, cuentaBancariaId }
      }));
      sql += ' ORDER BY ct.fecha DESC, ct.id DESC';

      const rows = await query(sql, params);
      const headers = [
        'id','fecha','pedido_id','cliente','telefono','monto','metodo_pago','validado',
        'estado_revision','riesgo_score','riesgo_flags','nro_operacion','banco_origen',
        'banco_destino','alias_destino','cbu_destino','titular_destino','cuenta_bancaria_id',
        'cuenta_banco','cuenta_alias','cuenta_titular',
        'verified_by','verified_by_username','verified_at','verified_reason','comprobante_path'
      ];

      const csv = [headers.map(csvCell).join(',')]
        .concat(rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')))
        .join('\n');

      const stamp = fecha || new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="transferencias-${stamp}.csv"`);
      return res.status(200).send(csv);
    } catch (e) {
      console.error('Error exportando transferencias CSV:', e);
      return res.status(500).json({ error: 'Error exportando transferencias' });
    }
  });

  // SUBIR COMPROBANTE
  router.post(
    '/upload',
    withAuth,
    transferUploader.single('comprobante'),
    async (req, res) => {
      try {
        await ensureSchemaPromise;
        const body = req.body || {};
        const pedidoId = Number(body.pedido_id);
        if (!Number.isFinite(pedidoId)) {
          return res.status(400).json({ error: 'pedido_id inválido' });
        }
        if (!req.file) {
          return res.status(400).json({ error: 'archivo requerido' });
        }

        const esSuperUser = isSuper(req);
        const myEmpresa = getEmpresaIdFromToken(req);
        const choferToken = req.user?.chofer_id ? Number(req.user.chofer_id) : null;

        const pedRows = await query(`
          SELECT
            p.id,
            p.empresa_id,
            p.chofer_id,
            p.monto,
            p.metodo_pago,
            p.fecha,
            p.zona_id,
            pe.cliente,
            pe.telefono
          FROM pedidos p
          LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
          WHERE p.id = $1
        `, [pedidoId]);

        if (!pedRows.length) {
          return res.status(404).json({ error: 'pedido no encontrado' });
        }

        const ped = pedRows[0];

        if (!esSuperUser) {
          if (!myEmpresa || Number(ped.empresa_id) !== Number(myEmpresa)) {
            return res.status(403).json({ error: 'No autorizado para este pedido' });
          }
        }

        let choferId = ped.chofer_id || choferToken;
        if (!choferId) {
          return res.status(400).json({ error: 'Sin chofer asociado al pedido' });
        }

        const filename = req.file.filename;
        const fullPath = path.join(TRANSF_DIR, filename);
        const fileHash = await calcSha256FromSavedFile(fullPath);

        const dupHashRows = await query(`
          SELECT id, fecha, comprobante_path, validado, estado_revision
          FROM comprobantes_transferencia
          WHERE empresa_id = $1
            AND file_hash = $2
          ORDER BY id DESC
          LIMIT 1
        `, [ped.empresa_id, fileHash]);

        // Idempotencia por reintento exacto del mismo archivo
        if (dupHashRows.length) {
          try { await unlink(fullPath); } catch {}
          return res.status(200).json({
            ok: true,
            duplicate: true,
            reason: 'duplicate_file_hash',
            existing: dupHashRows[0]
          });
        }

        const archivoPath = filename;
        const comprobantePath = `/Transferencia/${filename}`;

        const metodo = (ped.metodo_pago || 'transferencia').toString().toLowerCase();
        const monto = Number(ped.monto || 0) || 0;

        let riesgoScore = 0;
        const riesgoFlags = [];

        const repetidosMonto = await query(`
          SELECT COUNT(*)::int AS c
          FROM comprobantes_transferencia
          WHERE empresa_id = $1
            AND ABS(COALESCE(monto, 0) - $2) < 0.01
            AND fecha >= NOW() - INTERVAL '24 hours'
        `, [ped.empresa_id, monto]);

        if (Number(repetidosMonto?.[0]?.c || 0) >= 3) {
          riesgoScore += 30;
          riesgoFlags.push('MONTO_REPETIDO_24H');
        }

        const estadoRevision = riesgoScore >= 30 ? 'en_revision' : 'pendiente';

        const rows = await query(`
          INSERT INTO comprobantes_transferencia (
            empresa_id,
            chofer_id,
            fecha,
            monto,
            metodo_pago,
            comentario,
            archivo_path,
            pedido_id,
            zona_id,
            comprobante_path,
            telefono,
            file_hash,
            estado_revision,
            riesgo_score,
            riesgo_flags,
            created_at,
            updated_at,
            validado
          )
          VALUES (
            $1, $2, NOW(), $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12, $13, $14,
            NOW(), NOW(), 0
          )
          RETURNING
            id               AS transferencia_id,
            id,
            fecha,
            monto,
            metodo_pago,
            comprobante_path,
            pedido_id,
            zona_id,
            chofer_id,
            validado,
            estado_revision,
            riesgo_score,
            riesgo_flags
        `, [
          ped.empresa_id,
          choferId,
          monto,
          metodo,
          body.comentario || null,
          archivoPath,
          pedidoId,
          ped.zona_id || null,
          comprobantePath,
          ped.telefono || null,
          fileHash,
          estadoRevision,
          riesgoScore,
          riesgoFlags.length ? riesgoFlags.join(',') : null
        ]);

        res.json(rows[0]);
      } catch (e) {
        console.error('Error subiendo comprobante de transferencia:', e);
        res.status(500).json({ error: 'Error subiendo comprobante' });
      }
    }
  );

  // VERIFICAR
  router.post('/:id/verificar', withAuth, async (req, res) => {
    try {
      await ensureSchemaPromise;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);
      const enviarAviso = String(req.query.enviarAviso || '').trim() === '1';
      const force = String(req.query.force || '').trim() === '1';
      const motivo = (req.body?.reason || req.query.reason || '').toString().trim() || null;

      const rows = await query(`
        SELECT
          ct.*,
          p.monto        AS pedido_monto,
          p.metodo_pago  AS pedido_metodo,
          p.fecha        AS pedido_fecha,
          p.id           AS pedido_id,
          pe.cliente,
          pe.telefono
        FROM comprobantes_transferencia ct
        LEFT JOIN pedidos p         ON p.id = ct.pedido_id
        LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        WHERE ct.id = $1
          AND ($2::int IS NULL OR ct.empresa_id = $2)
        LIMIT 1
      `, [id, esSuperUser ? null : Number(myEmpresa)]);

      if (!rows.length) {
        return res.status(404).json({ error: 'transferencia no encontrada' });
      }

      const ct = rows[0];
      const monto = Number(ct.monto ?? ct.pedido_monto ?? 0) || 0;
      const pedidoMonto = Number(ct.pedido_monto ?? 0) || 0;
      const hayMismatchMonto = !!ct.pedido_id && Math.abs(monto - pedidoMonto) > VERIFY_TOLERANCE;

      if (hayMismatchMonto && !force) {
        const mismatchReason = `Monto comprobante (${monto}) no coincide con pedido (${pedidoMonto})`;
        await query(
          `UPDATE comprobantes_transferencia
           SET validado = 0,
               estado_revision = 'en_revision',
               riesgo_score = GREATEST(COALESCE(riesgo_score, 0), 70),
               riesgo_flags = TRIM(BOTH ',' FROM CONCAT_WS(',', NULLIF(riesgo_flags, ''), 'MONTO_MISMATCH')),
               verified_reason = COALESCE($3, $4),
               updated_at = NOW()
           WHERE id = $1
             AND ($2::int IS NULL OR empresa_id = $2)`,
          [id, esSuperUser ? null : Number(myEmpresa), motivo, mismatchReason]
        );

        return res.status(409).json({
          ok: false,
          needsReview: true,
          reason: 'monto_mismatch',
          detail: mismatchReason,
          tolerance: VERIFY_TOLERANCE
        });
      }

      await query(
        `UPDATE comprobantes_transferencia
         SET validado = 1,
             estado_revision = 'aprobado',
             verified_by = $3,
             verified_reason = COALESCE($4, verified_reason),
             verified_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND ($2::int IS NULL OR empresa_id = $2)`,
        [id, esSuperUser ? null : Number(myEmpresa), Number(req.user?.uid || 0) || null, motivo]
      );

      let metodo = (ct.metodo_pago || ct.pedido_metodo || 'transferencia').toString().toLowerCase();
      if (metodo !== 'efectivo') metodo = 'transferencia';
      const fecha = (ct.fecha || ct.pedido_fecha || new Date().toISOString());

      let existe = [];
      if (ct.pedido_id) {
        existe = await query(`
          SELECT id
          FROM transferencias
          WHERE empresa_id = $1
            AND chofer_id  = $2
            AND pedido_id  = $3
            AND metodo_pago = $4
            AND ABS(monto - $5) < 0.01
          LIMIT 1
        `, [
          ct.empresa_id,
          ct.chofer_id,
          ct.pedido_id,
          metodo,
          monto
        ]);
      }

      if (!existe.length) {
        await query(`
          INSERT INTO transferencias (
            empresa_id,
            chofer_id,
            fecha,
            monto,
            metodo_pago,
            referencia,
            comprobante_path,
            pedido_id,
            notas
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9
          )
        `, [
          ct.empresa_id,
          ct.chofer_id,
          fecha,
          monto,
          metodo,
          ct.pedido_id
            ? `Transferencia verificada pedido #${ct.pedido_id}`
            : 'Transferencia verificada',
          ct.comprobante_path || null,
          ct.pedido_id || null,
          `Origen comprobantes_transferencia.id=${ct.id}`
        ]);
      }

      if (enviarAviso && ct.telefono && typeof enqueueWppMessage === 'function') {
        try {
          const digits = String(ct.telefono).replace(/\D+/g, '');
          if (digits) {
            const fmt = new Intl.NumberFormat('es-AR', {
              style: 'currency',
              currency: 'ARS',
              minimumFractionDigits: 2
            }).format(monto || 0);

            const mensaje = (
              `¡Hola ${ct.cliente || ''}!\n` +
              `✅ Registramos tu pago por transferencia de ${fmt} ` +
              `${ct.pedido_id ? `para el pedido #${ct.pedido_id}.` : ''}\n` +
              `🙏 ¡Muchas gracias!`
            ).trim();

            await enqueueWppMessage({ phone: digits, message: mensaje });
          }
        } catch (werr) {
          console.error('Error en enqueue WPP transferencia:', werr);
        }
      }

      res.json({ ok: true });
    } catch (e) {
      console.error('Error verificando transferencia:', e);
      res.status(500).json({ error: 'Error verificando transferencia' });
    }
  });

  // ELIMINAR
  router.delete('/:id', withAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        'SELECT id, empresa_id, archivo_path FROM comprobantes_transferencia WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2)',
        [id, esSuperUser ? null : Number(myEmpresa)]
      );
      if (!rows.length) return res.status(404).json({ error: 'Comprobante no encontrado' });

      const comp = rows[0];

      if (comp.archivo_path) {
        const fs = await import('node:fs');

        // archivo_path puede venir como:
        // - "tr-123.jpg"
        // - "/Transferencia/tr-123.jpg"
        // - "Transferencia/tr-123.jpg"
        // Para borrar en disco local, siempre usamos basename dentro de TRANSF_DIR.
        const rawPath = String(comp.archivo_path || '').trim();
        const safeName = path.basename(rawPath);
        const fullPath = path.join(TRANSF_DIR, safeName);

        if (safeName && fs.existsSync(fullPath)) {
          try {
            fs.unlinkSync(fullPath);
          } catch (e) {
            console.error('Error borrando archivo físico:', e);
          }
        }
      }

      await query(
        'DELETE FROM comprobantes_transferencia WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2)',
        [id, esSuperUser ? null : Number(myEmpresa)]
      );

      res.json({ ok: true });
    } catch (e) {
      console.error('Error eliminando transferencia:', e);
      res.status(500).json({ error: 'Error interno al eliminar' });
    }
  });

  return router;
}
