// src/routes/repartidorApi.js
// API Repartidor (dashboard chofer) — extraído desde server.js

import express from 'express';
import { awardPointsForDeliveredOrder as awardPointsForDeliveredOrderDefault } from '../services/puntosService.js';
import { generateComisionesForDeliveredOrder as generateComisionesForDeliveredOrderDefault } from '../services/referentesService.js';
import {
  crearPagoParaPedido as crearPagoParaPedidoDefault,
  listarPagosPorPedido as listarPagosPorPedidoDefault,
  refrescarEstadoPagoPedido as refrescarEstadoPagoPedidoDefault
} from '../qr/pagosService.js';
import {
  actualizarRetornableSaldo,
  ensureRetornablesLedgerSchema,
  insertarRetornableMovimiento,
} from '../services/retornablesLedger.js';
import {
  lockProductIdentityNamespaces,
  normalizeProductIdentityName,
  PRODUCT_NAME_IDENTITY_SQL,
  resolveProductIdentityItems as resolveProductIdentityItemsDefault,
} from '../services/productIdentityNamespace.js';
import { lockDeliveryPointRows } from '../services/deliveryPointIdentity.js';
import { lockStockContext } from '../services/stockLocking.js';

export function createRepartidorApiRouter(deps) {
  const { query, pool, withTransaction, withAuth, getEmpresaIdFromToken, notifyEstadoPedidoPush, notificarEnRuta, notificarPedidoTransferencia, ejecutarEstrategiaVecinos, ejecutarPostEntregaUpsell, ejecutarRecompensaReferido, ejecutarEstrategiaReferidos, awardPointsForDeliveredOrder = awardPointsForDeliveredOrderDefault, generateComisionesForDeliveredOrder = generateComisionesForDeliveredOrderDefault, resolveProductIdentityItems = resolveProductIdentityItemsDefault, registrarMovimientosActivosDesdePedido, crearPagoParaPedido = crearPagoParaPedidoDefault, listarPagosPorPedido = listarPagosPorPedidoDefault, refrescarEstadoPagoPedido = refrescarEstadoPagoPedidoDefault } = deps || {};
  if (typeof query !== 'function') throw new Error('createRepartidorApiRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createRepartidorApiRouter: falta withAuth(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createRepartidorApiRouter: falta getEmpresaIdFromToken(fn)');
  // pool + helpers opcionales: usados por algunas rutas

  const router = express.Router();
  let schemaReady = false;
  let cuentaCorrienteSchemaReady = false;

  function requireExactRepartidor(req, res, next) {
    const { role, empresa_id: empresaId, chofer_id: choferId } = req.user || {};
    if (role !== 'repartidor'
        || !Number.isSafeInteger(empresaId) || empresaId <= 0
        || !Number.isSafeInteger(choferId) || choferId <= 0) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    return next();
  }

  async function ensureCuentaCorrienteSchema() {
    if (cuentaCorrienteSchemaReady) return;
    await query(`ALTER TABLE puntos_entrega ADD COLUMN IF NOT EXISTS cuenta_corriente_habilitada BOOLEAN DEFAULT FALSE`);
    cuentaCorrienteSchemaReady = true;
  }

  async function ensureRepartidorSchema() {
    if (schemaReady) return;
    await ensureCuentaCorrienteSchema();
    await query(`ALTER TABLE chofer_stock_mov ADD COLUMN IF NOT EXISTS gasto_id INTEGER`);
    await query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS fecha_entrega_estimada DATE`);
    await query(`ALTER TABLE zonas_geograficas ADD COLUMN IF NOT EXISTS dias_entrega JSONB DEFAULT '[]'::jsonb`);
    await query(`
      CREATE TABLE IF NOT EXISTS cliente_retornables_saldos (
        empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        punto_entrega_id INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
        producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
        saldo NUMERIC(12,2) NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (empresa_id, punto_entrega_id, producto_id)
      )
    `);
    await query(`
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
    await query(`CREATE INDEX IF NOT EXISTS idx_cliente_retornables_mov_cliente ON cliente_retornables_movimientos (empresa_id, punto_entrega_id, producto_id, fecha DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cliente_retornables_mov_pedido ON cliente_retornables_movimientos (pedido_id)`);
    await ensureRetornablesLedgerSchema(query);
    schemaReady = true;
  }

  function deliveryHttpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  function deliveryValidationError(message) {
    return deliveryHttpError(400, message);
  }

  const SAFE_QR_DOMAIN_ERRORS = new Map([
    ['PAYMENT_PROVIDER_NOT_CONFIGURED', { status: 400, message: 'El proveedor de pagos no está configurado' }],
    ['PAYMENT_AMOUNT_INVALID', { status: 400, message: 'El pedido no tiene un monto válido para generar el pago' }],
    ['PAYMENT_PROVIDER_UNSUPPORTED', { status: 400, message: 'Proveedor de pagos no soportado' }],
    ['PAYMENT_ORDER_NOT_FOUND', { status: 404, message: 'Pedido no encontrado' }],
  ]);

  function safeQrDomainError(error) {
    const contract = SAFE_QR_DOMAIN_ERRORS.get(String(error?.code || ''));
    if (!contract || Number(error?.statusCode) !== contract.status) return null;
    return { ...contract, code: String(error.code) };
  }

  function runPostCommitTask(task, label) {
    if (typeof task !== 'function') return;
    Promise.resolve()
      .then(task)
      .catch(error => console.error(label, error?.message || error));
  }

  function normalizeRetornablesPayload(retornables) {
    if (!Array.isArray(retornables)) {
      throw deliveryValidationError('Payload de retornables inválido');
    }
    const map = new Map();
    for (const row of retornables) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw deliveryValidationError('Cantidad devuelta inválida');
      }
      const productoId = row.producto_id;
      const devueltos = row.devueltos;
      if (!Number.isSafeInteger(productoId) || productoId <= 0) {
        throw deliveryValidationError('Producto retornable inválido');
      }
      if (!Number.isSafeInteger(devueltos) || devueltos < 0) {
        throw deliveryValidationError('Cantidad devuelta inválida');
      }
      if (map.has(productoId)) {
        throw deliveryValidationError('Producto retornable duplicado');
      }
      map.set(productoId, devueltos);
    }
    return map;
  }

  function normalizeMovimientosActivosPayload(movimientos) {
    if (!Array.isArray(movimientos)) {
      throw deliveryValidationError('Movimientos de activos inválidos');
    }
    const tipos = new Set(['entrega', 'retiro', 'mantenimiento', 'cambio']);
    const idsUsados = new Set();
    const positivos = (value) => Number.isSafeInteger(value) && value > 0;

    return movimientos.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw deliveryValidationError('Movimientos de activos inválidos');
      }
      const tipoOperacion = raw.tipoOperacion ?? raw.tipo_operacion;
      const activoId = raw.activoId ?? raw.activo_id;
      const itemPedidoId = raw.itemPedidoId ?? raw.item_pedido_id;
      const productoId = raw.productoId ?? raw.producto_id;
      const activoRelacionadoId = raw.activoRelacionadoId ?? raw.activo_relacionado_id ?? null;
      if (typeof tipoOperacion !== 'string' || !tipos.has(tipoOperacion)
          || !positivos(activoId) || !positivos(itemPedidoId) || !positivos(productoId)
          || (tipoOperacion === 'cambio' && !positivos(activoRelacionadoId))
          || (tipoOperacion !== 'cambio' && activoRelacionadoId != null)) {
        throw deliveryValidationError('Movimientos de activos inválidos');
      }
      const idsMovimiento = tipoOperacion === 'cambio' ? [activoId, activoRelacionadoId] : [activoId];
      if (idsMovimiento.some((id) => idsUsados.has(id)) || new Set(idsMovimiento).size !== idsMovimiento.length) {
        throw deliveryValidationError('Movimientos de activos inválidos');
      }
      idsMovimiento.forEach((id) => idsUsados.add(id));
      return {
        ...raw,
        tipoOperacion,
        activoId,
        itemPedidoId,
        productoId,
        ...(tipoOperacion === 'cambio' ? { activoRelacionadoId } : {}),
      };
    });
  }

  function validateEntregasActivasRequeridas(itemsActivos, movimientos) {
    const requeridos = new Map();
    for (const row of itemsActivos || []) {
      const itemPedidoId = Number(row.item_pedido_id);
      const productoId = Number(row.producto_id);
      const cantidad = Number(row.cantidad);
      if (!Number.isSafeInteger(itemPedidoId) || itemPedidoId <= 0
          || !Number.isSafeInteger(productoId) || productoId <= 0
          || !Number.isSafeInteger(cantidad) || cantidad <= 0) {
        throw deliveryValidationError('Configuración de activos del pedido inválida');
      }
      if (requeridos.has(itemPedidoId)) {
        throw deliveryValidationError('Configuración de activos del pedido inválida');
      }
      requeridos.set(itemPedidoId, { productoId, cantidad, asignaciones: 0 });
    }

    for (const movimiento of movimientos) {
      const requerido = requeridos.get(movimiento.itemPedidoId);
      if (!requerido || requerido.productoId !== movimiento.productoId) {
        throw deliveryValidationError('Movimientos de activos inválidos');
      }
      if (movimiento.tipoOperacion === 'entrega' || movimiento.tipoOperacion === 'cambio') {
        requerido.asignaciones += 1;
      }
    }
    for (const requerido of requeridos.values()) {
      if (requerido.asignaciones !== requerido.cantidad) {
        throw deliveryValidationError('Movimientos de activos inválidos');
      }
    }
  }

  async function loadCanonicalDeliveryComposition(client, { pedidoId, empresaId, choferId }) {
    const itemsQ = await client.query(
      `SELECT id, producto_id, producto, cantidad
         FROM items_pedido
        WHERE pedido_id = $1
        ORDER BY id`,
      [pedidoId]
    );
    const items = itemsQ.rows || [];
    const canonicalIds = [];
    const legacyNames = [];
    for (const item of items) {
      if (item.producto_id == null) {
        const legacyName = normalizeProductIdentityName(item.producto);
        if (!legacyName) throw deliveryHttpError(409, 'Producto legacy inválido en el pedido');
        legacyNames.push(legacyName);
      } else {
        const productoId = Number(item.producto_id);
        if (!Number.isSafeInteger(productoId) || productoId <= 0) {
          throw deliveryHttpError(409, 'Producto inválido en el pedido');
        }
        canonicalIds.push(productoId);
      }
    }

    const canonicalLegacyNames = await lockProductIdentityNamespaces(
      async (sql, params) => (await client.query(sql, params)).rows,
      { empresaId, names: legacyNames }
    );

    const stockProductQ = await client.query(
      `SELECT id
         FROM productos
        WHERE empresa_id = $1
          AND (
               id = ANY($2::int[])
            OR ${PRODUCT_NAME_IDENTITY_SQL} = ANY($3::text[])
          )
        ORDER BY id`,
      [empresaId, Array.from(new Set(canonicalIds)).sort((a, b) => a - b), canonicalLegacyNames]
    );
    await lockStockContext(
      async (sql, params) => (await client.query(sql, params)).rows,
      {
        empresaId,
        referencia: `pedido:${Number(pedidoId)}`,
        choferId,
        productoIds: stockProductQ.rows.map(row => Number(row.id)),
      }
    );

    const productQ = await client.query(
      `SELECT id, nombre, retornable, stock_infinito, config_activo
         FROM productos
        WHERE empresa_id = $1
          AND (
               id = ANY($2::int[])
            OR ${PRODUCT_NAME_IDENTITY_SQL} = ANY($3::text[])
          )
        ORDER BY id
        FOR SHARE`,
      [empresaId, Array.from(new Set(canonicalIds)).sort((a, b) => a - b), canonicalLegacyNames]
    );
    const products = productQ.rows || [];
    const byId = new Map(products.map(row => [Number(row.id), row]));
    const byName = new Map();
    for (const product of products) {
      const key = normalizeProductIdentityName(product.nombre);
      const rows = byName.get(key) || [];
      rows.push(product);
      byName.set(key, rows);
    }

    return items.map(item => {
      let product;
      if (item.producto_id == null) {
        const matches = byName.get(normalizeProductIdentityName(item.producto)) || [];
        if (matches.length === 0) throw deliveryHttpError(409, 'Producto legacy no encontrado en el pedido');
        if (matches.length !== 1) throw deliveryHttpError(409, 'Producto legacy ambiguo en el pedido');
        [product] = matches;
      } else {
        product = byId.get(Number(item.producto_id));
        if (!product) throw deliveryHttpError(409, 'Producto inválido en el pedido');
      }
      const cantidad = Number(item.cantidad);
      if (!Number.isSafeInteger(cantidad) || cantidad <= 0) {
        throw deliveryHttpError(409, 'Cantidad inválida en el pedido');
      }
      return {
        itemPedidoId: Number(item.id),
        productoId: Number(product.id),
        producto: product,
        cantidad,
      };
    });
  }

  function isCuentaCorrienteMethod(metodo) {
    return metodo === 'cuenta_corriente';
  }

  function isTransferenciaMethod(metodo) {
    return metodo === 'transferencia';
  }

  function comprobanteBloqueaSolicitud(row) {
    const estado = String(row?.estado_revision || 'pendiente').trim().toLowerCase();
    if (estado === 'rechazado' || estado === 'duplicado') return false;

    if (
      Number(row?.validado || 0) === 1
      || row?.procesado === true
      || ['aprobado', 'verificado', 'acreditado'].includes(estado)
    ) {
      return true;
    }

    const tieneArchivo = Boolean(
      String(row?.archivo_path || '').trim()
      || String(row?.comprobante_path || '').trim()
    );
    if (!tieneArchivo) return false;

    // Cualquier archivo no rechazado ya fue adjuntado: puede estar pendiente,
    // en revisión o aprobado, pero no corresponde pedirlo nuevamente.
    return true;
  }

  function isPedidoEnRutaOperable(pedido) {
    const estado = String(pedido?.estado || '').toLowerCase();
    return estado === 'en_ruta' || estado === 'en_camino';
  }

  async function getPedidoOperablePorRepartidor({ pedidoId, empresaId, choferId, role }) {
    const vals = [pedidoId, empresaId];
    let choferClause = '';

    if (String(role || '').toLowerCase() === 'repartidor') {
      vals.push(choferId);
      choferClause = 'AND (p.chofer_id = $3 OR p.chofer_id IS NULL)';
    }

    const rows = await query(
      `
      SELECT p.id, p.empresa_id, p.chofer_id, p.estado, p.metodo_pago
        FROM pedidos p
       WHERE p.id = $1
         AND p.empresa_id = $2
         ${choferClause}
       LIMIT 1
      `,
      vals
    );

    return rows[0] || null;
  }

