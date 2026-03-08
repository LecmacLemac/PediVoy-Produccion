// src/routes/productos.js
// Productos (CRUD) extraído desde server.js

import express from 'express';

export function createProductosRouter(deps) {
  const { query, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createProductosRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createProductosRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createProductosRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createProductosRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

  // GET /api/productos
  router.get('/', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      let empresaId = getEmpresaIdFromToken(req);
      if (esSuperAdmin && req.query?.empresa_id) {
        empresaId = Number(req.query.empresa_id);
      }

      const includeDeleted = esSuperAdmin && String(req.query?.include_deleted || '') === '1';
      if (!empresaId && !esSuperAdmin) return res.status(400).json({ error: 'Falta empresa' });

      const whereDeleted = includeDeleted ? '' : 'AND deleted_at IS NULL';

      const rows = await query(
        `
        SELECT
          id, empresa_id,
          nombre, descripcion, precio, imagen, imagen_2, imagen_3, activo,
          sku, external_id,
          stock_min, stock_max,
          retornable,
          categoria, orden,
          etiqueta, imagen_promo, mostrar_en_catalogo, mostrar_en_landing,
          config_activo, promo_config,
          created_at, updated_at, deleted_at
        FROM productos
        WHERE empresa_id = $1 ${whereDeleted}
        ORDER BY nombre ASC
        `,
        [empresaId]
      );

      return res.json(rows);
    } catch (e) {
      console.error('PRODUCTOS ERROR:', e);
      return res.status(500).json({ error: 'Error listando productos' });
    }
  });

  // POST /api/productos
  router.post('/', withAuth, async (req, res) => {
    try {
      const {
        nombre,
        descripcion,
        precio,
        imagen,
        imagen_2,
        imagen_3,
        empresa_id,
        stock_min,
        stock_max,
        categoria,
        orden,
        etiqueta,
        imagen_promo,
        mostrar_en_catalogo,
        mostrar_en_landing,
        sku,
        external_id,
        config_activo,
        promo_config,
        retornable,
      } = req.body || {};

      const esSuperAdmin = isSuper(req);
      const targetEmpresa = esSuperAdmin && empresa_id ? Number(empresa_id) : getEmpresaIdFromToken(req);
      if (!targetEmpresa) return res.status(400).json({ error: 'Falta empresa.' });

      const nombreOk = String(nombre || '').trim();
      if (!nombreOk) return res.status(400).json({ error: 'Falta nombre.' });

      const precioNum = Number(precio);
      if (!Number.isFinite(precioNum) || precioNum < 0) {
        return res.status(400).json({ error: 'Precio inválido.' });
      }

      const ordenNum = orden === undefined || orden === null || orden === '' ? null : Number(orden);

      const skuNorm = sku === undefined || sku === null ? null : String(sku).trim().toUpperCase();
      const skuFinal = skuNorm && skuNorm.length ? skuNorm : null;

      const externalNorm = external_id === undefined || external_id === null ? null : String(external_id).trim();
      const externalFinal = externalNorm && externalNorm.length ? externalNorm : null;

      const configActivo = config_activo === undefined ? null : config_activo;
      const promoConfig = promo_config === undefined ? null : promo_config;

      const uid = req.user?.uid ?? null;

      const rows = await query(
        `
        INSERT INTO productos (
          empresa_id,
          nombre, descripcion, precio, imagen, imagen_2, imagen_3, activo,
          sku, external_id,
          stock_min, stock_max,
          retornable,
          categoria, orden,
          etiqueta, imagen_promo, mostrar_en_catalogo, mostrar_en_landing,
          config_activo, promo_config,
          created_by, updated_by, updated_at
        )
        VALUES (
          $1,
          $2, $3, $4, $5, $6, $7, true,
          $8, $9,
          $10, $11,
          $12,
          $13, $14,
          $15, $16, $17, $18,
          $19, $20,
          $21, $22, NOW()
        )
        RETURNING id
        `,
        [
          targetEmpresa,
          nombreOk,
          descripcion ? String(descripcion) : null,
          precioNum,
          imagen ? String(imagen) : null,
          imagen_2 ? String(imagen_2) : null,
          imagen_3 ? String(imagen_3) : null,
          skuFinal,
          externalFinal,
          Number(stock_min || 0),
          Number(stock_max || 0),
          !!retornable,
          categoria ? String(categoria) : null,
          ordenNum,
          etiqueta ? String(etiqueta) : null,
          imagen_promo ? String(imagen_promo) : null,
          mostrar_en_catalogo !== undefined ? !!mostrar_en_catalogo : true,
          mostrar_en_landing !== undefined ? !!mostrar_en_landing : false,
          configActivo,
          promoConfig,
          uid,
          uid,
        ]
      );

      return res.json({ id: rows[0].id });
    } catch (e) {
      if (e?.code === '23505') {
        return res.status(409).json({ error: 'SKU o External ID ya existe para esta empresa.' });
      }
      console.error(e);
      return res.status(500).json({ error: 'Error creando producto' });
    }
  });

  // PUT /api/productos/:id
  router.put('/:id', withAuth, async (req, res) => {
    try {
      const {
        nombre,
        descripcion,
        precio,
        imagen,
        imagen_2,
        imagen_3,
        activo,
        stock_min,
        stock_max,
        categoria,
        orden,
        etiqueta,
        imagen_promo,
        mostrar_en_catalogo,
        mostrar_en_landing,
        sku,
        external_id,
        config_activo,
        promo_config,
        retornable,
        empresa_id,
      } = req.body || {};

      const esSuperAdmin = isSuper(req);

      let targetEmpresa = !esSuperAdmin ? getEmpresaIdFromToken(req) : null;
      if (esSuperAdmin && empresa_id) targetEmpresa = Number(empresa_id);

      if (esSuperAdmin && !targetEmpresa) {
        const r = await query(`SELECT empresa_id FROM productos WHERE id=$1`, [req.params.id]);
        if (!r.length) return res.status(404).json({ error: 'Producto no encontrado' });
        targetEmpresa = r[0].empresa_id;
      }

      if (!targetEmpresa && !esSuperAdmin) return res.status(400).json({ error: 'Falta empresa.' });

      const sets = [];
      const vals = [];
      let idx = 1;

      if (nombre !== undefined) {
        sets.push(`nombre=$${idx++}`);
        vals.push(String(nombre).trim());
      }
      if (descripcion !== undefined) {
        sets.push(`descripcion=$${idx++}`);
        vals.push(descripcion ? String(descripcion) : null);
      }
      if (precio !== undefined) {
        sets.push(`precio=$${idx++}`);
        vals.push(Number(precio));
      }
      if (imagen !== undefined) {
        sets.push(`imagen=$${idx++}`);
        vals.push(imagen ? String(imagen) : null);
      }
      if (imagen_2 !== undefined) {
        sets.push(`imagen_2=$${idx++}`);
        vals.push(imagen_2 ? String(imagen_2) : null);
      }
      if (imagen_3 !== undefined) {
        sets.push(`imagen_3=$${idx++}`);
        vals.push(imagen_3 ? String(imagen_3) : null);
      }
      if (activo !== undefined) {
        sets.push(`activo=$${idx++}`);
        vals.push(!!activo);
      }
      if (stock_min !== undefined) {
        sets.push(`stock_min=$${idx++}`);
        vals.push(Number(stock_min));
      }
      if (stock_max !== undefined) {
        sets.push(`stock_max=$${idx++}`);
        vals.push(Number(stock_max));
      }
      if (retornable !== undefined) {
        sets.push(`retornable=$${idx++}`);
        vals.push(!!retornable);
      }

      if (categoria !== undefined) {
        sets.push(`categoria=$${idx++}`);
        vals.push(categoria ? String(categoria) : null);
      }
      if (orden !== undefined) {
        const ordenNum = orden === null || orden === '' ? null : Number(orden);
        sets.push(`orden=$${idx++}`);
        vals.push(ordenNum);
      }

      if (etiqueta !== undefined) {
        sets.push(`etiqueta=$${idx++}`);
        vals.push(etiqueta ? String(etiqueta) : null);
      }
      if (imagen_promo !== undefined) {
        sets.push(`imagen_promo=$${idx++}`);
        vals.push(imagen_promo ? String(imagen_promo) : null);
      }
      if (mostrar_en_catalogo !== undefined) {
        sets.push(`mostrar_en_catalogo=$${idx++}`);
        vals.push(!!mostrar_en_catalogo);
      }
      if (mostrar_en_landing !== undefined) {
        sets.push(`mostrar_en_landing=$${idx++}`);
        vals.push(!!mostrar_en_landing);
      }

      if (config_activo !== undefined) {
        sets.push(`config_activo=$${idx++}`);
        vals.push(config_activo);
      }
      if (promo_config !== undefined) {
        sets.push(`promo_config=$${idx++}`);
        vals.push(promo_config);
      }

      if (sku !== undefined) {
        const skuNorm = sku === null ? null : String(sku).trim().toUpperCase();
        sets.push(`sku=$${idx++}`);
        vals.push(skuNorm && skuNorm.length ? skuNorm : null);
      }
      if (external_id !== undefined) {
        const extNorm = external_id === null ? null : String(external_id).trim();
        sets.push(`external_id=$${idx++}`);
        vals.push(extNorm && extNorm.length ? extNorm : null);
      }

      if (!sets.length) return res.json({ ok: true });

      const uid = req.user?.uid ?? null;
      sets.push(`updated_at=NOW()`);
      sets.push(`updated_by=$${idx++}`);
      vals.push(uid);

      vals.push(req.params.id);
      const idPos = idx++;
      vals.push(targetEmpresa);
      const empPos = idx++;

      const r = await query(
        `UPDATE productos
         SET ${sets.join(', ')}
         WHERE id=$${idPos} AND empresa_id=$${empPos} AND deleted_at IS NULL
         RETURNING id`,
        vals
      );

      if (!r.length) return res.status(404).json({ error: 'Producto no encontrado' });
      return res.json({ ok: true });
    } catch (e) {
      if (e?.code === '23505') {
        return res.status(409).json({ error: 'SKU o External ID ya existe para esta empresa.' });
      }
      console.error(e);
      return res.status(500).json({ error: 'Error actualizando producto' });
    }
  });

  // GET /api/productos/:id/promo-metrics
  router.get('/:id/promo-metrics', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      let targetEmpresa = !esSuperAdmin ? getEmpresaIdFromToken(req) : null;
      if (esSuperAdmin && req.query?.empresa_id) targetEmpresa = Number(req.query.empresa_id);

      if (esSuperAdmin && !targetEmpresa) {
        const prod = await query(`SELECT empresa_id FROM productos WHERE id=$1`, [req.params.id]);
        if (!prod.length) return res.status(404).json({ error: 'Producto no encontrado' });
        targetEmpresa = Number(prod[0].empresa_id);
      }

      if (!targetEmpresa) return res.status(400).json({ error: 'Falta empresa.' });

      const [totalRow] = await query(
        `SELECT COUNT(*)::int AS c, COUNT(DISTINCT punto_entrega_id)::int AS u
           FROM promociones_redenciones
          WHERE empresa_id = $1 AND trigger_producto_id = $2`,
        [targetEmpresa, req.params.id]
      );

      const [w7Row] = await query(
        `SELECT COUNT(*)::int AS c
           FROM promociones_redenciones
          WHERE empresa_id = $1
            AND trigger_producto_id = $2
            AND created_at >= NOW() - INTERVAL '7 days'`,
        [targetEmpresa, req.params.id]
      );

      const [w30Row] = await query(
        `SELECT COUNT(*)::int AS c
           FROM promociones_redenciones
          WHERE empresa_id = $1
            AND trigger_producto_id = $2
            AND created_at >= NOW() - INTERVAL '30 days'`,
        [targetEmpresa, req.params.id]
      );

      const [giftRow] = await query(
        `SELECT COUNT(*)::int AS c
           FROM promociones_redenciones
          WHERE empresa_id = $1
            AND trigger_producto_id = $2
            AND beneficio_producto_id IS NOT NULL`,
        [targetEmpresa, req.params.id]
      );

      const [discountRow] = await query(
        `SELECT COUNT(*)::int AS c
           FROM items_pedido ip
           JOIN pedidos p ON p.id = ip.pedido_id
          WHERE p.empresa_id = $1
            AND ip.producto ILIKE '🎟️ DESCUENTO PROMO:%'
            AND p.id IN (
              SELECT pedido_id
                FROM promociones_redenciones
               WHERE empresa_id = $1
                 AND trigger_producto_id = $2
                 AND pedido_id IS NOT NULL
            )`,
        [targetEmpresa, req.params.id]
      );

      return res.json({
        redemptions_total: Number(totalRow?.c || 0),
        unique_clients: Number(totalRow?.u || 0),
        redemptions_7d: Number(w7Row?.c || 0),
        redemptions_30d: Number(w30Row?.c || 0),
        gift_redemptions: Number(giftRow?.c || 0),
        discount_redemptions: Number(discountRow?.c || 0),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo métricas de promo' });
    }
  });

  // DELETE /api/productos/:id
  router.delete('/:id', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);

      let targetEmpresa = !esSuperAdmin ? getEmpresaIdFromToken(req) : null;
      if (esSuperAdmin && req.query?.empresa_id) targetEmpresa = Number(req.query.empresa_id);

      if (esSuperAdmin && !targetEmpresa) {
        const r = await query(`SELECT empresa_id FROM productos WHERE id=$1`, [req.params.id]);
        if (!r.length) return res.status(404).json({ error: 'Producto no encontrado' });
        targetEmpresa = r[0].empresa_id;
      }

      if (!targetEmpresa && !esSuperAdmin) return res.status(400).json({ error: 'Falta empresa.' });

      const hard = esSuperAdmin && String(req.query?.hard || '') === '1';
      if (hard) {
        const r = await query(`DELETE FROM productos WHERE id=$1 AND empresa_id=$2 RETURNING id`, [
          req.params.id,
          targetEmpresa,
        ]);
        if (!r.length) return res.status(404).json({ error: 'Producto no encontrado' });
        return res.json({ ok: true, hard: true });
      }

      const uid = req.user?.uid ?? null;
      const r = await query(
        `UPDATE productos
         SET deleted_at=NOW(), deleted_by=$1, activo=false, updated_at=NOW(), updated_by=$1
         WHERE id=$2 AND empresa_id=$3 AND deleted_at IS NULL
         RETURNING id`,
        [uid, req.params.id, targetEmpresa]
      );

      if (!r.length) return res.status(404).json({ error: 'Producto no encontrado' });
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'No se pudo eliminar (posiblemente en uso)' });
    }
  });

  return router;
}
