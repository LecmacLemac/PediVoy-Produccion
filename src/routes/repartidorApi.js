// src/routes/repartidorApi.js
// API Repartidor (dashboard chofer) — extraído desde server.js

import express from 'express';
import { awardPointsForDeliveredOrder } from '../services/puntosService.js';

export function createRepartidorApiRouter(deps) {
  const { query, pool, withAuth, getEmpresaIdFromToken, notifyEstadoPedidoPush, notificarEnRuta, notificarPedidoTransferencia, ejecutarEstrategiaVecinos, registrarMovimientosActivosDesdePedido } = deps || {};
  if (typeof query !== 'function') throw new Error('createRepartidorApiRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createRepartidorApiRouter: falta withAuth(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createRepartidorApiRouter: falta getEmpresaIdFromToken(fn)');
  // pool + helpers opcionales: usados por algunas rutas

  const router = express.Router();

// 1. Obtener Pedidos
  router.get('/pedidos', withAuth, async (req, res) => {
   try {
     const { chofer_id } = req.user;
     const empresaId = getEmpresaIdFromToken(req); // mismo criterio que el dashboard

     if (req.user.role === 'repartidor' && !chofer_id) {
       return res.status(403).json({ error: 'Usuario repartidor sin chofer vinculado.' });
     }

     // MEJORA: Filtramos los entregados para no traer historial de hace meses
     // Traemos:
     // 1. Todo lo que NO esté entregado/cancelado (pendiente, en_ruta, en_camino)
     // 2. O lo que esté entregado/cancelado PERO haya sido modificado recientemente (ej. últimos 2 días)
     //    Usamos p.fecha como fallback si fecha_entrega es null
     
     const rows = await query(
       `SELECT 
          p.id, p.estado, p.fecha, p.fecha_entrega,
          p.cantidad, p.monto, p.metodo_pago, p.chofer_id,
          pe.cliente, pe.direccion, pe.ciudad, pe.telefono,
          pe.latitud, pe.longitud, pe.notas AS notas,
          pe.zona_id, z.nombre AS zona_nombre
        FROM pedidos p
        JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
        LEFT JOIN zonas_geograficas z ON pe.zona_id = z.id
        WHERE pe.empresa_id = $2
          AND (p.chofer_id = $1 OR p.chofer_id IS NULL)
          AND (
            -- CASO A: Pedidos activos (traer todos)
            p.estado IN ('pendiente', 'en_ruta', 'en_camino')
            OR 
            -- CASO B: Pedidos finalizados recientes (ej: últimos 2 días para permitir ver resumen de ayer)
            (
              p.estado IN ('entregado', 'cancelado') 
              AND (
                 (p.fecha_entrega IS NOT NULL AND p.fecha_entrega >= NOW() - INTERVAL '2 days')
                 OR 
                 (p.fecha >= NOW() - INTERVAL '2 days')
              )
            )
          )
        ORDER BY p.id ASC`,
       [chofer_id, empresaId]
     );

     // Inyectar ítems...
     for (let pedido of rows) {
       // ⬇️ AQUÍ ESTÁ EL CAMBIO: Agregamos precio_unitario a la consulta
       const items = await query(
         `SELECT producto, cantidad, precio_unitario FROM items_pedido WHERE pedido_id=$1`,
         [pedido.id]
       );
       pedido.items = items;
     }

     res.json(rows);
   } catch (e) {
     console.error('REPARTIDOR PEDIDOS ERROR:', e);
     res.status(500).json({ error: 'Error cargando pedidos' });
   }
});

// 2. Actualizar Estado o Pago (PUT) - Para los botones del repartidor
  router.put('/pedidos/:id', withAuth, async (req, res) => {
   try {
     // 1. Usuario autenticado
     const { chofer_id, empresa_id } = req.user;
     const pedidoId = req.params.id;

     // 👇 Primero leemos el body
     const { estado, metodo_pago, zona_id: zonaIdBody } = req.body || {};

     // 👇 Guard correcto (después de leer estado)
     if (estado && String(estado).toLowerCase() === 'entregado') {
       return res
         .status(400)
         .json({ error: 'Usá POST /api/repartidor/pedidos/:id/entregar' });
     }

     if (!chofer_id) {
       return res.status(403).json({ error: 'No autorizado' });
     }

     // 2. Verificar el pedido (SUMÁ empresa_id para multi-tenant)
     const rows = await query(
       `SELECT chofer_id, metodo_pago, estado, zona_id, punto_entrega_id
          FROM pedidos
         WHERE id = $1 AND empresa_id = $2`,
       [pedidoId, empresa_id]
     );

     if (!rows.length) {
       return res.status(404).json({ error: 'Pedido no encontrado' });
     }

     const pedido             = rows[0];
     const actualChofer       = pedido.chofer_id;
     const metodoPagoAnterior = (pedido.metodo_pago || '').toLowerCase();
     const estadoAnterior     = (pedido.estado || '').toLowerCase();
     const teniaZonaAntes     = pedido.zona_id != null;
     const puntoEntregaId     = pedido.punto_entrega_id;

     // 3. Si ya está asignado a OTRO chofer, bloquear
     if (actualChofer && actualChofer !== chofer_id) {
       return res.status(403).json({ error: 'Pedido asignado a otro chofer' });
     }

     // 4. Si no tiene chofer, lo tomo para mí de forma segura
     if (!actualChofer) {
       const taken = await query(
         `UPDATE pedidos
            SET chofer_id = $1
          WHERE id = $2
            AND empresa_id = $3
            AND chofer_id IS NULL
          RETURNING id`,
         [chofer_id, pedidoId, empresa_id]
       );

       if (!taken.length) {
         return res.status(400).json({ error: 'El pedido ya fue tomado por otro.' });
       }
     }

     // 🔁 LOGICA DE ZONA (solo si el pedido venía SIN zona)
     let zonaIdToSet = null;
     let actualizarZonaPuntoEntrega = false;

     if (!teniaZonaAntes) {
       // PRIORIDAD 1: el front mandó zona explícita
       if (zonaIdBody) {
         const zCheck = await query(
           `
           SELECT zona_id
             FROM zona_chofer
            WHERE chofer_id = $1
              AND empresa_id = $2
              AND zona_id = $3
           `,
           [chofer_id, empresa_id, zonaIdBody]
         );

         if (!zCheck.length) {
           return res.status(400).json({ error: 'Zona no válida para este chofer' });
         }

         zonaIdToSet = zonaIdBody;
         actualizarZonaPuntoEntrega = true;
       } else {
         // PRIORIDAD 2: el chofer tiene exactamente 1 zona → auto-asignar
         const zRows = await query(
           `
           SELECT zona_id
             FROM zona_chofer
            WHERE chofer_id = $1
              AND empresa_id = $2
           `,
           [chofer_id, empresa_id]
         );

         if (zRows.length === 1) {
           zonaIdToSet = zRows[0].zona_id;
           actualizarZonaPuntoEntrega = true;
         }
       }
     }

     // 5. Armar UPDATE (SIN entregado)
     const sets = [];
     const vals = [];
     let idx = 1;

     if (estado) {
       sets.push(`estado = $${idx++}`);
       vals.push(estado);
     }

     if (metodo_pago) {
       sets.push(`metodo_pago = $${idx++}`);
       vals.push(metodo_pago);
     }

     if (zonaIdToSet != null) {
       sets.push(`zona_id = $${idx++}`);
       vals.push(zonaIdToSet);
     }

     if (sets.length) {
       vals.push(pedidoId, empresa_id);
       await query(
         `UPDATE pedidos SET ${sets.join(', ')} WHERE id = $${idx++} AND empresa_id = $${idx}`,
         vals
       );

       // si definimos zona, actualizamos punto_entrega
       if (zonaIdToSet != null && actualizarZonaPuntoEntrega && puntoEntregaId) {
         try {
           await query(
             `UPDATE puntos_entrega
                 SET zona_id = $1
               WHERE id = $2`,
             [zonaIdToSet, puntoEntregaId]
           );
         } catch (err) {
           console.error('Error actualizando zona en punto_entrega:', err);
         }
       }

       // 🔔 PUSH cambio de estado (si aplica)
       if (estado) {
         notifyEstadoPedidoPush(pedidoId, estado).catch(err =>
           console.error('PUSH estado pedido error:', err)
         );
       }

       // CASO B: EN RUTA / EN CAMINO
       if (estado === 'en_ruta' || estado === 'en_camino') {
         notificarEnRuta(pedidoId, empresa_id).catch(err =>
           console.error('Error en notificación background:', err)
         );

         ejecutarEstrategiaVecinos({
           pedidoId: pedidoId,
           empresaId: empresa_id
         }).catch(err => console.error('Error estrategia vecinos:', err));
       }

       // CASO C: CAMBIO A TRANSFERENCIA
       if (
         metodo_pago &&
         metodo_pago.toLowerCase().includes('trans') &&
         !metodoPagoAnterior.includes('trans')
       ) {
         notificarPedidoTransferencia(pedidoId, empresa_id).catch(err =>
           console.error('Error en notificación transferencia pedido:', err)
         );
       }
     }

     res.json({ ok: true });
   } catch (e) {
     console.error('UPDATE REPARTIDOR ERROR:', e);
     res.status(500).json({ error: 'Error actualizando pedido' });
   }
});

  router.post('/pedidos/:id/entregar', withAuth, async (req, res) => {
   // 1. Extracción y Validación Básica
   const { chofer_id, empresa_id, username } = req.user || {};
   const pedidoId = Number(req.params.id);
   // 'movimientos' viene del Modal de Activos del Frontend
   const { movimientos = [], zona_id = null, metodo_pago = null } = req.body || {};

   if (!chofer_id) return res.status(403).json({ error: 'No autorizado: Falta chofer_id' });
   if (!Number.isFinite(pedidoId)) return res.status(400).json({ error: 'ID de pedido inválido' });

   const client = await pool.connect();
   
   try {
     // -----------------------------------------------------
     // INICIO TRANSACCIÓN (Todo o Nada)
     // -----------------------------------------------------
     await client.query('BEGIN');

     // 2. Lock del Pedido (Evita doble entrega concurrente)
     const pedQ = await client.query(
       `
       SELECT id, empresa_id, chofer_id, estado, metodo_pago, zona_id, punto_entrega_id, monto
       FROM pedidos
       WHERE id = $1 AND empresa_id = $2
       FOR UPDATE
       `,
       [pedidoId, empresa_id]
     );

     if (!pedQ.rows.length) {
       await client.query('ROLLBACK');
       return res.status(404).json({ error: 'Pedido no encontrado' });
     }

     const pedido = pedQ.rows[0];
     const estadoAnterior = String(pedido.estado || '').toLowerCase();
     const metodoPagoAnterior = String(pedido.metodo_pago || '').toLowerCase();

     // 3. Validar Asignación de Chofer
     // Si el pedido ya tiene chofer y NO soy yo, error.
     if (pedido.chofer_id && Number(pedido.chofer_id) !== Number(chofer_id)) {
       await client.query('ROLLBACK');
       return res.status(403).json({ error: 'Este pedido fue tomado por otro chofer.' });
     }
     
     // Si no tiene chofer (ej: auto-asignación al entregar), me lo asigno.
     if (!pedido.chofer_id) {
       await client.query(
         `UPDATE pedidos SET chofer_id = $1 WHERE id = $2`,
         [chofer_id, pedidoId]
       );
     }

     // 4. Idempotencia (Si ya se entregó, salimos bien sin hacer nada)
     if (estadoAnterior === 'entregado') {
       await client.query('COMMIT');
       return res.json({ ok: true, already: true });
     }

     // 5. Lógica de Zona (Opcional, pero recomendada)
     let zonaIdToSet = pedido.zona_id; // Por defecto mantenemos la que tiene
     let actualizarZonaPuntoEntrega = false;

     if (pedido.zona_id == null) {
       // Si viene zona en el body, validamos que el chofer la tenga permitida
       if (zona_id != null) {
         const zCheck = await client.query(
           `SELECT zona_id FROM zona_chofer WHERE chofer_id = $1 AND zona_id = $2`,
           [chofer_id, zona_id]
         );
         if (!zCheck.rows.length) {
           await client.query('ROLLBACK');
           return res.status(400).json({ error: 'La zona indicada no pertenece a este chofer.' });
         }
         zonaIdToSet = zona_id;
         actualizarZonaPuntoEntrega = true;
       } else {
         // Auto-detectar si el chofer solo tiene 1 zona
         const zRows = await client.query(
           `SELECT zona_id FROM zona_chofer WHERE chofer_id = $1 AND empresa_id = $2`,
           [chofer_id, empresa_id]
         );
         if (zRows.rows.length === 1) {
           zonaIdToSet = zRows.rows[0].zona_id;
           actualizarZonaPuntoEntrega = true;
         }
       }
     }

     const fechaEntregaIso = new Date().toISOString();

     // 6. PROCESAMIENTO DE ACTIVOS (FSM) - CORREGIDO
     // Usamos la función robusta que soporta transacciones externas y array de movimientos
     if (Array.isArray(movimientos) && movimientos.length > 0) {
       await registrarMovimientosActivosDesdePedido({
         dbClient: client,              // Pasamos el cliente de la transacción
         empresaId: empresa_id,
         clienteId: pedido.punto_entrega_id,
         pedidoId: pedidoId,
         movimientos: movimientos,      // Array de { activo_id, tipo, ... }
         usuario: username || 'repartidor',
         origen: 'app_repartidor'
       });
     }

     // 7. Actualizar Pedido a ENTREGADO
     await client.query(
       `
       UPDATE pedidos
       SET estado = 'entregado',
           fecha_entrega = $2,
           cantidad_entregada = cantidad, -- Asumimos entrega total por defecto
           metodo_pago = COALESCE($3, metodo_pago),
           zona_id = COALESCE($4, zona_id)
       WHERE id = $1
       `,
       [pedidoId, fechaEntregaIso, metodo_pago, zonaIdToSet]
     );

     // 7.b Actualizar Zona del Cliente si correspondía
     if (actualizarZonaPuntoEntrega && pedido.punto_entrega_id && zonaIdToSet) {
       await client.query(
         `UPDATE puntos_entrega SET zona_id = $1 WHERE id = $2`,
         [zonaIdToSet, pedido.punto_entrega_id]
       );
     }

     // 8. DESCUENTO DE STOCK DEL CHOFER (Consumibles / Productos vendidos)
     // Obtenemos los productos del pedido para descontarlos del inventario del chofer
     const itemsQ = await client.query(
       `
       SELECT ip.cantidad, p.id AS producto_id
       FROM items_pedido ip
       JOIN productos p ON p.empresa_id = $2 AND LOWER(TRIM(p.nombre)) = LOWER(TRIM(ip.producto))
       WHERE ip.pedido_id = $1
       `,
       [pedidoId, empresa_id]
     );

     for (const it of itemsQ.rows) {
       const qty = Number(it.cantidad) || 0;
       const productoId = it.producto_id;
       
       if (qty > 0 && productoId) {
         // a) Registrar Movimiento (Historial)
         await client.query(
           `
           INSERT INTO chofer_stock_mov
             (empresa_id, chofer_id, producto_id, cantidad, tipo, motivo, referencia, fecha)
           VALUES ($1, $2, $3, $4, 'venta', 'Entrega Pedido App', $5, $6)
           `,
           [empresa_id, chofer_id, productoId, qty, `Pedido #${pedidoId}`, fechaEntregaIso]
         );

         // b) Restar del Stock Físico (UPSERT negativo)
         await client.query(
           `
           INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
           VALUES ($1, $2, $3, $4) 
           ON CONFLICT (empresa_id, chofer_id, producto_id)
           DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
           `,
           [empresa_id, chofer_id, productoId, -qty] // -qty para restar
         );
       }
     }

     // -----------------------------------------------------
     // FIN TRANSACCIÓN
     // -----------------------------------------------------
     await client.query('COMMIT');

     // 9. Tareas Post-Entrega (Fuera del hilo principal)
     
     // Notificación Push
     notifyEstadoPedidoPush(pedidoId, 'entregado').catch(console.error);
     
     // Marketing (Referidos, Puntos)
     import('./src/estrategias.js')
       .then(({ ejecutarRecompensaReferido, ejecutarEstrategiaReferidos }) => {
         ejecutarRecompensaReferido({ pedidoId, empresaId: empresa_id }).catch(() => {});
         ejecutarEstrategiaReferidos({ pedidoId, empresaId: empresa_id }).catch(() => {});
       })
       .catch(() => {});

     // Programa de puntos (idempotente por pedido)
     awardPointsForDeliveredOrder({
       queryFn: query,
       empresaId: empresa_id,
       puntoEntregaId: pedido.punto_entrega_id,
       pedidoId,
       monto: pedido.monto,
     }).catch((err) => console.error('POINTS.AWARD.ERROR', err?.message || err));

     // Notificar cambio a Transferencia si aplica
     if (metodo_pago && String(metodo_pago).toLowerCase().includes('trans') && !metodoPagoAnterior.includes('trans')) {
        // Opcional: notificarPedidoTransferencia(pedidoId, empresa_id).catch(() => {});
     }

     res.json({ ok: true });

   } catch (e) {
     // Si algo falló, deshacemos TODO.
     await client.query('ROLLBACK');
     console.error('POST /entregar ERROR CRÍTICO:', e);
     
     // Feedback amigable
     if (e.message && e.message.includes('No autorizado')) {
         return res.status(403).json({ error: e.message });
     }
     // Devolvemos 500 JSON para evitar el error de parseo en el frontend
     res.status(500).json({ error: 'Error al procesar la entrega: ' + (e.message || 'Error interno') });
   } finally {
     client.release();
   }
});

// 3. Movimientos de activos manuales enviados por el repartidor
  router.post('/pedidos/:id/activos-movimientos', withAuth, async (req, res) => {
   try {
     const { chofer_id, empresa_id, username } = req.user;
     const pedidoId = Number(req.params.id);
     const { movimientos } = req.body || {};

     if (!chofer_id) {
       return res.status(403).json({ error: 'No autorizado' });
     }

     const pedRes = await query(
       `
       SELECT chofer_id, punto_entrega_id
       FROM pedidos
       WHERE id = $1
       `,
       [pedidoId]
     );

     // CORRECCIÓN: Usamos .length directamente, ya que 'query' devuelve el array
     if (!pedRes.length) {
       return res.status(404).json({ error: 'Pedido no encontrado' });
     }

     // CORRECCIÓN: Accedemos al primer elemento directamente
     const pedido = pedRes[0];

     // Verificamos asignación
     if (pedido.chofer_id && pedido.chofer_id !== chofer_id) {
       return res.status(403).json({ error: 'Pedido asignado a otro chofer' });
     }

     const result = await registrarMovimientosActivosDesdePedido({
       empresaId: empresa_id,
       clienteId: pedido.punto_entrega_id,
       pedidoId,
       usuario: username || 'repartidor',
       origen: 'app_repartidor',
       movimientos: Array.isArray(movimientos) ? movimientos : []
     });

     res.json(result);
   } catch (e) {
     console.error('REPARTIDOR activos-movimientos ERROR:', e);
     res.status(500).json({ error: 'Error registrando movimientos de activos' });
   }
});

// 4. Resumen de activos asociados a un pedido (para el modal del repartidor)
  router.get('/pedidos/:id/activos-resumen', withAuth, async (req, res) => {
   try {
     const { chofer_id, empresa_id } = req.user || {};
     const pedidoId = Number(req.params.id);

     if (!chofer_id) {
       return res.status(403).json({ error: 'No autorizado' });
     }

     if (!Number.isFinite(pedidoId)) {
       return res.status(400).json({ error: 'Pedido inválido' });
     }

     // Pedido + datos del cliente (punto de entrega)
     const pedRows = await query(
       `
       SELECT 
         p.id,
         p.monto,
         p.chofer_id,
         p.punto_entrega_id,
         pe.cliente,
         COALESCE(pe.direccion_completa, pe.direccion) AS direccion
       FROM pedidos p
       LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
       WHERE p.id = $1
         AND p.empresa_id = $2
       `,
       [pedidoId, empresa_id]
     );

     if (!pedRows.length) {
       return res.status(404).json({ error: 'Pedido no encontrado' });
     }

     const pedido = pedRows[0];

     // El chofer sólo puede ver pedidos propios
     if (pedido.chofer_id && Number(pedido.chofer_id) !== Number(chofer_id)) {
       return res.status(403).json({ error: 'Pedido asignado a otro chofer' });
     }

     // Items del pedido + productos con config_activo
     const itemsRows = await query(
       `
       SELECT 
         ip.id AS item_pedido_id,
         ip.producto,
         ip.cantidad,
         ip.precio_unitario,
         COALESCE(ip.producto_id, pr.id) AS producto_id,
         pr.config_activo
       FROM items_pedido ip
       LEFT JOIN productos pr
         ON pr.empresa_id = $2
        AND (
             pr.id = ip.producto_id
          OR LOWER(TRIM(pr.nombre)) = LOWER(TRIM(ip.producto))
        )
       WHERE ip.pedido_id = $1
       `,
       [pedidoId, empresa_id]
     );

     const items_activos = (itemsRows || [])
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

     // Activos actualmente vinculados a ese cliente (punto_entrega_id)
     const activosClienteRows = await query(
       `
       SELECT 
         a.id,
         a.codigo,
         a.tipo,
         a.estado,
         a.numero_serie,
         a.alquiler_mensual
       FROM empresa_activos a
       WHERE a.empresa_id = $1
         AND a.cliente_id = $2
         AND a.estado IN ('prestado','en_mantenimiento','disponible')
       ORDER BY a.estado, a.codigo
       `,
       [empresa_id, pedido.punto_entrega_id]
     );

     // Activos disponibles para cambio (sin cliente asignado)
     const activosDisponiblesRows = await query(
       `
       SELECT 
         a.id,
         a.codigo,
         a.tipo,
         a.estado,
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
     const movRows = await query(
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

     res.json({
       pedido: {
         id: pedido.id,
         cliente: pedido.cliente,
         direccion: pedido.direccion,
         monto: Number(pedido.monto) || 0
       },
       items_activos,
       activos_cliente: activosClienteRows || [],
       activos_disponibles: activosDisponiblesRows || [],
       movimientos_existentes: movRows || []
     });
   } catch (e) {
     console.error('REPARTIDOR activos-resumen ERROR:', e);
     res.status(500).json({ error: 'Error cargando activos del pedido' });
   }
});

  router.get('/activos/stock-disponible', withAuth, async (req, res) => {
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
  router.post('/tomar/:id', withAuth, async (req, res) => {
   try {
     const { chofer_id } = req.user;
     if (!chofer_id) return res.status(403).json({ error: 'No autorizado' });

     const pedidoId = req.params.id;

     const result = await query(
       `UPDATE pedidos 
          SET chofer_id = $1 
        WHERE id = $2 
          AND chofer_id IS NULL
        RETURNING id`,
       [chofer_id, pedidoId]
     );

     if (!result.length) {
       return res.status(400).json({ error: 'El pedido ya fue tomado por otro.' });
     }

     res.json({ ok: true });
   } catch (e) {
     console.error('REPARTIDOR TOMAR ERROR:', e);
     res.status(500).json({ error: 'Error al tomar pedido' });
   }
});

// 9. OPTIMIZADOR DE RUTA (PostGIS Nearest Neighbor)
  router.post('/optimizar-ruta', withAuth, async (req, res) => {
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
             JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
             WHERE p.chofer_id = $1
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

       const rutaOptimizada = await query(sql, [chofer_id, lat, lng]);

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
