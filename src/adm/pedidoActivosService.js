// src/adm//pedidoActivosService.js
import { pool } from '../db.js';


export async function registrarActivosDesdePedidoEntrega({
  pedidoId,
  empresaId,
  clienteId,
  itemsConIdentificacion = [], 
  usuario = 'sistema',
  origen = 'app_repartidor',
  client = null // <--- NUEVO PARÁMETRO: Cliente externo opcional
}) {
  // Si nos pasan un cliente (estamos en una transacción padre), lo usamos.
  // Si no, creamos uno nuevo y manejamos nuestra propia transacción.
  const useExternalClient = !!client;
  const db = useExternalClient ? client : await pool.connect();
  
  try {
    if (!useExternalClient) await db.query('BEGIN');

    // ... (MISMAS VALIDACIONES DE EMPRESA/CLIENTE QUE ANTES) ...
    // Asegúrate de usar 'db.query' en lugar de 'client.query' en todo el código interno
    
    // ... (LOGICA DE BUCLE FOR E INSERCIONES) ...

    if (!useExternalClient) await db.query('COMMIT');
    
    return { ok: true };

  } catch (error) {
    if (!useExternalClient) await db.query('ROLLBACK');
    console.error('[ACTIVOS ERROR]', error);
    // IMPORTANTE: Si estamos en transacción externa, lanzamos el error para que el padre haga Rollback
    throw error; 
  } finally {
    if (!useExternalClient) db.release();
  }
}

/**
 * Registra movimientos de activos ligados a un pedido.
 * Soporta transacción externa pasando dbClient (para ser 100% atómico con /entregar).
 */
