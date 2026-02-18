import { z } from 'zod';
import { armarMensajeConfirmado } from '../utils.js';
import { ejecutarEstrategiaVecinos } from '../estrategias.js';

const RATE_LIMIT_WINDOW_MS = Number(process.env.PUBLIC_PEDIDOS_RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.PUBLIC_PEDIDOS_RATE_LIMIT_MAX || 20);
const PUBLIC_PEDIDOS_MAX_BODY_BYTES = Number(process.env.PUBLIC_PEDIDOS_MAX_BODY_BYTES || 256 * 1024);
const rateLimitState = new Map();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(req) {
  const now = Date.now();
  const key = clientIp(req);
  const current = rateLimitState.get(key);

  if (!current || now > current.resetAt) {
    const next = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitState.set(key, next);
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetAt: next.resetAt };
  }

  current.count += 1;
  if (current.count > RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetAt: current.resetAt };
  }

  return { allowed: true, remaining: Math.max(0, RATE_LIMIT_MAX - current.count), resetAt: current.resetAt };
}

const createPedidoSchema = z.object({
  empresa_id: z.coerce.number().int().positive().optional(),
  cliente: z.string().trim().min(2, 'cliente es requerido'),
  telefono: z.string().trim().min(6, 'telefono es requerido'),
  direccion: z.string().trim().min(3, 'direccion es requerida'),
  ciudad: z.string().trim().optional(),
  provincia: z.string().trim().optional(),
  pais: z.string().trim().optional(),
  latitud: z.union([z.number(), z.string()]).optional(),
  longitud: z.union([z.number(), z.string()]).optional(),
  notas: z.string().optional(),
  metodo_pago: z.string().optional(),
  submission_id: z.union([z.string(), z.number()]).optional(),
  referral_code: z.string().optional(),
  items: z.array(z.object({
    producto: z.string().trim().min(1),
    cantidad: z.coerce.number().positive(),
    precio_unitario: z.coerce.number().nonnegative(),
  })).min(1, 'items es requerido y no puede estar vacío'),
});

