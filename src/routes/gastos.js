// src/routes/gastos.js
import express from 'express';
import multer from 'multer';
import path from 'path';

import { withAuth, checkLicencia, isSuper, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';

export function createGastosRouter({ GASTOS_DIR }) {
  if (!GASTOS_DIR) throw new Error('createGastosRouter requiere { GASTOS_DIR }');

  const router = express.Router();

  const ensureDepositoRefPromise = (async () => {
    try {
      await query(`ALTER TABLE chofer_stock_mov ADD COLUMN IF NOT EXISTS deposito_id INTEGER`);
      await query(`
        CREATE TABLE IF NOT EXISTS deposito_chofer (
          id SERIAL PRIMARY KEY,
          empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
          deposito_id INTEGER NOT NULL REFERENCES depositos(id) ON DELETE CASCADE,
          chofer_id INTEGER NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
          activo BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (empresa_id, deposito_id, chofer_id)
        )
      `);
    } catch (e) {
      console.warn('gastos/deposito schema warning:', e?.message || e);
    }
  })();

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
      await ensureDepositoRefPromise;
      const {
        fecha, tipo, descripcion, cantidad, producto_id, monto,
        empresa_id, chofer_id, deposito_id
      } = req.body;

      const file = req.file;
      const esSuperUser = isSuper(req);

      const targetEmpresa = (esSuperUser && empresa_id) ? empresa_id : getEmpresaIdFromToken(req);
      let targetChofer = chofer_id;
      if (!targetChofer && req.user.chofer_id) targetChofer = req.user.chofer_id;

      if (!targetEmpresa || !targetChofer) {
        return res.status(400).json({ error: 'Faltan datos de empresa o chofer' });
      }

      const tipoOp = String(tipo || '').trim();
      const esMovimientoRetornable = tipoOp === 'carga_llenos' || tipoOp === 'descarga_vacios';

      const cantidadNum = (cantidad === undefined || cantidad === null || cantidad === '') ? null : Number(cantidad);
      const productoIdNum = (producto_id === undefined || producto_id === null || producto_id === '') ? null : Number(producto_id);
      const depositoId = (deposito_id === undefined || deposito_id === null || deposito_id === '') ? null : Number(deposito_id);

      if (esMovimientoRetornable) {
        if (!productoIdNum || !Number.isFinite(productoIdNum) || productoIdNum <= 0) {
          return res.status(400).json({ error: 'Producto requerido para movimientos de retornables.' });
        }
        if (!cantidadNum || !Number.isFinite(cantidadNum) || cantidadNum <= 0) {
          return res.status(400).json({ error: 'Cantidad requerida para movimientos de retornables.' });
        }

        const pr = await query(
          `SELECT id
             FROM productos
            WHERE id = $1
              AND empresa_id = $2
              AND COALESCE(retornable, false) = true
              AND deleted_at IS NULL
            LIMIT 1`,
          [productoIdNum, targetEmpresa]
        );

        if (!pr.length) {
          return res.status(400).json({ error: 'El producto no es retornable o no pertenece a la empresa.' });
        }
      }

      if (depositoId && (tipoOp === 'carga_llenos' || tipoOp === 'compra_mercaderia')) {
        const depRows = await query(
          `SELECT id FROM depositos WHERE id = $1 AND empresa_id = $2 AND activo = TRUE LIMIT 1`,
          [depositoId, targetEmpresa]
        );
        if (!depRows.length) {
          return res.status(400).json({ error: 'Depósito inválido para la empresa' });
        }

        const cfgRows = await query(
          `SELECT COUNT(*)::int AS c
             FROM deposito_chofer
            WHERE empresa_id = $1
              AND chofer_id = $2
              AND activo = TRUE`,
          [targetEmpresa, Number(targetChofer)]
        );
        const cfgCount = Number(cfgRows?.[0]?.c || 0);
        if (cfgCount > 0) {
          const okRows = await query(
            `SELECT 1
               FROM deposito_chofer
              WHERE empresa_id = $1
                AND chofer_id = $2
                AND deposito_id = $3
                AND activo = TRUE
              LIMIT 1`,
            [targetEmpresa, Number(targetChofer), depositoId]
          );
          if (!okRows.length) {
            return res.status(403).json({ error: 'Chofer no habilitado para ese depósito' });
          }
        }
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
          cantidadNum,
          productoIdNum
        ]
      );

      // Si el chofer carga mercadería, impactamos stock físico.
      if (productoIdNum && cantidadNum && (tipoOp === 'carga_llenos' || tipoOp === 'compra_mercaderia')) {
        const qtyNum = Number(cantidadNum);

        await query(
          `
          INSERT INTO chofer_stock_mov 
            (empresa_id, chofer_id, producto_id, deposito_id, fecha, tipo, cantidad, referencia, created_at)
          VALUES ($1, $2, $3, $4, $5, 'INGRESO_GASTOS', $6, $7, NOW())
          `,
          [
            targetEmpresa,
            targetChofer,
            productoIdNum,
            depositoId,
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
          [targetEmpresa, targetChofer, productoIdNum, qtyNum]
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