// Lectura mínima para el chofer autenticado. No ejecutar helpers de schema aquí.
  router.get('/transferencias', withAuth, requireExactRepartidor, async (req, res) => {
    const { role, empresa_id: empresaId, chofer_id: choferId } = req.user || {};
    if (role !== 'repartidor' || !Number.isSafeInteger(empresaId) || empresaId <= 0
        || !Number.isSafeInteger(choferId) || choferId <= 0) {
      return res.status(403).json({ error: 'Sólo para repartidores con chofer vinculado' });
    }
    const { fecha = '', estado = '' } = req.query;
    if (typeof fecha !== 'string' || (fecha && (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)
        || !Number.isFinite(Date.parse(fecha)) || new Date(fecha).toISOString().slice(0, 10) !== fecha))) {
      return res.status(400).json({ error: 'Fecha inválida' });
    }
    if (typeof estado !== 'string' || !['', 'pendiente', 'verificado'].includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    try {
      const rows = await query(`
        SELECT ct.pedido_id, pe.cliente,
               COALESCE(NULLIF(ct.monto, 0), p.monto, 0) AS monto,
               (COALESCE(ct.validado, 0) = 1 OR COALESCE(ct.procesado, FALSE)) AS validado
          FROM comprobantes_transferencia ct
          JOIN pedidos p ON p.id = ct.pedido_id AND p.empresa_id = ct.empresa_id
          JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id AND pe.empresa_id = p.empresa_id
         WHERE ct.empresa_id = $1 AND p.chofer_id = $2
           AND ($3::date IS NULL OR (ct.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = $3::date)
           AND ($4 = '' OR (CASE WHEN COALESCE(ct.validado, 0) = 1 OR COALESCE(ct.procesado, FALSE)
                                THEN 'verificado' ELSE 'pendiente' END) = $4)
         ORDER BY ct.fecha DESC, ct.id DESC`, [empresaId, choferId, fecha || null, estado]);
      return res.json({ rows: rows.map(({ pedido_id, cliente, monto, validado }) => ({
        pedido_id, cliente, monto, validado,
        estado: validado ? 'verificado' : 'pendiente',
      })) });
    } catch (e) {
      console.error('REPARTIDOR TRANSFERENCIAS ERROR:', e);
      return res.status(500).json({ error: 'Error consultando transferencias' });
    }
  });

// 1. Obtener Pedidos
  router.get('/pedidos', withAuth, requireExactRepartidor, async (req, res) => {
   try {
     await ensureRepartidorSchema();
     const { chofer_id, empresa_id: empresaId } = req.user;

     if (req.user.role === 'repartidor' && !chofer_id) {
       return res.status(403).json({ error: 'Usuario repartidor sin chofer vinculado.' });
     }

     // Traemos:
     // 1. Pedidos activos completos para la operación diaria
     // 2. Pedidos finalizados de los últimos 30 días para que el resumen histórico funcione
	     const rows = await query(
	       `SELECT
	          p.id, p.estado, p.fecha, p.fecha_entrega, p.fecha_entrega_estimada,
	          p.punto_entrega_id,
	          p.cantidad, p.monto, p.metodo_pago, p.chofer_id,
	          pe.cliente, pe.direccion, pe.ciudad, pe.telefono,
	          COALESCE(pe.cuenta_corriente_habilitada, FALSE) AS cuenta_corriente_habilitada,
	          pe.latitud, pe.longitud, pe.notas AS notas,
	          COALESCE(p.zona_id, pe.zona_id) AS zona_id, z.nombre AS zona_nombre, z.dias_entrega AS zona_dias_entrega,
          COALESCE((
            SELECT json_agg(
              json_build_object(
                'producto_id', s.producto_id,
                'producto', pr.nombre,
                'saldo', s.saldo
              )
              ORDER BY pr.nombre
            )
            FROM cliente_retornables_saldos s
            JOIN productos pr ON pr.id = s.producto_id AND pr.empresa_id = s.empresa_id
            WHERE s.empresa_id = p.empresa_id
              AND s.punto_entrega_id = p.punto_entrega_id
              AND s.saldo > 0
          ), '[]'::json) AS retornables_pendientes,
          COALESCE((
            SELECT SUM(s.saldo)
            FROM cliente_retornables_saldos s
            WHERE s.empresa_id = p.empresa_id
              AND s.punto_entrega_id = p.punto_entrega_id
              AND s.saldo > 0
          ), 0) AS retornables_pendientes_total,
          COALESCE(
            json_agg(
              json_build_object(
                'producto', ip.producto,
                'cantidad', ip.cantidad,
                'precio_unitario', ip.precio_unitario,
                'producto_id', ip.producto_id
              )
            ) FILTER (WHERE ip.id IS NOT NULL),
            '[]'::json
          ) AS items
        FROM pedidos p
        JOIN puntos_entrega pe
          ON pe.id = p.punto_entrega_id
         AND pe.empresa_id = p.empresa_id
	        LEFT JOIN zonas_geograficas z
          ON z.id = COALESCE(p.zona_id, pe.zona_id)
         AND z.empresa_id = p.empresa_id
        LEFT JOIN items_pedido ip ON ip.pedido_id = p.id
        WHERE p.empresa_id = $2
          AND (p.chofer_id = $1 OR p.chofer_id IS NULL)
          AND (
            p.estado IN ('pendiente', 'en_ruta', 'en_camino')
            OR (
              p.estado IN ('entregado', 'cancelado') 
              AND (
                 (p.fecha_entrega IS NOT NULL AND p.fecha_entrega >= NOW() - INTERVAL '30 days')
                 OR 
                 (p.fecha >= NOW() - INTERVAL '30 days')
              )
            )
          )
	        GROUP BY
	          p.id, p.estado, p.fecha, p.fecha_entrega, p.fecha_entrega_estimada,
	          p.punto_entrega_id,
	          p.cantidad, p.monto, p.metodo_pago, p.chofer_id,
	          pe.cliente, pe.direccion, pe.ciudad, pe.telefono,
	          pe.cuenta_corriente_habilitada,
	          pe.latitud, pe.longitud, pe.notas,
	          pe.zona_id, p.zona_id, z.nombre, z.dias_entrega
	        ORDER BY COALESCE(p.fecha_entrega_estimada, p.fecha::date) ASC, p.id ASC`,
       [chofer_id, empresaId]
     );

     res.json(rows);
   } catch (e) {
     console.error('REPARTIDOR PEDIDOS ERROR:', e);
     res.status(500).json({ error: 'Error cargando pedidos' });
   }
});