export function registerPublicLegacyCreatePedidoRoute(app, deps) {
  const {
    query,
    pool,
    geocodeIfNeeded,
    normalizePhone,
    pointInAnyZone,
    enqueueWppMessage,
    toNum,
    inRange,
    round,
    buildOrderSummary,
    getAliasEmpresa,
    ejecutarEstrategiaVecinosFn = ejecutarEstrategiaVecinos,
  } = deps;

  const DEBUG_ORDERS = process.env.DEBUG_ORDERS === '1' && process.env.NODE_ENV !== 'test';
  const tStart = (label) => { if (DEBUG_ORDERS) console.time(label); };
  const tEnd = (label) => { if (DEBUG_ORDERS) console.timeEnd(label); };

  app.post('/public/pedidos', async (req, res) => {
    const txClient = pool ? await pool.connect() : null;
    const txQuery = async (sql, params = []) => {
      if (!txClient) return query(sql, params);
      const result = await txClient.query(sql, params);
      return result.rows;
    };
    const reqId = `ped-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const log = (...a) => DEBUG_ORDERS && console.log('[public/pedidos]', reqId, '-', ...a);
    const errlog = (...a) => console.error('[public/pedidos]', reqId, '-', ...a);

    res.set('x-request-id', reqId);
    tStart(`[public/pedidos] ${reqId} TOTAL`);

    let txFinished = false;
    const rollbackIfNeeded = async () => {
      if (!txClient || txFinished) return;
      await txClient.query('ROLLBACK');
      txFinished = true;
    };

    try {
      if (txClient) await txClient.query('BEGIN');

      const contentLength = Number(req.headers['content-length'] || 0);
      if (Number.isFinite(contentLength) && contentLength > PUBLIC_PEDIDOS_MAX_BODY_BYTES) {
        await rollbackIfNeeded();
        tEnd(`[public/pedidos] ${reqId} TOTAL`);
        return res.status(413).json({
          error: 'Payload demasiado grande para crear pedido',
          reqId,
        });
      }

      const rl = checkRateLimit(req);
      res.set('x-ratelimit-limit', String(RATE_LIMIT_MAX));
      res.set('x-ratelimit-remaining', String(rl.remaining));
      res.set('x-ratelimit-reset', String(Math.ceil(rl.resetAt / 1000)));
      if (!rl.allowed) {
        await rollbackIfNeeded();
        tEnd(`[public/pedidos] ${reqId} TOTAL`);
        return res.status(429).json({
          error: 'Demasiadas solicitudes. Intentá de nuevo en unos segundos.',
          reqId,
        });
      }

      const parse = createPedidoSchema.safeParse(req.body || {});
      if (!parse.success) {
        await rollbackIfNeeded();
        tEnd(`[public/pedidos] ${reqId} TOTAL`);
        return res.status(400).json({
          error: 'payload inválido',
          details: parse.error.issues.slice(0, 3).map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
          reqId,
        });
      }

      const {
        empresa_id = 1,
        cliente,
        telefono,
        direccion,
        ciudad,
        provincia,
        pais,
        latitud,
        longitud,
        notas,
        metodo_pago,
        submission_id,
        items,
        referral_code,
      } = parse.data;

      log('REQ IN', {
        empresa_id, cliente, telefono, direccion, ciudad, provincia, pais,
        latitud, longitud, notas, metodo_pago, submission_id,
        itemsCount: items.length,
      });

      const empId = Number(empresa_id) > 0 ? Number(empresa_id) : 1;

      let lat = toNum(latitud);
      let lng = toNum(longitud);
      lat = inRange(lat, -90, 90) ? round(lat) : null;
      lng = inRange(lng, -180, 180) ? round(lng) : null;

      if ((lat == null || lng == null) && (direccion || ciudad || provincia || pais)) {
        let foundInCache = false;

        try {
          const phoneNorm = normalizePhone(telefono || '');
          const searchPhone = phoneNorm.length > 7 ? phoneNorm.slice(-7) : phoneNorm;

          if (searchPhone.length >= 4) {
            const history = await txQuery(
              `SELECT direccion, ciudad, latitud, longitud
               FROM puntos_entrega
               WHERE empresa_id=$1
                 AND latitud IS NOT NULL
                 AND longitud IS NOT NULL
                 AND telefono_normalizado LIKE '%' || $2
               ORDER BY id DESC
               LIMIT 5`,
              [empId, searchPhone]
            );

            const currentDir = (direccion || '').trim().toLowerCase();
            for (const h of history) {
              const hDir = (h.direccion || '').trim().toLowerCase();
              if (currentDir && hDir && currentDir === hDir) {
                lat = Number(h.latitud);
                lng = Number(h.longitud);
                foundInCache = true;
                log(`[GEOCODE] 💰 CACHÉ AHORRO: Usamos coords guardadas para "${cliente}" (${direccion}) -> Lat=${lat}, Lng=${lng}`);
                break;
              }
            }
          }
        } catch (e) {
          console.warn('[GEOCODE] Error al buscar historial:', e.message);
        }

        if (!foundInCache) {
          try {
            const loc = await geocodeIfNeeded({ direccion, ciudad, provincia, pais });
            if (lat == null) lat = toNum(loc?.lat);
            if (lng == null) lng = toNum(loc?.lng);

            if (lat && lng) log(`[GEOCODE] 🌎 API GOOGLE: Coordenadas nuevas para "${direccion}": ${lat}, ${lng}`);
            else log(`[GEOCODE] ⚠️ FALLÓ: Google no encontró "${direccion}"`);
          } catch (e) {
            console.warn('[GEOCODE] Error en geocodeIfNeeded:', e.message);
          }
        }
      }

      let zona_id = null;
      if (lat != null && lng != null) {
        zona_id = await pointInAnyZone({ empresa_id: empId, lat, lng });
      }

      let punto_entrega_id = null;
      try {
        const phoneNorm = normalizePhone(telefono || '');
        const searchPhone = phoneNorm.length > 7 ? phoneNorm.slice(-7) : phoneNorm;

        if (searchPhone && direccion) {
          const existingPoints = await txQuery(
            `SELECT id, latitud, longitud, zona_id
             FROM puntos_entrega
             WHERE empresa_id = $1
               AND telefono_normalizado LIKE '%' || $2
               AND LOWER(TRIM(direccion)) = LOWER(TRIM($3))
             ORDER BY id DESC
             LIMIT 1`,
            [empId, searchPhone, direccion]
          );

          if (existingPoints.length > 0) {
            const match = existingPoints[0];
            punto_entrega_id = match.id;
            if (zona_id == null && match.zona_id != null) zona_id = match.zona_id;
            if ((lat == null || lng == null) && match.latitud != null && match.longitud != null) {
              lat = Number(match.latitud);
              lng = Number(match.longitud);
            }
            log('PUNTO_ENTREGA.REUSE', { punto_entrega_id, direccion, match_db: true });
          }
        }
      } catch (e) {
        errlog('PUNTO_ENTREGA.REUSE.ERROR', e?.message || e);
      }

      if (!punto_entrega_id) {
        const telNorm = normalizePhone(telefono || '');
        const peRows = await txQuery(
          `INSERT INTO puntos_entrega (
            empresa_id, cliente, telefono, telefono_normalizado, direccion, ciudad, provincia, pais,
            latitud, longitud, notas, zona_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING id`,
          [empId, cliente, telefono, telNorm, direccion, ciudad, provincia, pais, lat, lng, notas, zona_id]
        );
        punto_entrega_id = peRows[0].id;
        log('PUNTO_ENTREGA.NEW', { punto_entrega_id, direccion, ciudad, telefono });
      }

      let chofer_id = null;
      if (zona_id != null) {
        try {
          const chRows = await txQuery(
            `SELECT c.id
             FROM zona_chofer zc
             JOIN choferes c ON c.id = zc.chofer_id
             WHERE zc.zona_id = $1 AND c.empresa_id = $2
             ORDER BY zc.chofer_id ASC
             LIMIT 1`,
            [zona_id, empId]
          );
          if (chRows.length) chofer_id = chRows[0].id;
        } catch (e) {
          errlog('CHOFER.RESOLVE.ERROR', e?.message || e);
        }
      }

      const normItems = (Array.isArray(items) ? items : [])
        .map((it) => ({
          producto: String(it?.producto || '').trim(),
          cantidad: Number(it?.cantidad ?? 0),
          precio_unitario: Number(it?.precio_unitario ?? 0),
          producto_id: Number(it?.producto_id ?? 0) || null,
        }))
        .filter((it) => it.producto && Number.isFinite(it.cantidad) && it.cantidad > 0 && Number.isFinite(it.precio_unitario) && it.precio_unitario >= 0);

      if (normItems.length === 0) {
        await rollbackIfNeeded();
        tEnd(`[public/pedidos] ${reqId} TOTAL`);
        return res.status(400).json({ error: 'items inválidos', reqId });
      }

      const catalogRows = await txQuery(
        `SELECT id, nombre, promo_config
         FROM productos
         WHERE empresa_id = $1 AND deleted_at IS NULL`,
        [empId]
      );

      const byId = new Map();
      const byName = new Map();
      for (const row of catalogRows) {
        byId.set(Number(row.id), row);
        byName.set(String(row.nombre || '').trim().toLowerCase(), row);
      }

      for (const it of normItems) {
        let p = null;
        if (it.producto_id && byId.has(Number(it.producto_id))) {
          p = byId.get(Number(it.producto_id));
        } else {
          p = byName.get(String(it.producto || '').trim().toLowerCase()) || null;
        }
        if (p) {
          it.producto_id = Number(p.id);
          it.producto = String(p.nombre || it.producto);
        } else {
          it.producto_id = null;
        }
      }

      const qtyByProductId = new Map();
      for (const it of normItems) {
        if (!it.producto_id) continue;
        qtyByProductId.set(it.producto_id, (qtyByProductId.get(it.producto_id) || 0) + Number(it.cantidad || 0));
      }

      const baseOrderTotal = normItems.reduce((acc, it) => acc + (it.cantidad * it.precio_unitario), 0);

      const pendingPromoRedemptions = [];
      const promoAddedByTrigger = new Set();

      if (punto_entrega_id) {
        try {
          await txQuery('SELECT pg_advisory_xact_lock(hashtext($1))', [`promo-once:${empId}:${punto_entrega_id}`]);

          for (const it of [...normItems]) {
            if (!it.producto_id) continue;
            if (promoAddedByTrigger.has(it.producto_id)) continue;

            const baseProduct = byId.get(Number(it.producto_id));
            const promoCfg = baseProduct?.promo_config?.once_per_client_gift;
            if (!promoCfg?.enabled) continue;

            const giftProductId = Number(promoCfg.gift_product_id || 0);
            const hasValidGift = giftProductId > 0 && byId.has(giftProductId);

            const minOrderTotal = Number(promoCfg.min_order_total || 0);
            if (Number.isFinite(minOrderTotal) && minOrderTotal > 0 && baseOrderTotal < minOrderTotal) continue;

            const triggerMinQty = Number(promoCfg.trigger_min_qty || 0);
            if (Number.isFinite(triggerMinQty) && triggerMinQty > 1) {
              const actualQty = Number(qtyByProductId.get(it.producto_id) || 0);
              if (actualQty < triggerMinQty) continue;
            }

            const comboRequiredProductId = Number(promoCfg.combo_required_product_id || 0);
            if (comboRequiredProductId > 0) {
              const comboQty = Number(qtyByProductId.get(comboRequiredProductId) || 0);
              if (comboQty <= 0) continue;
            }

            const maxRedemptionsTotal = Number(promoCfg.max_redemptions_total || 0);
            if (Number.isFinite(maxRedemptionsTotal) && maxRedemptionsTotal > 0) {
              const totalRedemptionsRows = await txQuery(
                `SELECT COUNT(*)::int AS c
                   FROM promociones_redenciones
                  WHERE empresa_id = $1
                    AND trigger_producto_id = $2`,
                [empId, it.producto_id]
              );
              const totalRedemptions = Number(totalRedemptionsRows?.[0]?.c || 0);
              if (totalRedemptions >= maxRedemptionsTotal) continue;
            }

            const maxRedemptionsPerDay = Number(promoCfg.max_redemptions_per_day || 0);
            if (Number.isFinite(maxRedemptionsPerDay) && maxRedemptionsPerDay > 0) {
              const dayRedemptionsRows = await txQuery(
                `SELECT COUNT(*)::int AS c
                   FROM promociones_redenciones
                  WHERE empresa_id = $1
                    AND trigger_producto_id = $2
                    AND created_at >= DATE_TRUNC('day', NOW())`,
                [empId, it.producto_id]
              );
              const dayRedemptions = Number(dayRedemptionsRows?.[0]?.c || 0);
              if (dayRedemptions >= maxRedemptionsPerDay) continue;
            }

            const nowMs = Date.now();
            const fromMs = promoCfg.valid_from ? Date.parse(promoCfg.valid_from) : NaN;
            const toMs = promoCfg.valid_to ? Date.parse(promoCfg.valid_to) : NaN;
            if (Number.isFinite(fromMs) && nowMs < fromMs) continue;
            if (Number.isFinite(toMs) && nowMs > toMs) continue;

            const promoMode = promoCfg.mode === 'global_client' ? 'global_client' : 'per_product';
            const benefitType = promoMode === 'global_client' ? 'gift_once_global' : 'gift_once_per_product';

            const already = promoMode === 'global_client'
              ? await txQuery(
                  `SELECT 1
                     FROM promociones_redenciones
                    WHERE empresa_id = $1
                      AND punto_entrega_id = $2
                      AND beneficio_tipo = 'gift_once_global'
                    LIMIT 1`,
                  [empId, punto_entrega_id]
                )
              : await txQuery(
                  `SELECT 1
                     FROM promociones_redenciones
                    WHERE empresa_id = $1
                      AND punto_entrega_id = $2
                      AND trigger_producto_id = $3
                      AND beneficio_tipo = 'gift_once_per_product'
                    LIMIT 1`,
                  [empId, punto_entrega_id, it.producto_id]
                );
            if (already.length) continue;

            if (hasValidGift) {
              const giftProduct = byId.get(giftProductId);
              normItems.push({
                producto: `🎁 REGALO: ${giftProduct?.nombre || 'Promoción'}`,
                cantidad: 1,
                precio_unitario: 0,
                producto_id: giftProductId,
              });
            }

            const discountPercent = Number(promoCfg.discount_percent || 0);
            const discountAmount = Number(promoCfg.discount_amount || 0);
            let discountValue = 0;
            if (Number.isFinite(discountPercent) && discountPercent > 0) {
              discountValue += (baseOrderTotal * discountPercent) / 100;
            }
            if (Number.isFinite(discountAmount) && discountAmount > 0) {
              discountValue += discountAmount;
            }
            if (discountValue > 0) {
              discountValue = Math.min(discountValue, Math.max(baseOrderTotal, 0));
              normItems.push({
                producto: `🎟️ DESCUENTO PROMO: ${baseProduct?.nombre || 'Promo'}`,
                cantidad: 1,
                precio_unitario: -round(discountValue),
                producto_id: null,
              });
            }

            if (!hasValidGift && discountValue <= 0) continue;

            pendingPromoRedemptions.push({
              trigger_producto_id: it.producto_id,
              beneficio_producto_id: hasValidGift ? giftProductId : null,
              beneficio_tipo: benefitType,
            });
            promoAddedByTrigger.add(it.producto_id);
          }
        } catch (e) {
          errlog('PROMO_ONCE.ERROR', e?.message || e);
        }
      }

      let rewardIdsToUpdate = [];
      if (punto_entrega_id) {
        try {
          const premios = await txQuery(
            `SELECT cr.id, cr.cantidad, p.nombre
             FROM cliente_recompensas cr
             JOIN productos p ON p.id = cr.producto_id
             WHERE cr.cliente_id = $1
               AND cr.reclamado = FALSE`,
            [punto_entrega_id]
          );

          if (premios.length > 0) {
            log('REWARDS', `Cliente ${punto_entrega_id} tiene ${premios.length} premios para canjear.`);
            for (const premio of premios) {
              normItems.push({ producto: `🎁 PREMIO: ${premio.nombre}`, cantidad: Number(premio.cantidad), precio_unitario: 0 });
              rewardIdsToUpdate.push(premio.id);
            }
          }
        } catch (e) {
          errlog('REWARDS.ERROR', e?.message || e);
        }
      }

      const totalCantidad = normItems.reduce((acc, it) => acc + it.cantidad, 0);
      const totalMonto = normItems.reduce((acc, it) => acc + (it.cantidad * it.precio_unitario), 0);

      const mPago = String(metodo_pago || '').toLowerCase();
      const pagoTag = mPago ? (mPago === 'transferencia' ? ' (Transferencia)' : mPago === 'efectivo' ? ' (Efectivo)' : ` (${mPago})`) : '';
      const resumenTxt = buildOrderSummary(normItems) + pagoTag;

      if (submission_id) {
        await txQuery('SELECT pg_advisory_xact_lock(hashtext($1))', [`pedido:${empId}:${submission_id}`]);
      }

      const pedExist = submission_id
        ? await txQuery(
            `SELECT id, estado, monto FROM pedidos WHERE empresa_id=$1 AND submission_id=$2 LIMIT 1`,
            [empId, submission_id]
          )
        : [];

      if (submission_id && pedExist.length) {
        const existing = pedExist[0];
        await rollbackIfNeeded();
        tEnd(`[public/pedidos] ${reqId} TOTAL`);
        return res.json({
          ok: true,
          created: false,
          pedido: { id: existing.id, submission_id, estado: existing.estado, monto: existing.monto },
          zona_id,
          coords: (lat != null && lng != null) ? { lat, lng } : null,
          resumen: resumenTxt,
          reqId
        });
      }

      let padrinoId = null;
      if (referral_code && referral_code.startsWith('VECINO-')) {
        const historial = await txQuery('SELECT id FROM pedidos WHERE punto_entrega_id=$1 LIMIT 1', [punto_entrega_id]);
        const esClienteNuevo = historial.length === 0;

        if (esClienteNuevo) {
          const idOrigen = parseInt(referral_code.split('-')[1]);
          if (Number.isInteger(idOrigen)) {
            const rowPadrino = await txQuery(`SELECT punto_entrega_id FROM pedidos WHERE id=$1`, [idOrigen]);
            if (rowPadrino.length > 0) {
              const candidatoId = rowPadrino[0].punto_entrega_id;
              if (candidatoId !== punto_entrega_id) {
                padrinoId = candidatoId;
                console.log(`[REFERIDOS] Cliente ${punto_entrega_id} referido por ${padrinoId}`);
              }
            }
          }
        }
      }

      const pedRows = await txQuery(
        `INSERT INTO pedidos (
          empresa_id, punto_entrega_id, fecha, estado,
          cantidad, cantidad_entregada, monto,
          metodo_pago, aviso_recibido, sats,
          submission_id, chofer_id, zona_id,
          referido_por_id
        ) VALUES ($1,$2,NOW(),'pendiente',$3,0,$4,$5,0,0,$6,$7,$8,$9)
        RETURNING id, estado, monto`,
        [empId, punto_entrega_id, totalCantidad, totalMonto, metodo_pago, submission_id, chofer_id, zona_id, padrinoId]
      );

      const pedido = pedRows[0];

      for (const it of normItems) {
        await txQuery(
          `INSERT INTO items_pedido (pedido_id, producto, producto_id, cantidad, precio_unitario)
           VALUES ($1,$2,$3,$4,$5)`,
          [pedido.id, it.producto, it.producto_id || null, it.cantidad, it.precio_unitario]
        );
      }

      if (pendingPromoRedemptions.length > 0) {
        try {
          for (const promo of pendingPromoRedemptions) {
            await txQuery(
              `INSERT INTO promociones_redenciones (
                 empresa_id, punto_entrega_id, trigger_producto_id, beneficio_tipo, beneficio_producto_id, pedido_id
               ) VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT DO NOTHING`,
              [empId, punto_entrega_id, promo.trigger_producto_id, promo.beneficio_tipo, promo.beneficio_producto_id, pedido.id]
            );
          }
        } catch (e) {
          errlog('PROMO_ONCE.REDENCION.ERROR', e?.message || e);
        }
      }

      if (rewardIdsToUpdate.length > 0) {
        try {
          await txQuery(
            `UPDATE cliente_recompensas
             SET reclamado = TRUE,
                 fecha_reclamado = NOW(),
                 origen_pedido_id = $2
             WHERE id = ANY($1::int[])`,
            [rewardIdsToUpdate, pedido.id]
          );
          log('REWARDS.CLAIMED', `Premios IDs [${rewardIdsToUpdate.join(',')}] marcados como reclamados.`);
        } catch (e) {
          errlog('REWARDS.UPDATE.ERROR', e?.message || e);
        }
      }

      try {
        const empRows = await txQuery('SELECT config_entrega FROM empresas WHERE id=$1', [empId]);
        const configEntrega = empRows[0]?.config_entrega || {};

        let repData = null;
        if (chofer_id) {
          const cRows = await txQuery('SELECT nombre, telefono FROM choferes WHERE id=$1', [chofer_id]);
          if (cRows.length) repData = cRows[0];
        }

        const isTransf = String(metodo_pago).toLowerCase().includes('transf');
        const aliasDB = isTransf ? await getAliasEmpresa(empId, txQuery) : null;

        let mensaje = armarMensajeConfirmado({
          cliente,
          items: normItems,
          direccion: [direccion, ciudad, provincia].filter(Boolean).join(', '),
          fecha: new Date(),
          repartidor: repData,
          configEntrega
        });

        if (isTransf && aliasDB) {
          mensaje += `\n\n📄 Alias para transferir: *${aliasDB}*\nPor favor enviá el comprobante por aquí.`;
        }

        await enqueueWppMessage({ phone: telefono, message: mensaje, empresa_id: empId });
      } catch (e) {
        errlog('WPP.NOTIFY.ERROR', e?.message || e);
      }

      try {
        await ejecutarEstrategiaVecinosFn({ pedidoId: pedido.id, empresaId: empId });
      } catch (e) {
        errlog('VECINOS.ESTRATEGIA.ERROR', e?.message || e);
      }

      if (txClient && !txFinished) {
        await txClient.query('COMMIT');
        txFinished = true;
      }

      tEnd(`[public/pedidos] ${reqId} TOTAL`);

      return res.json({
        ok: true,
        created: true,
        pedido: { id: pedido.id, submission_id, estado: pedido.estado, monto: pedido.monto },
        zona_id,
        coords: (lat != null && lng != null) ? { lat, lng } : null,
        resumen: resumenTxt,
        reqId
      });
    } catch (err) {
      await rollbackIfNeeded();
      errlog('UNHANDLED', {
        message: err?.message,
        stack: err?.stack,
        path: req.originalUrl,
        method: req.method,
      });
      tEnd(`[public/pedidos] ${reqId} TOTAL`);
      return res.status(500).json({ error: 'No se pudo crear el pedido', reqId });
    } finally {
      if (txClient) txClient.release();
    }
  });
}
