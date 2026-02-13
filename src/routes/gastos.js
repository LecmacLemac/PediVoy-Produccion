// src/routes/gastos.js
import express from 'express';
import multer from 'multer';
import path from 'path';

import { withAuth, checkLicencia, isSuper, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';

export function createGastosRouter({ GASTOS_DIR }) {
  if (!GASTOS_DIR) throw new Error('createGastosRouter requiere { GASTOS_DIR }');

  const router = express.Router();

  const gastosUploader = multer({
    storage: multer.diskStorage({
      destination: (_, __, cb) => cb(null, GASTOS_DIR),
      filename: (_, file, cb) => {
        const ext = path.extname(file.originalname || '') || '.bin';
        cb(null, `gasto-${Date.now()}${ext}`);
      }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_, file, cb) => {
      const ok = /image|pdf/.test(file.mimetype);
      cb(ok ? null : new Error('Tipo no permitido'), ok);
    }
  });

  // GET /api/gastos
  router.get('/', withAuth, checkLicencia, async (req, res) => {
    try {
      const { from, to, chofer_id, empresa_id } = req.query || {};
      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      let sql = `
        SELECT 
          g.*,
          c.nombre AS chofer_nombre
        FROM gastos_repartidor g
        LEFT JOIN choferes c ON g.chofer_id = c.id
        WHERE 1=1
      `;

      const params = [];
      let idx = 1;

      if (!esSuperUser) {
        sql += ` AND g.empresa_id = $${idx++}`;
        params.push(myEmpresa);
      } else if (empresa_id) {
        sql += ` AND g.empresa_id = $${idx++}`;
        params.push(Number(empresa_id));
      }

      if (chofer_id) {
        sql += ` AND g.chofer_id = $${idx++}`;
        params.push(Number(chofer_id));
      }

      if (from) {
        sql += ` AND g.fecha >= $${idx++}::date`;
        params.push(from.toString().slice(0, 10));
      }
      if (to) {
        sql += ` AND g.fecha <= $${idx++}::date`;
        params.push(to.toString().slice(0, 10));
      }

      sql += ` ORDER BY g.fecha DESC, g.id DESC LIMIT 200`;

      const rows = await query(sql, params);
      return res.json(rows);
    } catch (e) {
      console.error('Error cargando gastos:', e);
      return res.status(500).json({ error: 'Error cargando gastos' });
    }
  });

  // POST /api/gastos (multipart: comprobante)
  router.post('/', withAuth, gastosUploader.single('comprobante'), async (req, res) => {
    try {
      const {
        fecha, tipo, descripcion, cantidad, producto_id, monto,
        empresa_id, chofer_id
      } = req.body;

      const file = req.file;
      const esSuperUser = isSuper(req);

      const targetEmpresa = (esSuperUser && empresa_id) ? empresa_id : getEmpresaIdFromToken(req);
      let targetChofer = chofer_id;
      if (!targetChofer && req.user.chofer_id) targetChofer = req.user.chofer_id;

      if (!targetEmpresa || !targetChofer) {
        return res.status(400).json({ error: 'Faltan datos de empresa o chofer' });
      }

      await query(
        `
        INSERT INTO gastos_repartidor (
            empresa_id, chofer_id, fecha, tipo, descripcion,
            monto, comprobante_path, cantidad, producto_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          targetEmpresa,
          targetChofer,
          fecha || new Date().toISOString(),
          tipo,
          descripcion,
          monto || 0,
          file ? file.filename : null,
          cantidad ? Number(cantidad) : null,
          producto_id ? Number(producto_id) : null
        ]
      );

      // Si el chofer carga mercadería, impactamos stock físico.
      if (producto_id && cantidad && (tipo === 'carga_llenos' || tipo === 'compra_mercaderia')) {
        const qtyNum = Number(cantidad);

        await query(
          `
          INSERT INTO chofer_stock_mov 
            (empresa_id, chofer_id, producto_id, fecha, tipo, cantidad, referencia, created_at)
          VALUES ($1, $2, $3, $4, 'INGRESO_GASTOS', $5, $6, NOW())
          `,
          [
            targetEmpresa,
            targetChofer,
            producto_id,
            fecha || new Date().toISOString(),
            qtyNum,
            `Carga desde Gastos: ${descripcion || tipo}`
          ]
        );

        await query(
          `
          INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (empresa_id, chofer_id, producto_id)
          DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
          `,
          [targetEmpresa, targetChofer, producto_id, qtyNum]
        );
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR POST GASTOS:', e);
      return res.status(500).json({ error: 'Error guardando gasto' });
    }
  });

  // PUT /api/gastos/:id (multipart: comprobante)
  router.put('/:id', withAuth, gastosUploader.single('comprobante'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });

      const role = (req.user?.role || '').toLowerCase();
      const esSuperUser = isSuper(req);
      const esUserRole = role === 'user';

      if (!(esSuperUser || esUserRole)) return res.status(403).json({ error: 'No autorizado' });

      const rows0 = await query(
        `
        SELECT id, empresa_id, chofer_id, fecha, tipo, descripcion, monto, comprobante_path, cantidad, producto_id
        FROM gastos_repartidor
        WHERE id = $1
        LIMIT 1
        `,
        [id]
      );

      if (!rows0.length) return res.status(404).json({ error: 'Gasto no encontrado' });

      const g0 = rows0[0];

      const myEmpresa = getEmpresaIdFromToken(req);
      if (!esSuperUser && Number(g0.empresa_id) !== Number(myEmpresa)) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const {
        fecha,
        tipo,
        descripcion,
        monto,
        empresa_id,
        chofer_id,
        cantidad,
        producto_id
      } = req.body || {};

      const targetEmpresa = (esSuperUser && empresa_id) ? Number(empresa_id) : Number(g0.empresa_id);
      const targetChofer = (chofer_id ? Number(chofer_id) : Number(g0.chofer_id));

      const fechaDate = (fecha ? String(fecha).slice(0, 10) : String(g0.fecha).slice(0, 10));

      const newTipo = tipo || g0.tipo;
      const newDesc = (descripcion !== undefined) ? descripcion : g0.descripcion;

      const newMonto = (monto !== undefined && monto !== null && monto !== '')
        ? Number(monto)
        : Number(g0.monto || 0);

      const newCantidad = (cantidad === undefined || cantidad === null || cantidad === '')
        ? null
        : Number(cantidad);

      const newProductoId = (producto_id === undefined || producto_id === null || producto_id === '')
        ? null
        : Number(producto_id);

      const newComprobantePath = req.file ? req.file.filename : g0.comprobante_path;

      await query(
        `
        UPDATE gastos_repartidor
        SET empresa_id = $1,
            chofer_id = $2,
            fecha = $3::date,
            tipo = $4,
            descripcion = $5,
            monto = $6,
            comprobante_path = $7,
            cantidad = $8,
            producto_id = $9
        WHERE id = $10
        `,
        [
          targetEmpresa,
          targetChofer,
          fechaDate,
          newTipo,
          newDesc,
          newMonto,
          newComprobantePath,
          newCantidad,
          newProductoId,
          id
        ]
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR PUT GASTOS:', e);
      return res.status(500).json({ error: 'Error actualizando gasto' });
    }
  });

  // DELETE /api/gastos/:id
  router.delete('/:id', withAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });

      const role = (req.user?.role || '').toLowerCase();
      const esSuperUser = isSuper(req);
      const esUserRole = role === 'user';

      if (!(esSuperUser || esUserRole)) return res.status(403).json({ error: 'No autorizado' });

      const myEmpresa = getEmpresaIdFromToken(req);

      const rows0 = await query(
        `SELECT id, empresa_id FROM gastos_repartidor WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2) LIMIT 1`,
        [id, esSuperUser ? null : Number(myEmpresa)]
      );
      if (!rows0.length) return res.status(404).json({ error: 'Gasto no encontrado' });

      await query(
        `DELETE FROM gastos_repartidor WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2)`,
        [id, esSuperUser ? null : Number(myEmpresa)]
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR DELETE GASTOS:', e);
      return res.status(500).json({ error: 'Error borrando gasto' });
    }
  });

  return router;
}