// 1.d Generar link/QR de pago desde la app del repartidor
  router.post('/pedidos/:id/pago-qr', withAuth, requireExactRepartidor, async (req, res) => {
   try {
     const pedidoId = Number(req.params.id);
     const { chofer_id, role } = req.user || {};
     const empresaId = Number(getEmpresaIdFromToken(req));

     if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
       return res.status(400).json({ error: 'ID inválido' });
     }
     if (!empresaId) return res.status(400).json({ error: 'Empresa no determinada' });
     if (role === 'repartidor' && !chofer_id) {
       return res.status(403).json({ error: 'Usuario repartidor sin chofer vinculado.' });
     }

     const pedido = await getPedidoOperablePorRepartidor({
       pedidoId,
       empresaId,
       choferId: chofer_id,
       role,
     });

     if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
     if (!isPedidoEnRutaOperable(pedido)) {
       return res.status(409).json({ error: 'El pedido debe estar en ruta para generar QR de cobro' });
     }

     const pago = await crearPagoParaPedido(
       { pedidoId, empresaId },
       {
         canal: 'repartidor',
         metodoPago: 'qr_dinamico',
       }
     );

     return res.json({
       id: pago.id,
       estado: pago.estado,
       monto: pago.monto,
       moneda: pago.moneda,
       checkout_url: pago.checkout_url,
       qr_payload: pago.qr_payload,
       vence_at: pago.vence_at,
       proveedor: pago.proveedor,
     });
   } catch (e) {
     const domainError = safeQrDomainError(e);
     console.error('REPARTIDOR_PAGO_QR_FAILED', {
       code: domainError?.code || 'INTERNAL_ERROR',
       pedidoId: Number.isSafeInteger(Number(req.params.id)) ? Number(req.params.id) : null,
     });
     if (domainError) {
       return res.status(domainError.status).json({ error: domainError.message, code: domainError.code });
     }
     return res.status(500).json({ error: 'Error generando pago QR' });
   }
});

// 1.e Consultar estado del pago QR desde la app del repartidor
  router.get('/pedidos/:id/pago-qr/estado', withAuth, requireExactRepartidor, async (req, res) => {
   try {
     const pedidoId = Number(req.params.id);
     const { chofer_id, role } = req.user || {};
     const empresaId = Number(getEmpresaIdFromToken(req));

     if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
       return res.status(400).json({ error: 'ID inválido' });
     }
     if (!empresaId) return res.status(400).json({ error: 'Empresa no determinada' });
     if (role === 'repartidor' && !chofer_id) {
       return res.status(403).json({ error: 'Usuario repartidor sin chofer vinculado.' });
     }

     const pedido = await getPedidoOperablePorRepartidor({
       pedidoId,
       empresaId,
       choferId: chofer_id,
       role,
     });

     if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
     if (!isPedidoEnRutaOperable(pedido)) {
       return res.status(409).json({ error: 'El pedido debe estar en ruta para consultar el pago QR' });
     }

     const pagos = await listarPagosPorPedido({ pedidoId, empresaId });
     const pagoLocal = (pagos || []).find((p) => String(p.metodo_pago || '').toLowerCase() === 'qr_dinamico') || (pagos || [])[0] || null;
     const pago = await refrescarEstadoPagoPedido({ pedidoId, empresaId, pago: pagoLocal });
     const estado = String(pago?.estado || '').toLowerCase();
     const pagado = ['pagado', 'aprobado', 'acreditado', 'approved'].includes(estado);

     return res.json({
       ok: true,
       pagado,
       estado: pago?.estado || null,
       pago_id: pago?.id || null,
       updated_at: pago?.updated_at || null,
     });
   } catch (e) {
     console.error('REPARTIDOR ESTADO PAGO QR ERROR:', e);
     return res.status(500).json({ error: 'Error consultando estado del pago QR' });
   }
});

// 1.f Forzar mensaje de transferencia manual desde la app del repartidor
  router.post('/pedidos/:id/transferencia/notificar', withAuth, requireExactRepartidor, async (req, res) => {
   try {
     const pedidoId = Number(req.params.id);
     const { chofer_id, role } = req.user || {};
     const empresaId = Number(getEmpresaIdFromToken(req));

     if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
       return res.status(400).json({ error: 'ID inválido' });
     }
     if (!empresaId) return res.status(400).json({ error: 'Empresa no determinada' });
     if (role === 'repartidor' && !chofer_id) {
       return res.status(403).json({ error: 'Usuario repartidor sin chofer vinculado.' });
     }

     const pedido = await getPedidoOperablePorRepartidor({
       pedidoId,
       empresaId,
       choferId: chofer_id,
       role,
     });

     if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
     if (!isPedidoEnRutaOperable(pedido)) {
       return res.status(409).json({ error: 'El pedido debe estar en ruta para pedir comprobante de transferencia' });
     }

     await notificarPedidoTransferencia(pedidoId, empresaId);
     return res.json({ ok: true });
   } catch (e) {
     console.error('REPARTIDOR NOTIFICAR TRANSFERENCIA ERROR:', e);
     return res.status(500).json({ error: 'Error enviando WhatsApp de transferencia' });
   }
});

// 1.a Zonas del repartidor actual (compat legacy /api/repartidor/mis-zonas)
  router.get('/mis-zonas', withAuth, requireExactRepartidor, async (req, res) => {
   try {
     const { chofer_id, empresa_id: empresaId } = req.user || {};

     if (!chofer_id) return res.json([]);
     if (!empresaId) return res.status(400).json({ error: 'Empresa no determinada' });

     const rows = await query(
       `SELECT z.id, z.nombre, z.dias_entrega, z.poligono
          FROM zona_chofer zc
          JOIN zonas_geograficas z
           ON z.id = zc.zona_id
          AND z.empresa_id = zc.empresa_id
         WHERE zc.chofer_id = $1
           AND zc.empresa_id = $2
           AND z.empresa_id = $2
         ORDER BY z.nombre ASC`,
       [chofer_id, empresaId]
     );

     const ret = (rows || []).map((r) => {
       try {
         return {
           ...r,
           poligono: typeof r.poligono === 'string' ? JSON.parse(r.poligono) : (r.poligono || []),
         };
       } catch {
         return { ...r, poligono: [] };
       }
     });

     return res.json(ret);
   } catch (e) {
     console.error('REPARTIDOR MIS-ZONAS ERROR:', e);
     return res.status(500).json({ error: 'Error cargando zonas del repartidor' });
   }
});

// 1.b Evidencias de entrega (auditoría rápida)
  router.get('/entregas-evidencias', withAuth, requireExactRepartidor, async (req, res) => {
   try {
     const { chofer_id, empresa_id, role } = req.user || {};
     const from = String(req.query?.from || '');
     const to = String(req.query?.to || '');

     const vals = [empresa_id];
     let idx = 2;
     const where = ['e.empresa_id = $1'];

     if (role === 'repartidor' && chofer_id) {
       where.push(`e.chofer_id = $${idx++}`);
       vals.push(chofer_id);
     }

     if (from) {
       where.push(`e.updated_at >= $${idx++}::date`);
       vals.push(from);
     }
     if (to) {
       where.push(`e.updated_at < ($${idx++}::date + INTERVAL '1 day')`);
       vals.push(to);
     }

     const rows = await query(
       `SELECT e.pedido_id, e.chofer_id, e.checklist, e.evidencia, e.updated_at,
               pe.cliente
          FROM entregas_evidencias e
          JOIN pedidos p
            ON p.id = e.pedido_id
           AND p.empresa_id = e.empresa_id
          JOIN puntos_entrega pe
            ON pe.id = p.punto_entrega_id
           AND pe.empresa_id = p.empresa_id
         WHERE ${where.join(' AND ')}
           AND p.empresa_id = $1
           AND p.chofer_id = $2
         ORDER BY e.updated_at DESC
         LIMIT 120`,
       vals
     );

     res.json({ ok: true, items: rows });
   } catch (e) {
     console.error('REPARTIDOR EVIDENCIAS ERROR:', e);
     res.status(500).json({ error: 'Error cargando evidencias' });
   }
});

