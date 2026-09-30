// src/routes/productos.js
// Productos (CRUD) extraído desde server.js

import express from 'express';
import {
  lockProductIdentityNamespaces,
  normalizeProductIdentityName,
} from '../services/productIdentityNamespace.js';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';

export function createProductosRouter(deps) {
  const { query, withTransaction, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createProductosRouter: falta query(fn)');
  if (typeof withTransaction !== 'function') throw new Error('createProductosRouter: falta withTransaction(fn)');
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
          retornable, stock_infinito,
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
  router.post('/', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
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

      const rows = await withTransaction(async txQuery => {
        await lockProductIdentityNamespaces(txQuery, { empresaId: targetEmpresa, names: [nombreOk] });
        return txQuery(
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
      });

      return res.json({ id: rows[0].id });
    } catch (e) {
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({
          error: 'Resultado de creación de producto indeterminado',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
      }
      if (e?.code === '23505') {
        return res.status(409).json({ error: 'SKU o External ID ya existe para esta empresa.' });
      }
      console.error(e);
      return res.status(500).json({ error: 'Error creando producto' });
    }
  });

  // PUT /api/productos/:id
  router.put('/:id', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
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
        stock_infinito,
        empresa_id,
      } = req.body || {};

      const esSuperAdmin = isSuper(req);

      let targetEmpresa = !esSuperAdmin ? getEmpresaIdFromToken(req) : null;
      if (esSuperAdmin && empresa_id) targetEmpresa = Number(empresa_id);
      if (!targetEmpresa && !esSuperAdmin) return res.status(400).json({ error: 'Falta empresa.' });
      if (stock_infinito !== undefined && typeof stock_infinito !== 'boolean') {
        return res.status(400).json({ error: 'stock_infinito inválido.' });
      }

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
      if (stock_infinito !== undefined) {
        sets.push(`stock_infinito=$${idx++}`);
        vals.push(stock_infinito);
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

      await withTransaction(async txQuery => {
        // Orden global para identidad de producto: namespace(s) -> fila de producto.
        // La prelectura sólo construye el set; la fila se relee y valida tras los locks.
        const observed = await txQuery(
          `SELECT id, empresa_id, nombre
             FROM productos
            WHERE id = $1
              AND ($2::int IS NULL OR empresa_id = $2)
              AND deleted_at IS NULL`,
          [req.params.id, targetEmpresa]
        );
        if (observed.length !== 1) {
          const error = new Error('Producto no encontrado');
          error.statusCode = 404;
          throw error;
        }
        const observedProduct = observed[0];
        const lockedEmpresa = Number(observedProduct.empresa_id);
        await lockProductIdentityNamespaces(txQuery, {
          empresaId: lockedEmpresa,
          names: [observedProduct.nombre, nombre === undefined ? observedProduct.nombre : String(nombre).trim()],
        });
        const productos = await txQuery(
          `SELECT id, empresa_id, nombre
             FROM productos
            WHERE id = $1
              AND empresa_id = $2
              AND deleted_at IS NULL
            FOR UPDATE`,
          [req.params.id, lockedEmpresa]
        );
        if (productos.length !== 1
            || normalizeProductIdentityName(productos[0].nombre)
              !== normalizeProductIdentityName(observedProduct.nombre)) {
          const error = new Error('Producto cambió durante la actualización');
          error.statusCode = 409;
          throw error;
        }
        const updateVals = [...vals, req.params.id, lockedEmpresa];
        const idPos = idx;
        const empPos = idx + 1;
        const updated = await txQuery(
          `UPDATE productos
              SET ${sets.join(', ')}
            WHERE id = $${idPos}
              AND empresa_id = $${empPos}
              AND deleted_at IS NULL
          RETURNING id`,
          updateVals
        );
        if (updated.length !== 1) {
          const error = new Error('Producto cambió durante la actualización');
          error.statusCode = 409;
          throw error;
        }
      });
      return res.json({ ok: true });
    } catch (e) {
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({
          error: 'Resultado de actualización de producto indeterminado',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
      }
      if (Number.isInteger(e?.statusCode)) return res.status(e.statusCode).json({ error: e.message });
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
  router.delete('/:id', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);

      let targetEmpresa = !esSuperAdmin ? getEmpresaIdFromToken(req) : null;
      if (esSuperAdmin && req.query?.empresa_id) targetEmpresa = Number(req.query.empresa_id);

      if (!targetEmpresa && !esSuperAdmin) return res.status(400).json({ error: 'Falta empresa.' });

      const hard = esSuperAdmin && String(req.query?.hard || '') === '1';
      const uid = req.user?.uid ?? null;
      await withTransaction(async txQuery => {
        const observed = await txQuery(
          `SELECT id, empresa_id, nombre
             FROM productos
            WHERE id = $1
              AND ($2::int IS NULL OR empresa_id = $2)
              AND deleted_at IS NULL`,
          [req.params.id, targetEmpresa]
        );
        if (observed.length !== 1) {
          const error = new Error('Producto no encontrado');
          error.statusCode = 404;
          throw error;
        }
        const observedProduct = observed[0];
        const lockedEmpresa = Number(observedProduct.empresa_id);
        await lockProductIdentityNamespaces(txQuery, {
          empresaId: lockedEmpresa,
          names: [observedProduct.nombre],
        });
        const productos = await txQuery(
          `SELECT id, empresa_id, nombre
             FROM productos
            WHERE id = $1
              AND empresa_id = $2
              AND deleted_at IS NULL
            FOR UPDATE`,
          [req.params.id, lockedEmpresa]
        );
        if (productos.length !== 1
            || normalizeProductIdentityName(productos[0].nombre)
              !== normalizeProductIdentityName(observedProduct.nombre)) {
          const error = new Error('Producto cambió durante la eliminación');
          error.statusCode = 409;
          throw error;
        }
        const changed = hard
          ? await txQuery(
              'DELETE FROM productos WHERE id = $1 AND empresa_id = $2 RETURNING id',
              [req.params.id, lockedEmpresa]
            )
          : await txQuery(
              `UPDATE productos
                  SET deleted_at = NOW(), deleted_by = $1, activo = false,
                      updated_at = NOW(), updated_by = $1
                WHERE id = $2
                  AND empresa_id = $3
                  AND deleted_at IS NULL
              RETURNING id`,
              [uid, req.params.id, lockedEmpresa]
            );
        if (changed.length !== 1) {
          const error = new Error('Producto cambió durante la eliminación');
          error.statusCode = 409;
          throw error;
        }
      });
      return res.json(hard ? { ok: true, hard: true } : { ok: true });
    } catch (e) {
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({
          error: 'Resultado de eliminación de producto indeterminado',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
      }
      if (Number.isInteger(e?.statusCode)) return res.status(e.statusCode).json({ error: e.message });
      console.error(e);
      return res.status(500).json({ error: 'No se pudo eliminar (posiblemente en uso)' });
    }
  });

  return router;
}