export async function registrarMovimientosActivosDesdePedido({
  dbClient = null,
  empresaId,
  clienteId,
  pedidoId,
  usuario = 'sistema',
  origen = 'app_repartidor',
  movimientos = []
}) {
  if (!Array.isArray(movimientos) || movimientos.length === 0) {
    return { ok: true, movimientosProcesados: 0 };
  }

  const client = dbClient || await pool.connect();
  const ownTx = !dbClient;

  try {
    if (ownTx) await client.query('BEGIN');

    // Resolver empresa / cliente en base al pedido si hace falta
    // y asegurar coherencia multi-tenant (si empresaId viene seteado, el pedido debe pertenecer a esa empresa)
    if (!empresaId || !clienteId) {
      const empresaParam = empresaId ? Number(empresaId) : null;
      const pedRes = await client.query(
        `
        SELECT empresa_id, punto_entrega_id AS cliente_id
        FROM pedidos
        WHERE id = $1
          AND ($2::int IS NULL OR empresa_id = $2)
        LIMIT 1
        `,
        [pedidoId, empresaParam]
      );
      if (!pedRes.rowCount) {
        throw new Error('Pedido no encontrado para registrar movimientos de activos');
      }
      const ped = pedRes.rows[0];
      empresaId = empresaId || ped.empresa_id;
      clienteId = clienteId || ped.cliente_id;
    }

    // Validar que el cliente pertenezca a la empresa (evita cross-tenant por cliente_id)
    const cRes = await client.query(
      'SELECT id FROM puntos_entrega WHERE id = $1 AND empresa_id = $2 LIMIT 1',
      [clienteId, empresaId]
    );
    if (!cRes.rowCount) {
      throw new Error('Cliente no pertenece a la empresa del pedido');
    }

    // 👉 ahora incluimos 'entrega'
    const validTipos = new Set(['entrega', 'retiro', 'mantenimiento', 'cambio']);
    let movimientosProcesados = 0;

    // helper: normalizar motivo (devolucion / reparacion)
    const normMotivo = (m) =>
      String(m || '').trim().toLowerCase() || null;

    // helper: alquiler desde movimiento o config_activo del producto (si se puede)
    async function resolverAlquilerMensual({ productoId, itemPedidoId }) {
      // 1) si tengo productoId, busco config_activo directo
      if (productoId) {
        const pr = await client.query(
          `SELECT config_activo FROM productos WHERE empresa_id = $1 AND id = $2`,
          [empresaId, productoId]
        );
        if (pr.rowCount) {
          const cfg = pr.rows[0].config_activo || {};
          const val =
            cfg.alquiler_mensual != null ? Number(cfg.alquiler_mensual)
              : (cfg.monto_alquiler_mensual != null ? Number(cfg.monto_alquiler_mensual) : null);
          return Number.isFinite(val) ? val : null;
        }
      }

      // 2) si tengo itemPedidoId, intento deducir producto + config
      if (itemPedidoId) {
        const it = await client.query(
          `
          SELECT COALESCE(ip.producto_id, p.id) AS producto_id, p.config_activo
          FROM items_pedido ip
          JOIN pedidos ped
            ON ped.id = ip.pedido_id
           AND ped.empresa_id = $2
          LEFT JOIN productos p
            ON p.empresa_id = $2
           AND (
                p.id = ip.producto_id
             OR LOWER(TRIM(p.nombre)) = LOWER(TRIM(ip.producto))
           )
          WHERE ip.id = $1
          `,
          [itemPedidoId, empresaId]
        );
        if (it.rowCount) {
          const cfg = it.rows[0].config_activo || {};
          const val =
            cfg.alquiler_mensual != null ? Number(cfg.alquiler_mensual)
              : (cfg.monto_alquiler_mensual != null ? Number(cfg.monto_alquiler_mensual) : null);
          return Number.isFinite(val) ? val : null;
        }
      }

      return null;
    }

    for (const rawMov of movimientos) {
      const tipo = String(rawMov.tipoOperacion || rawMov.tipo_operacion || '')
        .trim()
        .toLowerCase();

      if (!validTipos.has(tipo)) continue;

      const itemPedidoId =
        rawMov.itemPedidoId ?? rawMov.item_pedido_id ?? null;
      const productoId =
        rawMov.productoId ?? rawMov.producto_id ?? null;

      const motivo = normMotivo(rawMov.motivo || rawMov.motivo_operacion || rawMov.motivoOperacion);

      const observacionBase =
        rawMov.observacion ||
        rawMov.obs ||
        `Movimiento ${tipo} asociado al pedido #${pedidoId}`;

      // -------------------
      // CASO 0: ENTREGA (seleccionar activo disponible y asignarlo al cliente)
      // -------------------
      if (tipo === 'entrega') {
        const activoId = Number(rawMov.activoId ?? rawMov.activo_id);
        if (!activoId) continue;

        // lock + validar disponible
        const aRes = await client.query(
          `
          SELECT id, estado, cliente_id, alquiler_mensual, fecha_inicio_alquiler
          FROM empresa_activos
          WHERE id = $1
            AND empresa_id = $2
          FOR UPDATE
          `,
          [activoId, empresaId]
        );
        if (!aRes.rowCount) continue;

        const activo = aRes.rows[0];
        const estadoActual = String(activo.estado || '').toLowerCase();

        // debe estar disponible (y sin cliente)
        if (estadoActual !== 'disponible' || activo.cliente_id != null) {
          throw new Error(`El activo ${activo.codigo || activoId} ya no está disponible (quizás lo tomó otro chofer).`);
        }

        // alquiler (si corresponde)
        const alquilerMensualMov =
          rawMov.alquilerMensual ?? rawMov.alquiler_mensual ?? null;
        const alquilerMensual =
          alquilerMensualMov != null
            ? (Number.isFinite(Number(alquilerMensualMov)) ? Number(alquilerMensualMov) : null)
            : await resolverAlquilerMensual({ productoId, itemPedidoId });

        await client.query(
          `
          UPDATE empresa_activos
          SET estado = 'prestado',
              cliente_id = $1,
              alquiler_mensual = COALESCE($2::numeric(12,2), alquiler_mensual),
              fecha_inicio_alquiler = CASE
                WHEN COALESCE($2::numeric(12,2), alquiler_mensual) IS NOT NULL
                     AND fecha_inicio_alquiler IS NULL THEN NOW()
                ELSE fecha_inicio_alquiler
              END,
              updated_at = NOW()
          WHERE id = $3
            AND empresa_id = $4
          `,
          [clienteId, alquilerMensual, activoId, empresaId]
        );

        // historial
        await client.query(
          `
          INSERT INTO historial_activos (
            empresa_id, activo_id, cliente_id, accion, usuario, observacion, fecha
          )
          VALUES ($1, $2, $3, 'entrega', $4, $5, NOW())
          `,
          [empresaId, activoId, clienteId, usuario, observacionBase]
        );

        // pedido_activos
        await client.query(
          `
          INSERT INTO pedido_activos (
            empresa_id, pedido_id, item_pedido_id, producto_id,
            activo_id, tipo_operacion, origen, observacion, created_by
          )
          VALUES ($1,$2,$3,$4,$5,'entrega',$6,$7,$8)
          ON CONFLICT (pedido_id, activo_id)
          DO UPDATE SET
            item_pedido_id = COALESCE(EXCLUDED.item_pedido_id, pedido_activos.item_pedido_id),
            producto_id    = COALESCE(EXCLUDED.producto_id,    pedido_activos.producto_id),
            tipo_operacion = EXCLUDED.tipo_operacion,
            origen         = EXCLUDED.origen,
            observacion    = EXCLUDED.observacion
          `,
          [
            empresaId,
            pedidoId,
            itemPedidoId,
            productoId,
            activoId,
            origen,
            observacionBase,
            usuario
          ]
        );

        movimientosProcesados += 1;
        continue;
      }

      // -------------------
      // CASO 1: RETIRO / MANTENIMIENTO
      // -------------------
      if (tipo === 'retiro' || tipo === 'mantenimiento') {
        const activoId = Number(rawMov.activoId ?? rawMov.activo_id);
        if (!activoId) continue;

        const aRes = await client.query(
          `
          SELECT id, estado, cliente_id
          FROM empresa_activos
          WHERE id = $1
            AND empresa_id = $2
          FOR UPDATE
          `,
          [activoId, empresaId]
        );
        if (!aRes.rowCount) continue;

        const activo = aRes.rows[0];
        const clienteMovimientoId = activo.cliente_id || clienteId;

        // Validación soft: retiro/mantenimiento generalmente debe venir prestado
        // (si querés hacerlo estricto, descomentá)
        // const est = String(activo.estado || '').toLowerCase();
        // if (est !== 'prestado') continue;

        if (tipo === 'retiro') {
          // motivo: reparacion => en_mantenimiento, devolucion => disponible
          const estadoFinal = (motivo === 'reparacion') ? 'en_mantenimiento' : 'disponible';

          await client.query(
            `
            UPDATE empresa_activos
            SET estado = $3,
                cliente_id = NULL,
                fecha_fin_alquiler = NOW(),
                updated_at = NOW()
            WHERE id = $1
              AND empresa_id = $2
            `,
            [activoId, empresaId, estadoFinal]
          );
        } else {
          // mantenimiento: lo dejamos en_mantenimiento y sin cliente
          await client.query(
            `
            UPDATE empresa_activos
            SET estado = 'en_mantenimiento',
                cliente_id = NULL,
                fecha_fin_alquiler = COALESCE(fecha_fin_alquiler, NOW()),
                updated_at = NOW()
            WHERE id = $1
              AND empresa_id = $2
            `,
            [activoId, empresaId]
          );
        }

        await client.query(
          `
          INSERT INTO historial_activos (
            empresa_id, activo_id, cliente_id, accion, usuario, observacion, fecha
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
          `,
          [
            empresaId,
            activoId,
            clienteMovimientoId,
            tipo, // 'retiro' | 'mantenimiento'
            usuario,
            motivo ? `${observacionBase} (motivo: ${motivo})` : observacionBase
          ]
        );

        await client.query(
          `
          INSERT INTO pedido_activos (
            empresa_id, pedido_id, item_pedido_id, producto_id,
            activo_id, tipo_operacion, origen, observacion, created_by
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (pedido_id, activo_id)
          DO UPDATE SET
            item_pedido_id = COALESCE(EXCLUDED.item_pedido_id, pedido_activos.item_pedido_id),
            producto_id    = COALESCE(EXCLUDED.producto_id,    pedido_activos.producto_id),
            tipo_operacion = EXCLUDED.tipo_operacion,
            origen         = EXCLUDED.origen,
            observacion    = EXCLUDED.observacion
          `,
          [
            empresaId,
            pedidoId,
            itemPedidoId,
            productoId,
            activoId,
            tipo, // 'retiro' | 'mantenimiento'
            origen,
            motivo ? `${observacionBase} (motivo: ${motivo})` : observacionBase,
            usuario
          ]
        );

        movimientosProcesados += 1;
        continue;
      }

      // -------------------
      // CASO 2: CAMBIO (sale uno, entra otro)
      // -------------------
      if (tipo === 'cambio') {
        const activoIdNuevo = Number(rawMov.activoId ?? rawMov.activo_id);
        const activoIdViejo = Number(
          rawMov.activoRelacionadoId ?? rawMov.activo_relacionado_id
        );

        if (!activoIdNuevo || !activoIdViejo || activoIdNuevo === activoIdViejo) {
          continue;
        }

        const actsRes = await client.query(
          `
          SELECT id, estado, cliente_id, alquiler_mensual, fecha_inicio_alquiler
          FROM empresa_activos
          WHERE empresa_id = $1
            AND id IN ($2, $3)
          FOR UPDATE
          `,
          [empresaId, activoIdNuevo, activoIdViejo]
        );
        if (actsRes.rowCount < 2) continue;

        const viejo = actsRes.rows.find(r => Number(r.id) === activoIdViejo);
        const nuevo = actsRes.rows.find(r => Number(r.id) === activoIdNuevo);
        if (!viejo || !nuevo) continue;

        const clienteMovimientoId = viejo.cliente_id || clienteId;

        // Validaciones recomendadas (soft)
        const estViejo = String(viejo.estado || '').toLowerCase();
        const estNuevo = String(nuevo.estado || '').toLowerCase();
        // viejo debería estar prestado, nuevo disponible
        if (estNuevo !== 'disponible' || nuevo.cliente_id != null) continue;
        // si querés estricto:
        // if (estViejo !== 'prestado') continue;

        // 1) Retiramos el viejo: devolucion => disponible, reparacion => en_mantenimiento
        const estadoViejoFinal = (motivo === 'reparacion') ? 'en_mantenimiento' : 'disponible';

        await client.query(
          `
          UPDATE empresa_activos
          SET estado = $3,
              cliente_id = NULL,
              fecha_fin_alquiler = NOW(),
              updated_at = NOW()
          WHERE id = $1
            AND empresa_id = $2
          `,
          [activoIdViejo, empresaId, estadoViejoFinal]
        );

        // 2) Asignamos el nuevo al cliente (con alquiler si aplica)
        const alquilerMensualMov =
          rawMov.alquilerMensual ?? rawMov.alquiler_mensual ?? null;
        const alquilerMensual =
          alquilerMensualMov != null
            ? (Number.isFinite(Number(alquilerMensualMov)) ? Number(alquilerMensualMov) : null)
            : await resolverAlquilerMensual({ productoId, itemPedidoId });

        await client.query(
          `
          UPDATE empresa_activos
          SET estado = 'prestado',
              cliente_id = $1,
              alquiler_mensual = COALESCE($2::numeric(12,2), alquiler_mensual),
              fecha_inicio_alquiler = CASE
                WHEN COALESCE($2::numeric(12,2), alquiler_mensual) IS NOT NULL
                     AND fecha_inicio_alquiler IS NULL THEN NOW()
                ELSE fecha_inicio_alquiler
              END,
              updated_at = NOW()
          WHERE id = $3
            AND empresa_id = $4
          `,
          [clienteId, alquilerMensual, activoIdNuevo, empresaId]
        );

        // Historial del viejo
        await client.query(
          `
          INSERT INTO historial_activos (
            empresa_id, activo_id, cliente_id, accion, usuario, observacion, fecha
          )
          VALUES ($1,$2,$3,'retiro',$4,$5,NOW())
          `,
          [
            empresaId,
            activoIdViejo,
            clienteMovimientoId,
            usuario,
            motivo ? `${observacionBase} (motivo: ${motivo})` : observacionBase
          ]
        );

        // Historial del nuevo
        await client.query(
          `
          INSERT INTO historial_activos (
            empresa_id, activo_id, cliente_id, accion, usuario, observacion, fecha
          )
          VALUES ($1,$2,$3,'cambio',$4,$5,NOW())
          `,
          [
            empresaId,
            activoIdNuevo,
            clienteId,
            usuario,
            motivo ? `${observacionBase} (motivo: ${motivo})` : observacionBase
          ]
        );

        // pedido_activos (registramos el cambio con ambos ids)
        await client.query(
          `
          INSERT INTO pedido_activos (
            empresa_id, pedido_id, item_pedido_id, producto_id,
            activo_id, activo_relacionado_id, tipo_operacion,
            origen, observacion, created_by
          )
          VALUES ($1,$2,$3,$4,$5,$6,'cambio',$7,$8,$9)
          ON CONFLICT (pedido_id, activo_id)
          DO UPDATE SET
            item_pedido_id        = COALESCE(EXCLUDED.item_pedido_id,        pedido_activos.item_pedido_id),
            producto_id           = COALESCE(EXCLUDED.producto_id,           pedido_activos.producto_id),
            activo_relacionado_id = COALESCE(EXCLUDED.activo_relacionado_id, pedido_activos.activo_relacionado_id),
            tipo_operacion        = EXCLUDED.tipo_operacion,
            origen                = EXCLUDED.origen,
            observacion           = EXCLUDED.observacion
          `,
          [
            empresaId,
            pedidoId,
            itemPedidoId,
            productoId,
            activoIdNuevo,
            activoIdViejo,
            origen,
            motivo ? `${observacionBase} (motivo: ${motivo})` : observacionBase,
            usuario
          ]
        );

        movimientosProcesados += 1;
      }
    }

    if (ownTx) await client.query('COMMIT');
    return { ok: true, movimientosProcesados };
  } catch (e) {
    if (ownTx) await client.query('ROLLBACK');
    console.error('Error registrarMovimientosActivosDesdePedido:', e);
    throw e;
  } finally {
    if (ownTx) client.release();
  }
}