// 1.c Stock acumulado del repartidor (con arrastre)
  router.get('/stock-acumulado', withAuth, requireExactRepartidor, async (req, res) => {
   try {
     const { chofer_id, empresa_id: empresaId } = req.user || {};
     const fecha = String(req.query?.fecha || new Date().toISOString().slice(0, 10)).slice(0, 10);

     if (!chofer_id) return res.status(400).json({ error: 'Usuario sin chofer asociado' });
     if (!empresaId) return res.status(400).json({ error: 'Empresa no determinada' });

     await ensureRepartidorSchema();

     const rows = await withTransaction(async txQuery => {
      const identityItems = await txQuery(
        `SELECT ip.id, ip.producto_id, ip.producto
           FROM pedidos p
           JOIN items_pedido ip ON ip.pedido_id = p.id
          WHERE p.empresa_id = $1
            AND p.chofer_id = $2
            AND p.estado = 'entregado'
            AND (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $3::date
          ORDER BY ip.id`,
        [empresaId, chofer_id, fecha]
      );
      await resolveProductIdentityItems(txQuery, { empresaId, items: identityItems });

      return txQuery(
       `WITH
          cargas_prev AS (
            SELECT csm.producto_id, COALESCE(SUM(csm.cantidad),0) AS qty
            FROM chofer_stock_mov csm
            LEFT JOIN gastos_repartidor g ON g.id = csm.gasto_id
              AND g.empresa_id = csm.empresa_id AND g.chofer_id = csm.chofer_id
            WHERE csm.empresa_id = $1
              AND csm.chofer_id = $2
              AND ((csm.tipo = 'INGRESO_GASTOS' AND csm.cantidad > 0) OR csm.tipo = 'ajuste')
              AND COALESCE(g.fecha, (csm.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) < $3::date
            GROUP BY csm.producto_id
          ),
          entregas_prev AS (
            SELECT
              COALESCE(ip.producto_id, pr.id) AS producto_id,
              COALESCE(SUM(ip.cantidad),0) AS qty
            FROM pedidos p
            JOIN items_pedido ip ON ip.pedido_id = p.id
            LEFT JOIN LATERAL (
              SELECT CASE WHEN COUNT(*) = 1 THEN MIN(px.id) END AS id
                FROM productos px
               WHERE ip.producto_id IS NULL
                 AND px.empresa_id = p.empresa_id
                 AND LOWER(TRIM(px.nombre)) = LOWER(TRIM(ip.producto))
            ) legacy ON TRUE
            LEFT JOIN productos pr
              ON pr.empresa_id = p.empresa_id
             AND pr.id = CASE WHEN ip.producto_id IS NOT NULL THEN ip.producto_id ELSE legacy.id END
            WHERE p.empresa_id = $1
              AND p.chofer_id = $2
              AND p.estado = 'entregado'
              AND (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date < $3::date
              AND COALESCE(ip.producto_id, pr.id) IS NOT NULL
            GROUP BY COALESCE(ip.producto_id, pr.id)
          ),
          cargas_day AS (
            SELECT csm.producto_id, COALESCE(SUM(csm.cantidad),0) AS qty
            FROM chofer_stock_mov csm
            LEFT JOIN gastos_repartidor g ON g.id = csm.gasto_id
              AND g.empresa_id = csm.empresa_id AND g.chofer_id = csm.chofer_id
            WHERE csm.empresa_id = $1
              AND csm.chofer_id = $2
              AND ((csm.tipo = 'INGRESO_GASTOS' AND csm.cantidad > 0) OR csm.tipo = 'ajuste')
              AND COALESCE(g.fecha, (csm.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) = $3::date
            GROUP BY csm.producto_id
          ),
          entregas_day AS (
            SELECT
              COALESCE(ip.producto_id, pr.id) AS producto_id,
              COALESCE(SUM(ip.cantidad),0) AS qty
            FROM pedidos p
            JOIN items_pedido ip ON ip.pedido_id = p.id
            LEFT JOIN LATERAL (
              SELECT CASE WHEN COUNT(*) = 1 THEN MIN(px.id) END AS id
                FROM productos px
               WHERE ip.producto_id IS NULL
                 AND px.empresa_id = p.empresa_id
                 AND LOWER(TRIM(px.nombre)) = LOWER(TRIM(ip.producto))
            ) legacy ON TRUE
            LEFT JOIN productos pr
              ON pr.empresa_id = p.empresa_id
             AND pr.id = CASE WHEN ip.producto_id IS NOT NULL THEN ip.producto_id ELSE legacy.id END
            WHERE p.empresa_id = $1
              AND p.chofer_id = $2
              AND p.estado = 'entregado'
              AND (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = $3::date
              AND COALESCE(ip.producto_id, pr.id) IS NOT NULL
            GROUP BY COALESCE(ip.producto_id, pr.id)
          ),
          all_prod AS (
            SELECT producto_id FROM cargas_prev
            UNION SELECT producto_id FROM entregas_prev
            UNION SELECT producto_id FROM cargas_day
            UNION SELECT producto_id FROM entregas_day
          )
          SELECT
            p.id AS producto_id,
            p.nombre,
            COALESCE(cp.qty,0) - COALESCE(ep.qty,0) AS saldo_inicial,
            COALESCE(cd.qty,0) AS cargado,
            COALESCE(ed.qty,0) AS entregado,
            (COALESCE(cp.qty,0) - COALESCE(ep.qty,0) + COALESCE(cd.qty,0) - COALESCE(ed.qty,0)) AS saldo_final
          FROM all_prod ap
          JOIN productos p ON p.id = ap.producto_id AND p.empresa_id = $1
          LEFT JOIN cargas_prev cp ON cp.producto_id = p.id
          LEFT JOIN entregas_prev ep ON ep.producto_id = p.id
          LEFT JOIN cargas_day cd ON cd.producto_id = p.id
          LEFT JOIN entregas_day ed ON ed.producto_id = p.id
          ORDER BY p.nombre`,
       [empresaId, chofer_id, fecha]
      );
    });

    const kpis = rows.reduce((acc, r) => {
       acc.saldo_inicial += Number(r.saldo_inicial || 0);
       acc.cargado += Number(r.cargado || 0);
       acc.entregado += Number(r.entregado || 0);
       acc.saldo_final += Number(r.saldo_final || 0);
       return acc;
     }, { saldo_inicial: 0, cargado: 0, entregado: 0, saldo_final: 0 });

     res.json({ ok: true, fecha, rows, kpis });
   } catch (e) {
     if (e?.code === 'PRODUCT_IDENTITY_CONFLICT') {
       return res.status(409).json({ error: e.message, code: e.code });
     }
     console.error('REPARTIDOR STOCK-ACUMULADO ERROR:', e);
     return res.status(500).json({ error: 'Error calculando stock acumulado' });
   }
});

