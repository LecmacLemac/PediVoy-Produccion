// src/routes/transferencias.js
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { withAuth, isSuper, getEmpresaIdFromToken, enqueueWppMessage } from '../services.js';
import { query } from '../db.js';

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

  // LISTAR TRANSFERENCIAS
  router.get('/', withAuth, async (req, res) => {
    try {
      const { empresa_id } = req.query || {};
      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const fecha = (req.query.fecha || '').toString().slice(0, 10);

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
          ct.banco_origen,
          ct.nro_operacion,
          z.nombre AS zona_nombre,
          pe.cliente,
          pe.telefono
        FROM comprobantes_transferencia ct
        LEFT JOIN pedidos p           ON p.id = ct.pedido_id
        LEFT JOIN puntos_entrega pe   ON pe.id = p.punto_entrega_id
        LEFT JOIN zonas_geograficas z ON z.id = ct.zona_id
        WHERE 1=1
      `;

      const params = [];
      let idx = 1;

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
      }

      sql += ` ORDER BY ct.fecha DESC, ct.id DESC`;

      const rows = await query(sql, params);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: 'Error listando transferencias' });
    }
  });

  // SUBIR COMPROBANTE
  router.post(
    '/upload',
    withAuth,
    transferUploader.single('comprobante'),
    async (req, res) => {
      try {
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
        const archivoPath = filename;
        const comprobantePath = `/Transferencia/${filename}`;

        const metodo = (ped.metodo_pago || 'transferencia').toString().toLowerCase();
        const monto = Number(ped.monto || 0) || 0;

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
            created_at,
            updated_at,
            validado
          )
          VALUES (
            $1, $2, NOW(), $3, $4, $5,
            $6, $7, $8, $9,
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
            validado
        `, [
          ped.empresa_id,
          choferId,
          monto,
          metodo,
          body.comentario || null,
          archivoPath,
          pedidoId,
          ped.zona_id || null,
          comprobantePath
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
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'id inválido' });
      }

      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);
      const enviarAviso = String(req.query.enviarAviso || '').trim() === '1';

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

      await query(
        `UPDATE comprobantes_transferencia
         SET validado = 1,
             updated_at = NOW()
         WHERE id = $1
           AND ($2::int IS NULL OR empresa_id = $2)`,
        [id, esSuperUser ? null : Number(myEmpresa)]
      );

      const monto = Number(ct.monto ?? ct.pedido_monto ?? 0) || 0;
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
        const fullPath = path.join(TRANSF_DIR, comp.archivo_path);
        if (fs.existsSync(fullPath)) {
          try { fs.unlinkSync(fullPath); } catch (e) { console.error('Error borrando archivo físico:', e); }
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
