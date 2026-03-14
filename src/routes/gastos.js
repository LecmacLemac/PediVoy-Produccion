// src/routes/gastos.js
import express from 'express';
import multer from 'multer';
import path from 'path';

import { withAuth, checkLicencia, isSuper, isRepartidor, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';

export function createGastosRouter({ GASTOS_DIR }) {
  if (!GASTOS_DIR) throw new Error('createGastosRouter requiere { GASTOS_DIR }');

  const router = express.Router();

  const ensureDepositoRefPromise = (async () => {
    try {
      await query(`ALTER TABLE chofer_stock_mov ADD COLUMN IF NOT EXISTS deposito_id INTEGER`);
      await query(`ALTER TABLE chofer_stock_mov ADD COLUMN IF NOT EXISTS gasto_id INTEGER`);
      await query(`ALTER TABLE gastos_repartidor ADD COLUMN IF NOT EXISTS deposito_id INTEGER`);
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

  const isStockIngresoFromGasto = (row) => {
    const tipo = String(row?.tipo || '').toLowerCase();
    const qty = Number(row?.cantidad || 0);
    const pid = Number(row?.producto_id || 0);
    return (tipo === 'carga_llenos' || tipo === 'compra_mercaderia') && qty > 0 && pid > 0;
  };

  async function applyStockIngresoFromGasto({ empresaId, choferId, productoId, depositoId, fecha, cantidad, descripcion, gastoId }) {
    const qtyNum = Number(cantidad || 0);
    if (!qtyNum || qtyNum <= 0) return;

    await query(
      `
      INSERT INTO chofer_stock_mov 
        (empresa_id, chofer_id, producto_id, deposito_id, gasto_id, fecha, tipo, cantidad, referencia, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'INGRESO_GASTOS', $7, $8, NOW())
      `,
      [
        Number(empresaId),
        Number(choferId),
        Number(productoId),
        (depositoId === undefined || depositoId === null || depositoId === '') ? null : Number(depositoId),
        Number(gastoId),
        fecha || new Date().toISOString(),
        qtyNum,
        `Carga desde Gastos: ${descripcion || 'carga_llenos'}`
      ]
    );

    await query(
      `
      INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (empresa_id, chofer_id, producto_id)
      DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
      `,
      [Number(empresaId), Number(choferId), Number(productoId), qtyNum]
    );
  }

  async function revertStockIngresoFromGasto({ empresaId, choferId, productoId, cantidad, gastoId }) {
    const qtyNum = Number(cantidad || 0);
    if (!qtyNum || qtyNum <= 0) return;

    await query(
      `
      UPDATE chofer_stock
         SET cantidad = COALESCE(cantidad, 0) - $4
       WHERE empresa_id = $1
         AND chofer_id = $2
         AND producto_id = $3
      `,
      [Number(empresaId), Number(choferId), Number(productoId), qtyNum]
    );

    await query(`DELETE FROM chofer_stock_mov WHERE gasto_id = $1`, [Number(gastoId)]);
  }

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
      await ensureDepositoRefPromise;
      const { from, to, chofer_id, empresa_id } = req.query || {};
      const esSuperUser = isSuper(req);
      const esRepartidorUser = isRepartidor(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      let sql = `
        SELECT 
          g.*,
          c.nombre AS chofer_nombre,
          COALESCE(d.nombre, dmv.nombre) AS deposito_nombre
        FROM gastos_repartidor g
        LEFT JOIN choferes c ON g.chofer_id = c.id
        LEFT JOIN depositos d ON d.id = g.deposito_id
        LEFT JOIN LATERAL (
          SELECT m.deposito_id
          FROM chofer_stock_mov m
          WHERE m.empresa_id = g.empresa_id
            AND m.chofer_id = g.chofer_id
            AND m.tipo = 'INGRESO_GASTOS'
            AND m.fecha::date = g.fecha::date
            AND COALESCE(m.producto_id, 0) = COALESCE(g.producto_id, 0)
            AND COALESCE(m.cantidad, 0)::numeric = COALESCE(g.cantidad, 0)::numeric
            AND m.referencia = ('Carga desde Gastos: ' || COALESCE(g.descripcion, ''))
            AND m.deposito_id IS NOT NULL
          ORDER BY m.id DESC
          LIMIT 1
        ) md ON TRUE
        LEFT JOIN depositos dmv ON dmv.id = md.deposito_id
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

      // Repartidor: siempre ve su propio historial (evita depender de chofer_id enviado por front)
      if (esRepartidorUser) {
        const myChoferId = Number(req.user?.chofer_id || 0);
        if (!myChoferId) {
          return res.status(400).json({ error: 'Usuario repartidor sin chofer_id asociado' });
        }
        sql += ` AND g.chofer_id = $${idx++}`;
        params.push(myChoferId);
      } else if (chofer_id) {
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
  router.post('/', withAuth, checkLicencia, gastosUploader.single('comprobante'), async (req, res) => {
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

      const inserted = await query(
        `
        INSERT INTO gastos_repartidor (
            empresa_id, chofer_id, fecha, tipo, descripcion,
            monto, comprobante_path, cantidad, producto_id, deposito_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id
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
          productoIdNum,
          depositoId
        ]
      );
      const gastoId = Number(inserted?.[0]?.id || 0);

      // Si el chofer carga mercadería, impactamos stock físico.
      if (gastoId && productoIdNum && cantidadNum && (tipoOp === 'carga_llenos' || tipoOp === 'compra_mercaderia')) {
        await applyStockIngresoFromGasto({
          empresaId: targetEmpresa,
          choferId: targetChofer,
          productoId: productoIdNum,
          depositoId,
          fecha: fecha || new Date().toISOString(),
          cantidad: cantidadNum,
          descripcion: descripcion || tipo,
          gastoId
        });
      }

      return res.json({ ok: true, id: gastoId });
    } catch (e) {
      console.error('ERROR POST GASTOS:', e);
      return res.status(500).json({ error: 'Error guardando gasto' });
    }
  });

  // PUT /api/gastos/:id (multipart: comprobante)
  router.put('/:id', withAuth, checkLicencia, gastosUploader.single('comprobante'), async (req, res) => {
    try {
      await ensureDepositoRefPromise;
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });

      const role = (req.user?.role || '').toLowerCase();
      const esSuperUser = isSuper(req);
      const esUserRole = role === 'user';
      const esRepartidorUser = role === 'repartidor';

      if (!(esSuperUser || esUserRole || esRepartidorUser)) return res.status(403).json({ error: 'No autorizado' });

      const rows0 = await query(
        `
        SELECT id, empresa_id, chofer_id, fecha, tipo, descripcion, monto, comprobante_path, cantidad, producto_id, deposito_id
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
      if (esRepartidorUser) {
        const myChoferId = Number(req.user?.chofer_id || 0);
        if (!myChoferId || Number(g0.chofer_id) !== myChoferId) {
          return res.status(403).json({ error: 'Solo podés editar tus propios movimientos' });
        }
      }

      const {
        fecha,
        tipo,
        descripcion,
        monto,
        empresa_id,
        chofer_id,
        cantidad,
        producto_id,
        deposito_id
      } = req.body || {};

      const targetEmpresa = (esSuperUser && empresa_id) ? Number(empresa_id) : Number(g0.empresa_id);
      const targetChofer = esRepartidorUser
        ? Number(req.user?.chofer_id || g0.chofer_id)
        : (chofer_id ? Number(chofer_id) : Number(g0.chofer_id));

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

      const newDepositoId = (deposito_id === undefined || deposito_id === null || deposito_id === '')
        ? g0.deposito_id
        : Number(deposito_id);

      const newComprobantePath = req.file ? req.file.filename : g0.comprobante_path;

      const newTipoNorm = String(newTipo || '').toLowerCase();
      const newEsRet = newTipoNorm === 'carga_llenos' || newTipoNorm === 'descarga_vacios';
      if (newEsRet) {
        if (!newProductoId || !Number.isFinite(newProductoId) || newProductoId <= 0) {
          return res.status(400).json({ error: 'Producto requerido para movimientos de retornables.' });
        }
        if (!newCantidad || !Number.isFinite(newCantidad) || newCantidad <= 0) {
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
          [newProductoId, targetEmpresa]
        );
        if (!pr.length) {
          return res.status(400).json({ error: 'El producto no es retornable o no pertenece a la empresa.' });
        }
      }

      if (newDepositoId && (newTipoNorm === 'carga_llenos' || newTipoNorm === 'compra_mercaderia')) {
        const depRows = await query(
          `SELECT id FROM depositos WHERE id = $1 AND empresa_id = $2 AND activo = TRUE LIMIT 1`,
          [newDepositoId, targetEmpresa]
        );
        if (!depRows.length) return res.status(400).json({ error: 'Depósito inválido para la empresa' });

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
            [targetEmpresa, Number(targetChofer), Number(newDepositoId)]
          );
          if (!okRows.length) return res.status(403).json({ error: 'Chofer no habilitado para ese depósito' });
        }
      }

      const oldNeedsStock = isStockIngresoFromGasto(g0);
      const newNeedsStock = isStockIngresoFromGasto({ tipo: newTipoNorm, cantidad: newCantidad, producto_id: newProductoId });

      if (oldNeedsStock) {
        await revertStockIngresoFromGasto({
          empresaId: g0.empresa_id,
          choferId: g0.chofer_id,
          productoId: g0.producto_id,
          cantidad: g0.cantidad,
          gastoId: id
        });
      }

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
            producto_id = $9,
            deposito_id = $10
        WHERE id = $11
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
          newDepositoId,
          id
        ]
      );

      if (newNeedsStock) {
        await applyStockIngresoFromGasto({
          empresaId: targetEmpresa,
          choferId: targetChofer,
          productoId: newProductoId,
          depositoId: newDepositoId,
          fecha: fechaDate,
          cantidad: newCantidad,
          descripcion: newDesc || newTipo,
          gastoId: id
        });
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR PUT GASTOS:', e);
      return res.status(500).json({ error: 'Error actualizando gasto' });
    }
  });

  // DELETE /api/gastos/:id
  router.delete('/:id', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureDepositoRefPromise;
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });

      const role = (req.user?.role || '').toLowerCase();
      const esSuperUser = isSuper(req);
      const esUserRole = role === 'user';
      const esRepartidorUser = role === 'repartidor';

      if (!(esSuperUser || esUserRole || esRepartidorUser)) return res.status(403).json({ error: 'No autorizado' });

      const myEmpresa = getEmpresaIdFromToken(req);

      const rows0 = await query(
        `SELECT id, empresa_id, chofer_id, tipo, cantidad, producto_id FROM gastos_repartidor WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2) LIMIT 1`,
        [id, esSuperUser ? null : Number(myEmpresa)]
      );
      if (!rows0.length) return res.status(404).json({ error: 'Gasto no encontrado' });

      if (esRepartidorUser) {
        const myChoferId = Number(req.user?.chofer_id || 0);
        if (!myChoferId || Number(rows0[0].chofer_id) !== myChoferId) {
          return res.status(403).json({ error: 'Solo podés borrar tus propios movimientos' });
        }
      }

      const g0 = rows0[0];
      if (isStockIngresoFromGasto(g0)) {
        await revertStockIngresoFromGasto({
          empresaId: g0.empresa_id,
          choferId: g0.chofer_id,
          productoId: g0.producto_id,
          cantidad: g0.cantidad,
          gastoId: id
        });
      }

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