// 2. Actualizar Estado o Pago (PUT) - Para los botones del repartidor
  router.put('/pedidos/:id', withAuth, requireExactRepartidor, async (req, res) => {
    const rawId = req.params.id;
    const pedidoId = /^\d+$/.test(rawId) ? Number(rawId) : NaN;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const hasEstado = Object.hasOwn(body, 'estado');
    const hasMetodoPago = Object.hasOwn(body, 'metodo_pago');
    const hasZonaId = Object.hasOwn(body, 'zona_id');
    const { estado, metodo_pago: metodoPago, zona_id: zonaIdBody } = body;
    const estadosPermitidos = new Set(['pendiente', 'en_ruta', 'en_camino', 'cancelado']);
    const metodosPagoPermitidos = new Set(['efectivo', 'transferencia', 'cuenta_corriente']);

    if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    if (!hasEstado && !hasMetodoPago && !hasZonaId) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    if (hasEstado) {
      if (estado === 'entregado') {
        return res.status(400).json({ error: 'Usá POST /api/repartidor/pedidos/:id/entregar' });
      }
      if (typeof estado !== 'string' || !estadosPermitidos.has(estado)) {
        return res.status(400).json({ error: 'Estado inválido' });
      }
    }
    if (hasMetodoPago && (typeof metodoPago !== 'string' || !metodosPagoPermitidos.has(metodoPago))) {
      return res.status(400).json({ error: 'Método de pago inválido' });
    }
    if (hasZonaId && (!Number.isSafeInteger(zonaIdBody) || zonaIdBody <= 0)) {
      return res.status(400).json({ error: 'Zona inválida' });
    }
    if (typeof withTransaction !== 'function') {
      return res.status(500).json({ error: 'Error actualizando pedido' });
    }

    const { chofer_id: choferId, empresa_id: empresaId } = req.user;
    const transiciones = {
      pendiente: new Set(['pendiente', 'en_ruta', 'en_camino', 'cancelado']),
      en_ruta: new Set(['pendiente', 'en_ruta', 'en_camino', 'cancelado']),
      en_camino: new Set(['pendiente', 'en_ruta', 'en_camino', 'cancelado']),
    };

    try {
      await withTransaction(async txQuery => {
        const pedidos = await txQuery(
          `SELECT p.id, p.chofer_id, p.estado, p.metodo_pago, p.zona_id, p.punto_entrega_id
             FROM pedidos p
            WHERE p.id = $1
              AND p.empresa_id = $2
            FOR UPDATE`,
          [pedidoId, empresaId]
        );
        if (pedidos.length !== 1) throw deliveryHttpError(404, 'Pedido no encontrado');

        // Orden global en flujos repartidor: pedido -> chofer -> punto/zona.
        // El pedido se bloquea primero para mantener el orden ya usado por entrega;
        // el lock compartido del chofer mantiene activa la identidad hasta COMMIT.
        const choferes = await txQuery(
          `SELECT id
             FROM choferes
            WHERE id = $1
              AND empresa_id = $2
              AND activo IS TRUE
            FOR SHARE`,
          [choferId, empresaId]
        );
        if (choferes.length !== 1) throw deliveryHttpError(403, 'No autorizado');

        const pedido = pedidos[0];
        if (pedido.chofer_id != null && Number(pedido.chofer_id) !== choferId) {
          throw deliveryHttpError(403, 'Pedido asignado a otro chofer');
        }
        if (pedido.estado === 'entregado' || pedido.estado === 'cancelado') {
          throw deliveryHttpError(409, 'El pedido está finalizado y no admite cambios');
        }
        if (!Object.hasOwn(transiciones, pedido.estado)) {
          throw deliveryHttpError(409, 'Estado actual del pedido inválido');
        }
        if (pedido.chofer_id == null && pedido.estado !== 'pendiente') {
          throw deliveryHttpError(409, 'El pedido no está disponible para tomar');
        }
        if (hasEstado && !transiciones[pedido.estado].has(estado)) {
          throw deliveryHttpError(409, 'Transición de estado no permitida');
        }

        const metodoPagoFinal = hasMetodoPago ? metodoPago : pedido.metodo_pago;
        if (metodoPagoFinal === 'cuenta_corriente') {
          if (!Number.isSafeInteger(Number(pedido.punto_entrega_id)) || Number(pedido.punto_entrega_id) <= 0) {
            throw deliveryValidationError('El pedido no tiene cliente válido para cuenta corriente');
          }
          const puntos = await txQuery(
            `SELECT id, cuenta_corriente_habilitada
               FROM puntos_entrega
              WHERE id = $1
                AND empresa_id = $2
              FOR SHARE`,
            [pedido.punto_entrega_id, empresaId]
          );
          if (puntos.length !== 1 || puntos[0].cuenta_corriente_habilitada !== true) {
            throw deliveryValidationError('Este cliente no está habilitado para cuenta corriente');
          }
        }

        let zonaIdFinal = pedido.zona_id;
        let actualizarZonaPuntoEntrega = false;
        if (hasZonaId) {
          const zonas = await txQuery(
            `SELECT zona_id
               FROM zona_chofer
              WHERE chofer_id = $1
                AND empresa_id = $2
                AND zona_id = $3
              FOR SHARE`,
            [choferId, empresaId, zonaIdBody]
          );
          if (zonas.length !== 1) throw deliveryValidationError('Zona no válida para este chofer');
          zonaIdFinal = zonaIdBody;
          actualizarZonaPuntoEntrega = true;
        } else if (pedido.zona_id == null) {
          const zonas = await txQuery(
            `SELECT zona_id
               FROM zona_chofer
              WHERE chofer_id = $1
                AND empresa_id = $2
              ORDER BY zona_id
              FOR SHARE`,
            [choferId, empresaId]
          );
          if (zonas.length === 1) {
            zonaIdFinal = zonas[0].zona_id;
            actualizarZonaPuntoEntrega = true;
          }
        }

        const sets = ['chofer_id = $1'];
        const values = [choferId];
        if (hasEstado) {
          values.push(estado);
          sets.push(`estado = $${values.length}`);
        }
        if (hasMetodoPago) {
          values.push(metodoPago);
          sets.push(`metodo_pago = $${values.length}`);
        }
        if (zonaIdFinal != null && (hasZonaId || pedido.zona_id == null)) {
          values.push(zonaIdFinal);
          sets.push(`zona_id = $${values.length}`);
        }
        values.push(pedidoId, empresaId);
        const pedidoIdIndex = values.length - 1;
        const empresaIdIndex = values.length;
        if (actualizarZonaPuntoEntrega && pedido.punto_entrega_id != null) {
          const pointRows = await txQuery(
            `SELECT pe.id, pe.empresa_id,
                    to_jsonb(pe)->>'telefono' AS telefono,
                    to_jsonb(pe)->>'telefono_normalizado' AS telefono_normalizado,
                    to_jsonb(pe)->>'direccion' AS direccion
               FROM puntos_entrega pe
              WHERE pe.id = $1 AND pe.empresa_id = $2`,
            [pedido.punto_entrega_id, empresaId]
          );
          if (pointRows.length !== 1) throw deliveryHttpError(409, 'Punto de entrega inválido');
          await lockDeliveryPointRows(txQuery, {
            empresaId,
            rows: pointRows,
            normalizePhoneFn: value => String(value || '').replace(/\D+/g, ''),
          });
        }
        const actualizados = await txQuery(
          `UPDATE pedidos
              SET ${sets.join(', ')}
            WHERE id = $${pedidoIdIndex}
              AND empresa_id = $${empresaIdIndex}
              AND (chofer_id = $1 OR (chofer_id IS NULL AND estado = 'pendiente'))
          RETURNING id`,
          values
        );
        if (actualizados.length !== 1) {
          throw deliveryHttpError(409, 'El pedido cambió durante la actualización');
        }

        if (actualizarZonaPuntoEntrega && pedido.punto_entrega_id != null) {
          const puntosActualizados = await txQuery(
            `UPDATE puntos_entrega
                SET zona_id = $1
              WHERE id = $2
                AND empresa_id = $3
            RETURNING id`,
            [zonaIdFinal, pedido.punto_entrega_id, empresaId]
          );
          if (puntosActualizados.length !== 1) {
            throw deliveryHttpError(409, 'No se pudo actualizar la zona del cliente');
          }
        }
      });

      const postCommit = (fn, label) => {
        if (typeof fn !== 'function') return;
        Promise.resolve()
          .then(fn)
          .catch(error => console.error(label, error?.message || error));
      };
      if (hasEstado) {
        postCommit(() => notifyEstadoPedidoPush(pedidoId, estado), 'PUSH estado pedido error:');
      }
      if (estado === 'en_ruta' || estado === 'en_camino') {
        postCommit(() => notificarEnRuta(pedidoId, empresaId), 'Error en notificación background:');
        postCommit(
          () => ejecutarEstrategiaVecinos({ pedidoId, empresaId }),
          'Error estrategia vecinos:'
        );
      }

      return res.json({ ok: true });
    } catch (e) {
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({
          error: 'Resultado de actualización indeterminado',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
      }
      const statusCode = Number(e?.statusCode);
      if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
        return res.status(statusCode).json({ error: e.message });
      }
      console.error('UPDATE REPARTIDOR ERROR:', e);
      return res.status(500).json({ error: 'Error actualizando pedido' });
    }
  });

  router.post('/pedidos/:id/entregar', withAuth, requireExactRepartidor, async (req, res) => {
   // 1. Extracción y Validación Básica
   const { chofer_id, empresa_id, username } = req.user || {};
   const pedidoId = Number(req.params.id);
   const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
   const hasMetodoPago = Object.hasOwn(body, 'metodo_pago');
   const metodosPagoPermitidos = new Set(['efectivo', 'transferencia', 'cuenta_corriente']);
   // 'movimientos' viene del Modal de Activos del Frontend
	 const { movimientos = [], retornables = [], zona_id = null, metodo_pago = null, checklist = null, evidencia = null } = body;
   const hasZonaId = Object.hasOwn(body, 'zona_id') && zona_id != null;

   if (!chofer_id) return res.status(403).json({ error: 'No autorizado: Falta chofer_id' });
   if (!Number.isFinite(pedidoId)) return res.status(400).json({ error: 'ID de pedido inválido' });
   if (hasMetodoPago && (typeof metodo_pago !== 'string' || !metodosPagoPermitidos.has(metodo_pago))) {
     return res.status(400).json({ error: 'Método de pago inválido' });
   }
   if (hasZonaId && (!Number.isSafeInteger(zona_id) || zona_id <= 0)) {
     return res.status(400).json({ error: 'Zona inválida' });
   }

   const client = await pool.connect();
   let transactionPhase = 'before_begin';
   let releaseError = null;
   
	   try {
	     await ensureRepartidorSchema();
	     // -----------------------------------------------------
     // INICIO TRANSACCIÓN (Todo o Nada)
     // -----------------------------------------------------
     await client.query('BEGIN');
     transactionPhase = 'work';

     // 2. Lock del Pedido (Evita doble entrega concurrente)
     const pedQ = await client.query(
       `
       SELECT p.id, p.empresa_id, p.chofer_id, p.estado, p.metodo_pago, p.zona_id, p.punto_entrega_id, p.monto
       FROM pedidos p
       WHERE p.id = $1 AND p.empresa_id = $2
       FOR UPDATE OF p
       `,
       [pedidoId, empresa_id]
     );

     if (!pedQ.rows.length) {
       throw deliveryHttpError(404, 'Pedido no encontrado');
     }

     const pedido = pedQ.rows[0];
     const estadoAnterior = pedido.estado;
     const metodoPagoFinal = hasMetodoPago ? metodo_pago : pedido.metodo_pago;

     // 3. Revalidar y bloquear la identidad operativa dentro de la transacción.
     // Orden global de locks: pedido -> chofer -> punto/zona.
     const choferQ = await client.query(
       `SELECT id
          FROM choferes
         WHERE id = $1
           AND empresa_id = $2
           AND activo IS TRUE
         FOR SHARE`,
       [chofer_id, empresa_id]
     );
     if (choferQ.rows.length !== 1) {
       throw deliveryHttpError(403, 'Chofer no autorizado');
     }

     // Validar asignación: si el pedido ya tiene chofer y NO soy yo, error.
     if (pedido.chofer_id && Number(pedido.chofer_id) !== Number(chofer_id)) {
       throw deliveryHttpError(403, 'Este pedido fue tomado por otro chofer.');
     }

     // 4. Idempotencia (Si ya se entregó, salimos bien sin hacer nada)
     if (estadoAnterior === 'entregado') {
       transactionPhase = 'commit';
       await client.query('COMMIT');
       transactionPhase = 'committed';
       return res.json({ ok: true, already: true });
     }
     if (estadoAnterior !== 'en_ruta' && estadoAnterior !== 'en_camino') {
       throw deliveryHttpError(409, 'El pedido no está en un estado entregable');
     }

     if (typeof metodoPagoFinal !== 'string' || !metodosPagoPermitidos.has(metodoPagoFinal)) {
       throw deliveryHttpError(409, 'El pedido tiene un método de pago inválido');
     }

     let puntoEntrega = null;
     if (pedido.punto_entrega_id != null) {
       const puntoQ = await client.query(
         `SELECT id, cuenta_corriente_habilitada
            FROM puntos_entrega
           WHERE id = $1
             AND empresa_id = $2
           FOR SHARE`,
         [pedido.punto_entrega_id, empresa_id]
       );
       if (puntoQ.rows.length !== 1) {
         throw deliveryValidationError('El punto de entrega no pertenece a la empresa');
       }
       puntoEntrega = puntoQ.rows[0];
     }

     if (isCuentaCorrienteMethod(metodoPagoFinal)) {
       if (puntoEntrega?.cuenta_corriente_habilitada !== true) {
         throw deliveryValidationError('Este cliente no está habilitado para cuenta corriente');
       }
     }

     const checklistCompleto = checklist?.cliente_confirmado === true
       && checklist?.producto_entregado === true
       && checklist?.cobro_confirmado === true;
     if (!checklistCompleto) {
       throw deliveryValidationError('Checklist de entrega incompleto');
     }

     const movimientosNormalizados = normalizeMovimientosActivosPayload(movimientos);

     // 5. Lógica de Zona (Opcional, pero recomendada)
     let zonaIdToSet = pedido.zona_id; // Por defecto mantenemos la que tiene
     let actualizarZonaPuntoEntrega = false;

     // Si viene zona en el body, validamos que el chofer la tenga permitida,
     // aunque el pedido ya tuviera otra zona persistida.
     if (hasZonaId) {
         const zCheck = await client.query(
           `SELECT zona_id
              FROM zona_chofer
             WHERE chofer_id = $1
               AND empresa_id = $2
               AND zona_id = $3
             FOR SHARE`,
           [chofer_id, empresa_id, zona_id]
         );
         if (zCheck.rows.length !== 1) {
           throw deliveryValidationError('La zona indicada no pertenece a este chofer.');
         }
         zonaIdToSet = zona_id;
         actualizarZonaPuntoEntrega = true;
     } else if (pedido.zona_id == null) {
         // Auto-detectar si el chofer solo tiene 1 zona
         const zRows = await client.query(
           `SELECT zona_id
              FROM zona_chofer
             WHERE chofer_id = $1
               AND empresa_id = $2
             ORDER BY zona_id
             FOR SHARE`,
           [chofer_id, empresa_id]
         );
         if (zRows.rows.length === 1) {
           zonaIdToSet = zRows.rows[0].zona_id;
           actualizarZonaPuntoEntrega = true;
         }
     }

     // Orden global: pedido -> chofer -> punto/zona -> productos ordenados.
     // Esta única composición bloqueada alimenta stock, retornables y activos.
     const composicion = await loadCanonicalDeliveryComposition(client, {
       pedidoId,
       empresaId: empresa_id,
       choferId: chofer_id,
     });
     const activosRequeridos = composicion
       .filter(({ producto }) => {
         const config = producto.config_activo || {};
         return config.es_activo === true || config.es_activo === 'true'
           || config.usa_alquiler === true || config.usa_alquiler === 'true';
       })
       .map(item => ({
         item_pedido_id: item.itemPedidoId,
         producto_id: item.productoId,
         cantidad: item.cantidad,
       }));
     validateEntregasActivasRequeridas(activosRequeridos, movimientosNormalizados);

     // Recién después de validar y congelar la composición puede haber escrituras.
     if (!pedido.chofer_id) {
       const asignado = await client.query(
         `UPDATE pedidos
             SET chofer_id = $1
           WHERE id = $2
             AND empresa_id = $3
             AND chofer_id IS NULL
         RETURNING id`,
         [chofer_id, pedidoId, empresa_id]
       );
       if (asignado.rows.length !== 1) {
         throw deliveryHttpError(409, 'El pedido cambió durante el cierre');
       }
     }

     const fechaEntregaIso = new Date().toISOString();

     // 6. RETORNABLES: validar todo y bloquear saldos antes de cualquier mutación de entrega.
     const retornablesInput = normalizeRetornablesPayload(retornables);
     const retornablesPedido = new Map();
     for (const item of composicion) {
       if (item.producto.retornable !== true) continue;
       const previo = retornablesPedido.get(item.productoId) || {
         productoId: item.productoId,
         nombre: item.producto.nombre,
         entregados: 0,
       };
       previo.entregados += item.cantidad;
       retornablesPedido.set(item.productoId, previo);
     }
     for (const productoId of retornablesInput.keys()) {
       if (!retornablesPedido.has(productoId)) {
         throw deliveryValidationError('Producto retornable desconocido');
       }
     }

     const retornablesPlan = [];
     if (pedido.punto_entrega_id) {
       const retornablesOrdenados = Array.from(retornablesPedido.values()).sort((a, b) => a.productoId - b.productoId);
       for (const row of retornablesOrdenados) {
         await client.query(
           `INSERT INTO cliente_retornables_saldos
              (empresa_id, punto_entrega_id, producto_id, saldo, updated_at)
            VALUES ($1, $2, $3, 0, NOW())
            ON CONFLICT (empresa_id, punto_entrega_id, producto_id) DO NOTHING`,
           [empresa_id, pedido.punto_entrega_id, row.productoId]
         );
         const saldoQ = await client.query(
           `SELECT saldo
              FROM cliente_retornables_saldos
             WHERE empresa_id = $1
               AND punto_entrega_id = $2
               AND producto_id = $3
             FOR UPDATE`,
           [empresa_id, pedido.punto_entrega_id, row.productoId]
         );
         const saldoActualRaw = Number(saldoQ.rows?.[0]?.saldo ?? 0);
         const saldoActual = Number.isFinite(saldoActualRaw) ? saldoActualRaw : 0;
         const devueltos = retornablesInput.get(row.productoId) ?? 0;
         const saldoAntesDeDevolucion = saldoActual + row.entregados;
         const maxExigible = Math.max(0, saldoAntesDeDevolucion);
         if (devueltos > maxExigible) {
           throw deliveryValidationError('La devolución de retornables supera el máximo exigible');
         }
         retornablesPlan.push({
           productoId: row.productoId,
           entregados: row.entregados,
           devueltos,
           delta: row.entregados - devueltos,
           saldoResultante: saldoAntesDeDevolucion - devueltos,
         });
       }
     } else if (retornablesInput.size) {
       throw deliveryValidationError('El pedido no tiene cliente para registrar retornables');
     }

     // 7. PROCESAMIENTO DE ACTIVOS (FSM) - CORREGIDO
     // Usamos la función robusta que soporta transacciones externas y array de movimientos
     if (movimientosNormalizados.length > 0) {
       await registrarMovimientosActivosDesdePedido({
         dbClient: client,
         empresaId: empresa_id,
         clienteId: pedido.punto_entrega_id,
         pedidoId,
         movimientos: movimientosNormalizados,
         usuario: username || 'repartidor',
         origen: 'app_repartidor',
         estricto: true,
         itemsCanonicos: composicion,
       });
     }

     // 7. Actualizar Pedido a ENTREGADO
     if (actualizarZonaPuntoEntrega && pedido.punto_entrega_id && zonaIdToSet) {
       const pointRows = await client.query(
         `SELECT pe.id, pe.empresa_id,
                 to_jsonb(pe)->>'telefono' AS telefono,
                 to_jsonb(pe)->>'telefono_normalizado' AS telefono_normalizado,
                 to_jsonb(pe)->>'direccion' AS direccion
            FROM puntos_entrega pe
           WHERE pe.id = $1 AND pe.empresa_id = $2`,
         [pedido.punto_entrega_id, empresa_id]
       );
       if (pointRows.rows.length !== 1) throw deliveryHttpError(409, 'Punto de entrega inválido');
       const txQuery = async (sql, params = []) => (await client.query(sql, params)).rows;
       await lockDeliveryPointRows(txQuery, {
         empresaId: empresa_id,
         rows: pointRows.rows,
         normalizePhoneFn: value => String(value || '').replace(/\D+/g, ''),
       });
     }
     const pedidoActualizado = await client.query(
       `
       UPDATE pedidos
       SET estado = 'entregado',
           fecha_entrega = $2,
           cantidad_entregada = cantidad, -- Asumimos entrega total por defecto
           metodo_pago = $3,
           zona_id = COALESCE($4, zona_id)
       WHERE id = $1
         AND empresa_id = $5
         AND chofer_id = $6
         AND estado = $7
       RETURNING id
       `,
       [pedidoId, fechaEntregaIso, metodoPagoFinal, zonaIdToSet, empresa_id, chofer_id, estadoAnterior]
     );
     if (pedidoActualizado.rows.length !== 1) {
       throw deliveryHttpError(409, 'El pedido cambió durante el cierre');
     }

     // 7.b Actualizar Zona del Cliente si correspondía
     if (actualizarZonaPuntoEntrega && pedido.punto_entrega_id && zonaIdToSet) {
       const puntoActualizado = await client.query(
         `UPDATE puntos_entrega
             SET zona_id = $1
           WHERE id = $2
             AND empresa_id = $3
         RETURNING id`,
         [zonaIdToSet, pedido.punto_entrega_id, empresa_id]
       );
       if (puntoActualizado.rows.length !== 1) {
         throw new Error('No se pudo actualizar el punto de entrega del pedido');
       }
     }

     // 8. DESCUENTO DE STOCK DEL CHOFER (Consumibles / Productos vendidos)
     // Obtenemos los productos del pedido para descontarlos del inventario del chofer
     for (const it of composicion) {
       const qty = it.cantidad;
       const productoId = it.productoId;
       // PostgreSQL entrega booleanos reales; NULL/legacy y cualquier valor no booleano son finitos.
       const stockInfinito = it.producto.stock_infinito === true;
       
       if (qty > 0 && productoId && !stockInfinito) {
         // a) Descontar sólo si la fila física existe y el saldo actual alcanza.
         // El UPDATE condicionado relee el saldo después del lock compartido y evita
         // tanto crear filas negativas como perder carreras con otros writers.
         const stockWrite = await client.query(
           `
           UPDATE chofer_stock
              SET cantidad = cantidad - $4
            WHERE empresa_id = $1
              AND chofer_id = $2
              AND producto_id = $3
              AND cantidad >= $4
           RETURNING empresa_id, chofer_id, producto_id
           `,
           [empresa_id, chofer_id, productoId, qty]
         );
         if (stockWrite.rows.length !== 1) {
           throw deliveryHttpError(409, 'Stock insuficiente para completar la entrega');
         }

         // b) Registrar el movimiento exacto después del saldo.
         const movementWrite = await client.query(
           `
           INSERT INTO chofer_stock_mov
             (empresa_id, chofer_id, producto_id, cantidad, tipo, motivo, referencia, fecha)
           VALUES ($1, $2, $3, $4, 'venta', 'Entrega Pedido App', $5, $6)
           RETURNING id
           `,
           [empresa_id, chofer_id, productoId, qty, `Pedido #${pedidoId}`, fechaEntregaIso]
         );
         if (movementWrite.rows.length !== 1) throw new Error('No se pudo registrar el movimiento de stock');
       }
     }

     // 8.b RETORNABLES, fase 1: escribir todos los saldos canónicos del cliente.
     for (const plan of retornablesPlan) {
       await client.query(
         `UPDATE cliente_retornables_saldos
             SET saldo = $4, updated_at = NOW()
           WHERE empresa_id = $1
             AND punto_entrega_id = $2
             AND producto_id = $3`,
         [empresa_id, pedido.punto_entrega_id, plan.productoId, plan.saldoResultante]
       );
     }

     const txQuery = async (sql, params = []) => {
       const result = await client.query(sql, params);
       return result.rows;
     };

     // Fase 2: escribir todos los saldos del ledger genérico, todavía sin movimientos.
     for (const plan of retornablesPlan) {
       plan.ledgerInput = {
         empresaId: empresa_id,
         sujetoTipo: 'cliente',
         sujetoId: pedido.punto_entrega_id,
         productoId: plan.productoId,
         deltaSaldo: plan.delta,
         saldoObjetivo: plan.saldoResultante,
         cantidadLlenos: plan.entregados,
         cantidadVacios: plan.devueltos,
         pedidoId,
         choferId: chofer_id,
         tipo: 'entrega_cliente',
         origen: 'pedido',
         referencia: `Pedido #${pedidoId}`,
         observacion: `Entrega Pedido #${pedidoId}: +${plan.entregados} llenos / -${plan.devueltos} vacíos`,
         fecha: fechaEntregaIso,
         createdBy: username || req.user?.id || null,
       };
       plan.ledgerSaldoResultante = await actualizarRetornableSaldo(txQuery, plan.ledgerInput);
     }

     // Fase 3: recién con ambos conjuntos de saldos escritos, insertar los movimientos.
     for (const plan of retornablesPlan) {
       await client.query(
         `
         INSERT INTO cliente_retornables_movimientos
           (empresa_id, punto_entrega_id, pedido_id, chofer_id, producto_id, entregados, devueltos, delta, saldo_resultante, observacion, fecha)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         `,
         [
           empresa_id,
           pedido.punto_entrega_id,
           pedidoId,
           chofer_id,
           plan.productoId,
           plan.entregados,
           plan.devueltos,
           plan.delta,
           plan.saldoResultante,
           plan.ledgerInput.observacion,
           fechaEntregaIso,
         ]
       );
       await insertarRetornableMovimiento(
         txQuery,
         plan.ledgerInput,
         plan.ledgerSaldoResultante
       );
     }

     // 8.c Evidencia/checklist opcional de entrega
     const checklistSafe = (checklist && typeof checklist === 'object') ? checklist : {};
     const evidenciaSafe = (evidencia && typeof evidencia === 'object') ? evidencia : {};
     if (Object.keys(checklistSafe).length || Object.keys(evidenciaSafe).length) {
       await client.query(
         `INSERT INTO entregas_evidencias (empresa_id, pedido_id, chofer_id, checklist, evidencia, updated_at)
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, NOW())
          ON CONFLICT (pedido_id)
          DO UPDATE SET
            checklist = EXCLUDED.checklist,
            evidencia = EXCLUDED.evidencia,
            chofer_id = EXCLUDED.chofer_id,
            updated_at = NOW()`,
         [empresa_id, pedidoId, chofer_id || null, JSON.stringify(checklistSafe), JSON.stringify(evidenciaSafe)]
       );
     }

     let solicitarComprobanteTransferencia = false;
     if (isTransferenciaMethod(metodoPagoFinal)) {
       const comprobantesQ = await client.query(
         `SELECT archivo_path, comprobante_path, validado, procesado, estado_revision
            FROM comprobantes_transferencia
           WHERE pedido_id = $1
             AND empresa_id = $2`,
         [pedidoId, empresa_id]
       );
       solicitarComprobanteTransferencia = !comprobantesQ.rows.some(comprobanteBloqueaSolicitud);
     }

     // -----------------------------------------------------
     // FIN TRANSACCIÓN
     // -----------------------------------------------------
     transactionPhase = 'commit';
     await client.query('COMMIT');
     transactionPhase = 'committed';

     // 9. Tareas Post-Entrega (Fuera del hilo principal)
     
     // Notificación Push
     runPostCommitTask(
       () => notifyEstadoPedidoPush(pedidoId, 'entregado'),
       'PUSH estado pedido error:'
     );
     
     // Marketing (Referidos, Puntos)
     if (typeof ejecutarRecompensaReferido === 'function') {
       runPostCommitTask(
         () => ejecutarRecompensaReferido({ pedidoId, empresaId: empresa_id }),
         'REFERIDOS.RECOMPENSA.ERROR'
       );
     }
     if (typeof ejecutarEstrategiaReferidos === 'function') {
       runPostCommitTask(
         () => ejecutarEstrategiaReferidos({ pedidoId, empresaId: empresa_id }),
         'REFERIDOS.ESTRATEGIA.ERROR'
       );
     }

     if (typeof ejecutarPostEntregaUpsell === 'function') {
       runPostCommitTask(
         () => ejecutarPostEntregaUpsell({ pedidoId, empresaId: empresa_id }),
         'MARKETING.POSTENTREGA.ERROR'
       );
     }

     // Programa de puntos (idempotente por pedido)
     if (typeof awardPointsForDeliveredOrder === 'function') {
       runPostCommitTask(
         () => awardPointsForDeliveredOrder({
           queryFn: query,
           empresaId: empresa_id,
           puntoEntregaId: pedido.punto_entrega_id,
           pedidoId,
           monto: pedido.monto,
         }),
         'POINTS.AWARD.ERROR'
       );
     }

     if (typeof generateComisionesForDeliveredOrder === 'function') {
       runPostCommitTask(
         () => generateComisionesForDeliveredOrder({
           queryFn: query,
           empresaId: empresa_id,
           pedidoId,
         }),
         'REFERENTES.COMISION.ERROR'
       );
     }

     // Solicitar comprobante solo después de confirmar la entrega. Un fallo de
     // WhatsApp no puede revertir la transacción ya confirmada.
     if (solicitarComprobanteTransferencia && typeof notificarPedidoTransferencia === 'function') {
       runPostCommitTask(
         () => notificarPedidoTransferencia(pedidoId, empresa_id),
         'ENTREGA.TRANSFERENCIA.NOTIFICACION.ERROR'
       );
     }

     res.json({ ok: true });

   } catch (e) {
     if (transactionPhase === 'commit') {
       releaseError = e;
       console.error('POST /entregar COMMIT con resultado indeterminado');
       return res.status(503).json({
         error: 'Resultado de entrega indeterminado',
         code: 'TRANSACTION_OUTCOME_UNKNOWN',
       });
     }

     if (transactionPhase === 'work') {
       try {
         await client.query('ROLLBACK');
       } catch (rollbackError) {
         releaseError = rollbackError;
         console.error('POST /entregar ROLLBACK falló; conexión descartada');
       }
     }

     console.error('POST /entregar ERROR CRÍTICO:', e);
     if (e?.code === 'ACTIVOS_VALIDATION') {
       return res.status(400).json({ error: 'Movimientos de activos inválidos' });
     }
     const statusCode = Number(e?.statusCode);
     if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
       return res.status(statusCode).json({ error: e.message });
     }
     if (e.message && e.message.includes('No autorizado')) {
       return res.status(403).json({ error: e.message });
     }
     return res.status(500).json({ error: 'Error al procesar la entrega' });
   } finally {
     client.release(releaseError || undefined);
   }
});

// 3. Endpoint retirado: los movimientos de activos sólo se aceptan dentro del cierre atómico.
  router.post('/pedidos/:id/activos-movimientos', withAuth, requireExactRepartidor, (_req, res) => {
    return res.status(410).json({
      error: 'Endpoint retirado; use el cierre de entrega del pedido',
      code: 'ACTIVOS_MOVIMIENTOS_REQUIERE_CIERRE',
    });
  });

// 4. Resumen de activos asociados a un pedido (para el modal del repartidor)
  router.get('/pedidos/:id/activos-resumen', withAuth, requireExactRepartidor, async (req, res) => {
   try {
     const { chofer_id, empresa_id } = req.user || {};
     const pedidoId = Number(req.params.id);
     if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0) {
       return res.status(400).json({ error: 'Pedido inválido' });
     }

     const summary = await withTransaction(async txQuery => {
       const pedRows = await txQuery(
         `SELECT p.id, p.monto, p.metodo_pago, p.chofer_id, p.punto_entrega_id,
                 pe.cliente, COALESCE(pe.direccion_completa, pe.direccion) AS direccion
            FROM pedidos p
            JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id AND pe.empresa_id = p.empresa_id
           WHERE p.id = $1 AND p.empresa_id = $2 AND p.chofer_id = $3
           FOR SHARE OF p, pe`,
         [pedidoId, empresa_id, chofer_id]
       );
       if (pedRows.length !== 1) throw deliveryHttpError(404, 'Pedido no encontrado');
       const pedido = pedRows[0];

       const rawItems = await txQuery(
         `SELECT ip.id AS item_pedido_id, ip.producto_id, ip.producto,
                 ip.cantidad, ip.precio_unitario
            FROM items_pedido ip
           WHERE ip.pedido_id = $1
           ORDER BY ip.id`,
         [pedidoId]
       );
       const resolvedItems = await resolveProductIdentityItems(txQuery, {
         empresaId: empresa_id,
         items: rawItems,
       });
       const itemsRows = resolvedItems.map(item => ({
         ...item,
         producto_id: item.producto_resuelto_id,
         config_activo: item.producto_resuelto.config_activo,
         retornable: item.producto_resuelto.retornable === true,
         producto_nombre: item.producto_resuelto.nombre,
       }));

       const items_activos = itemsRows
       .filter(r => {
         const cfg = r.config_activo || {};
         const esActivo =
           cfg.es_activo === true ||
           cfg.es_activo === 'true' ||
           cfg.usa_alquiler === true ||
           cfg.usa_alquiler === 'true';
         return esActivo;
       })
       .map(r => ({
         item_pedido_id: r.item_pedido_id,
         producto_id: r.producto_id,
         producto: r.producto,
         cantidad: Number(r.cantidad) || 0,
         precio_unitario: Number(r.precio_unitario) || 0
       }));

       const retornablesMap = new Map();
       for (const r of itemsRows) {
       if (!r.retornable || !r.producto_id) continue;
       const productoId = Number(r.producto_id);
       const prev = retornablesMap.get(productoId) || {
         producto_id: productoId,
         producto: r.producto_nombre || r.producto || `Producto #${productoId}`,
         cantidad_entregada: 0,
         saldo_actual: 0,
         sugerido_devolver: 0,
       };
       prev.cantidad_entregada += Number(r.cantidad || 0);
       retornablesMap.set(productoId, prev);
       }

       const items_retornables = Array.from(retornablesMap.values()).filter(r => r.cantidad_entregada > 0);
       if (items_retornables.length && pedido.punto_entrega_id) {
         const saldos = await txQuery(
         `
         SELECT producto_id, saldo
         FROM cliente_retornables_saldos
         WHERE empresa_id = $1
           AND punto_entrega_id = $2
           AND producto_id = ANY($3::int[])
         `,
         [empresa_id, pedido.punto_entrega_id, items_retornables.map(r => r.producto_id)]
       );
         const saldoByProducto = new Map((saldos || []).map(r => [Number(r.producto_id), Number(r.saldo || 0)]));
         for (const item of items_retornables) {
         item.saldo_actual = Number(saldoByProducto.get(Number(item.producto_id)) || 0);
         item.sugerido_devolver = Math.min(item.cantidad_entregada, Math.max(0, item.saldo_actual + item.cantidad_entregada));
         }
       }

       const retornables_resumen = {
       items: items_retornables,
       total_entregado: items_retornables.reduce((a, r) => a + Number(r.cantidad_entregada || 0), 0),
       saldo_previo_total: items_retornables.reduce((a, r) => a + Number(r.saldo_actual || 0), 0),
       };

       if (items_activos.length === 0) {
         return {
         pedido: {
           id: pedido.id,
           cliente: pedido.cliente,
           direccion: pedido.direccion,
           monto: Number(pedido.monto) || 0,
           metodo_pago: pedido.metodo_pago || null
           },
         items_activos,
         retornables_resumen,
         activos_cliente: [],
         activos_disponibles: [],
         movimientos_existentes: []
         };
       }

       const activosClienteRows = await txQuery(
       `
       SELECT 
         a.id,
         a.codigo,
         a.tipo,
         a.estado,
         a.producto_id,
         a.numero_serie,
         a.alquiler_mensual
       FROM empresa_activos a
       WHERE a.empresa_id = $1
         AND a.cliente_id = $2
         AND a.estado IN ('prestado','reparacion','disponible')
       ORDER BY a.estado, a.codigo
       `,
       [empresa_id, pedido.punto_entrega_id]
     );

     // Activos disponibles para cambio (sin cliente asignado)
       const activosDisponiblesRows = await txQuery(
       `
       SELECT 
         a.id,
         a.codigo,
         a.tipo,
         a.estado,
         a.producto_id,
         a.numero_serie,
         a.alquiler_mensual
       FROM empresa_activos a
       WHERE a.empresa_id = $1
         AND a.cliente_id IS NULL
         AND a.estado = 'disponible'
       ORDER BY a.codigo
       `,
       [empresa_id]
     );

     // Movimientos ya registrados de este pedido
       const movRows = await txQuery(
       `
       SELECT 
         id,
         activo_id,
         activo_relacionado_id,
         tipo_operacion,
         estado,
         observacion,
         accion_at_utc
       FROM pedido_activos
       WHERE empresa_id = $1
         AND pedido_id = $2
       ORDER BY accion_at_utc DESC, id DESC
       `,
       [empresa_id, pedidoId]
     );

       return {
       pedido: {
         id: pedido.id,
         cliente: pedido.cliente,
         direccion: pedido.direccion,
         monto: Number(pedido.monto) || 0,
         metodo_pago: pedido.metodo_pago || null
         },
       items_activos,
       retornables_resumen,
       activos_cliente: activosClienteRows || [],
       activos_disponibles: activosDisponiblesRows || [],
       movimientos_existentes: movRows || []
       };
     });
     return res.json(summary);
   } catch (e) {
     if (e?.code === 'PRODUCT_IDENTITY_CONFLICT') {
       return res.status(409).json({ error: e.message, code: e.code });
     }
     if (Number.isInteger(e?.statusCode) && e.statusCode >= 400 && e.statusCode < 500) {
       return res.status(e.statusCode).json({ error: e.message });
     }
     console.error('REPARTIDOR activos-resumen ERROR:', e);
     return res.status(500).json({ error: 'Error cargando activos del pedido' });
   }
});

  router.get('/activos/stock-disponible', withAuth, requireExactRepartidor, async (req, res) => {
   const { chofer_id, empresa_id } = req.user || {};
   if (!chofer_id) return res.status(403).json({ error: 'No autorizado' });

   const rows = await query(
     `
     SELECT id, codigo, tipo, estado, marca, modelo, producto_id, alquiler_mensual
     FROM empresa_activos
     WHERE empresa_id = $1
       AND estado = 'disponible'
       AND cliente_id IS NULL
     ORDER BY id DESC
     `,
     [empresa_id]
   );

   res.json({ ok: true, data: rows });
});

// Repartidor stats (resumen-dia, pago-dia) movidos a src/routes/repartidorStats.js

// 8. Tomar pedido vacante (chofer_id IS NULL)
  router.post('/tomar/:id', withAuth, requireExactRepartidor, async (req, res) => {
   try {
     const { role, chofer_id: choferId, empresa_id: empresaId } = req.user || {};
     if (role !== 'repartidor'
         || !Number.isSafeInteger(choferId) || choferId <= 0
         || !Number.isSafeInteger(empresaId) || empresaId <= 0) {
       return res.status(403).json({ error: 'No autorizado' });
     }

     const pedidoId = Number(req.params.id);
     if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0) {
       return res.status(400).json({ error: 'ID inválido' });
     }
     if (typeof withTransaction !== 'function') {
       throw new Error('Transacción no disponible');
     }

     const outcome = await withTransaction(async txQuery => {
       // Orden global en flujos repartidor: pedido -> chofer -> punto/zona.
       const pedidoRows = await txQuery(
         `SELECT id
            FROM pedidos
           WHERE id = $1
             AND empresa_id = $2
             AND chofer_id IS NULL
             AND estado = 'pendiente'
           FOR UPDATE`,
         [pedidoId, empresaId]
       );
       if (pedidoRows.length !== 1) return 'unavailable';

       const choferRows = await txQuery(
         `SELECT id
            FROM choferes
           WHERE id = $1
             AND empresa_id = $2
             AND activo IS TRUE
           FOR SHARE`,
         [choferId, empresaId]
       );
       if (choferRows.length !== 1) return 'invalid-driver';

       const result = await txQuery(
         `UPDATE pedidos
             SET chofer_id = $1
           WHERE id = $2
             AND empresa_id = $3
             AND chofer_id IS NULL
             AND estado = 'pendiente'
         RETURNING id`,
         [choferId, pedidoId, empresaId]
       );
       return result.length === 1 ? 'taken' : 'unavailable';
     });

     if (outcome === 'invalid-driver') return res.status(403).json({ error: 'No autorizado' });
     if (outcome !== 'taken') return res.status(404).json({ error: 'Pedido no disponible' });

     res.json({ ok: true });
   } catch (e) {
     if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
       return res.status(503).json({
         error: 'Resultado de toma indeterminado',
         code: 'TRANSACTION_OUTCOME_UNKNOWN',
       });
     }
     console.error('REPARTIDOR TOMAR ERROR:', e);
     res.status(500).json({ error: 'Error al tomar pedido' });
   }
});

// 9. OPTIMIZADOR DE RUTA (PostGIS Nearest Neighbor)
  router.post('/optimizar-ruta', withAuth, requireExactRepartidor, async (req, res) => {
     try {
       const { lat, lng } = req.body;
       const { chofer_id, empresa_id } = req.user;

       if (!chofer_id) return res.status(403).json({ error: 'Solo para choferes' });
       if (!lat || !lng) return res.status(400).json({ error: 'Faltan coordenadas actuales' });

       // ---------------------------------------------------------
       // ALGORITMO NEAREST NEIGHBOR EN SQL PURO (RECURSIVO)
       // ---------------------------------------------------------
       // 1. Seleccionamos los pedidos pendientes con ubicación válida.
       // 2. Usamos una CTE recursiva para saltar de punto en punto.
       //    El operador "<->" de PostGIS ordena por distancia geométrica (índice GiST).
       
       const sql = `
         WITH RECURSIVE 
         -- 1. Puntos a visitar (Pendientes del chofer)
         puntos AS (
             SELECT 
                 p.id, 
                 pe.latitud, 
                 pe.longitud,
                 pe.direccion,
                 pe.cliente,
                 p.fecha
             FROM pedidos p
             JOIN puntos_entrega pe
               ON pe.id = p.punto_entrega_id
              AND pe.empresa_id = p.empresa_id
             WHERE p.chofer_id = $1
               AND p.empresa_id = $4
               AND p.estado IN ('pendiente', 'en_ruta', 'en_camino')
               AND pe.latitud IS NOT NULL 
               AND pe.longitud IS NOT NULL
         ),
         -- 2. Ruta recursiva
         ruta AS (
             -- ANCLA: Buscamos el primer punto más cercano a la ubicación ACTUAL del chofer ($2, $3)
             (
                 SELECT 
                     id, latitud, longitud, direccion, cliente, fecha,
                     1::int as orden,
                     ARRAY[id] as visitados -- Array para no repetir
                 FROM puntos
                 ORDER BY 
                     -- Distancia entre punto pedido y ubicación chofer
                     ST_SetSRID(ST_MakePoint(longitud, latitud), 4326) <-> ST_SetSRID(ST_MakePoint($3, $2), 4326)
                 LIMIT 1
             )
             
             UNION ALL
             
             -- RECURSIÓN: Desde el último punto encontrado (prev), buscar el siguiente más cercano
             (
                 SELECT 
                     next.id, next.latitud, next.longitud, next.direccion, next.cliente, next.fecha,
                     prev.orden + 1,
                     prev.visitados || next.id
                 FROM puntos next, ruta prev
                 WHERE NOT (next.id = ANY(prev.visitados)) -- Que no haya sido visitado
                 ORDER BY 
                     -- Distancia entre el siguiente y el anterior
                     ST_SetSRID(ST_MakePoint(next.longitud, next.latitud), 4326) <-> ST_SetSRID(ST_MakePoint(prev.longitud, prev.latitud), 4326)
                 LIMIT 1
             )
         )
         SELECT * FROM ruta;
       `;

       const rutaOptimizada = await query(sql, [chofer_id, lat, lng, empresa_id]);

       // Si no hay ruta (ej: no hay pedidos o no tienen coords), devolvemos lista vacía
       res.json({ 
         ok: true, 
         ruta: rutaOptimizada 
       });

     } catch (e) {
       console.error('ERROR OPTIMIZADOR:', e);
       res.status(500).json({ error: 'Error optimizando ruta' });
     }
}); 


  return router;
}
