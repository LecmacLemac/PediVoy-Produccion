// src/estrategias.js
import { query } from './db.js';

// Helper interno para encolar mensajes
async function encolarMensaje(empresaId, telefono, mensaje) {
  if (!telefono || !mensaje) return;
  const tel = String(telefono).replace(/\D+/g, '');
  
  // Anti-Spam: No enviar el mismo mensaje exacto en 24hs
  const duplicado = await query(`
    SELECT id FROM wpp_outbox 
    WHERE telefono = $1 AND mensaje = $2 AND created_at > (NOW() - INTERVAL '24 hours')
  `, [tel, mensaje]);
  
  if (duplicado.length > 0) return;

  await query(`
    INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, created_at)
    VALUES ($1, $2, $3, 'pending', NOW())
  `, [empresaId, tel, mensaje]);
}

// Helper para obtener configuración
async function getConfig(empresaId) {
  const emp = await query('SELECT config_estrategias FROM empresas WHERE id=$1', [empresaId]);
  return emp[0]?.config_estrategias || {};
}

/**
 * ESTRATEGIA 1: VECINOS CERCANOS (Geomarketing)
 * Disparador: Cambio de estado a "En Ruta"
 */
export async function ejecutarEstrategiaVecinos({ pedidoId, empresaId }) {
  const config = await getConfig(empresaId);
  if (!config.vecinos_activado) return;

  const pRows = await query(`
    SELECT pe.latitud, pe.longitud 
    FROM pedidos p 
    JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id 
    WHERE p.id = $1`, [pedidoId]);
  
  const centro = pRows[0];
  if (!centro || !centro.latitud) return;

  const radio = config.vecinos_radio || 200; 
  const diasSinCompra = config.vecinos_dias || 7;

  const vecinos = await query(`
    SELECT pe.id, pe.cliente, pe.telefono
    FROM puntos_entrega pe
    WHERE pe.empresa_id = $1
      AND pe.latitud IS NOT NULL
      AND ST_DWithin(
        ST_SetSRID(ST_MakePoint(pe.longitud, pe.latitud), 4326)::geography,
        ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
        $4
      )
      AND NOT EXISTS (
        SELECT 1 FROM pedidos p 
        WHERE p.punto_entrega_id = pe.id 
          AND p.fecha > NOW() - INTERVAL '${diasSinCompra} days'
      )
    LIMIT 5
  `, [empresaId, centro.longitud, centro.latitud, radio]);

  for (const v of vecinos) {
    let msg = config.vecinos_mensaje || "Hola {cliente} 👋, el camión está en tu cuadra. Avisame si te dejo algo!";
    msg = msg.replace('{cliente}', v.cliente);
    await encolarMensaje(empresaId, v.telefono, msg);
  }
}

/**
 * ESTRATEGIA 2: MAYORDOMO IA (Predictivo)
 * Disparador: Cron Job Diario (ej: 8:00 AM)
 */
export async function ejecutarReposicionPredictiva() {
  // Iteramos todas las empresas que tengan esto activo
  const empresas = await query(`
    SELECT id, config_estrategias FROM empresas 
    WHERE config_estrategias->>'predictivo_activado' = 'true'
  `);

  for (const emp of empresas) {
    const config = emp.config_estrategias;
    const empresaId = emp.id;

    // Lógica SQL: Clientes cuyo (Ultima Fecha + Promedio Consumo) es aprox MAÑANA
    const clientes = await query(`
      WITH consumo AS (
        SELECT 
          punto_entrega_id,
          AVG(EXTRACT(DAY FROM (fecha - lag_fecha))) as dias_promedio
        FROM (
          SELECT punto_entrega_id, fecha, 
                 LAG(fecha) OVER (PARTITION BY punto_entrega_id ORDER BY fecha) as lag_fecha
          FROM pedidos 
          WHERE estado = 'entregado' AND empresa_id = $1
        ) sub
        GROUP BY 1 HAVING COUNT(*) >= 3
      )
      SELECT pe.cliente, pe.telefono
      FROM puntos_entrega pe
      JOIN pedidos p ON p.punto_entrega_id = pe.id
      JOIN consumo c ON c.punto_entrega_id = pe.id
      WHERE pe.empresa_id = $1
        AND p.fecha = (SELECT MAX(fecha) FROM pedidos WHERE punto_entrega_id = pe.id)
        -- Si la fecha estimada es mañana (rango de 24h)
        AND (p.fecha + (c.dias_promedio || ' days')::interval)::date = (CURRENT_DATE + 1)
    `, [empresaId]);

    for (const c of clientes) {
      let msg = config.predictivo_mensaje || "Hola {cliente}, parece que te queda poca agua. ¿Te llevo mañana?";
      msg = msg.replace('{cliente}', c.cliente);
      await encolarMensaje(empresaId, c.telefono, msg);
    }
  }
}

/**
 * ESTRATEGIA 3: DOMINACIÓN DE ZONA (Referidos Viral)
 * Disparador: Cuando un pedido cambia a "Entregado".
 * Acción: Envía un link al cliente actual para que invite a un vecino.
 */
export async function ejecutarEstrategiaReferidos({ pedidoId, empresaId }) {
  // 1. Obtener configuración de la empresa
  const config = await getConfig(empresaId);
  
  // Si la estrategia no está activada, salimos sin hacer nada
  if (!config.referidos_activado) return;

  // 2. Obtener datos del pedido, cliente y dominio de la empresa
  const rows = await query(`
    SELECT 
        pe.cliente, 
        pe.telefono, 
        e.landing_slug, 
        e.landing_domain
    FROM pedidos p
    JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
    JOIN empresas e ON e.id = pe.empresa_id
    WHERE p.id = $1
  `, [pedidoId]);

  const data = rows[0];
  // Validamos que exista el cliente y tenga teléfono
  if (!data || !data.telefono) return;

  // 3. Construir la URL del link (Host)
  // Prioridad: Dominio propio > Fallback genérico
  let host = data.landing_domain || 'https://pedivoy.com'; // Ajustá el dominio fallback al tuyo
  
  // Aseguramos que empiece con https
  if (!host.startsWith('http')) host = 'https://' + host;

  // 4. Generar el Link Único
  // El código de referido será "VECINO-" seguido del ID de este pedido.
  const link = `${host}/?ref=VECINO-${pedidoId}`;

  // 5. Preparar el mensaje
  // Usamos el mensaje configurado en el panel o uno por defecto
  let msg = config.referidos_mensaje || 
    "¡Gracias por tu compra {cliente}! 🌟 Si compartís este link con un vecino, ambos ganan descuento en la próxima: {link}";
  
  // Reemplazamos las variables
  msg = msg.replace('{cliente}', data.cliente || 'Vecino')
           .replace('{link}', link);

  // 6. Encolar el mensaje para envío (usa el helper interno de estrategias.js)
  await encolarMensaje(empresaId, data.telefono, msg);
  
  if (process.env.DEBUG_ORDERS === '1') {
      console.log(`[MARKETING] Link de referidos enviado a pedido #${pedidoId}`);
  }
}

/**
 * ESTRATEGIA 4: RECOMPENSA AL PADRINO
 * Disparador: Cuando el pedido del "Referido" se marca como "entregado".
 * Acción: Busca quién refirió este pedido, le carga un premio en DB y le avisa por WhatsApp.
 */
export async function ejecutarRecompensaReferido({ pedidoId, empresaId }) {
  try {
    const config = await getConfig(empresaId);
    if (!config.referidos_activado) return;

    // 1. Verificar si este pedido fue referido por alguien (tiene referido_por_id)
    const rows = await query(`
      SELECT p.referido_por_id, pe.cliente AS nombre_vecino
      FROM pedidos p
      JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
      WHERE p.id = $1
    `, [pedidoId]);

    if (!rows.length) return;
    const { referido_por_id, nombre_vecino } = rows[0];

    if (!referido_por_id) return; // No es un pedido referido, no hacemos nada.

    // 2. Obtener datos del Padrino (quien refirió)
    const padrinoRows = await query(`
      SELECT id, cliente, telefono 
      FROM puntos_entrega 
      WHERE id = $1 AND empresa_id = $2
    `, [referido_por_id, empresaId]);

    if (!padrinoRows.length) return;
    const padrino = padrinoRows[0];

    // 3. Otorgar Recompensa (Insertar en cliente_recompensas)
    // El ID del producto de regalo debe estar en la config (ej: un bidón gratis o un descuento)
    // Si no está configurado, solo avisamos (o no hacemos nada, según prefieras).
    const idPremio = config.referidos_producto_id ? parseInt(config.referidos_producto_id) : null;

    if (idPremio) {
      await query(`
        INSERT INTO cliente_recompensas (cliente_id, producto_id, cantidad, reclamado, fecha_generado)
        VALUES ($1, $2, 1, FALSE, NOW())
      `, [padrino.id, idPremio]);
      
      if (process.env.DEBUG_ORDERS === '1') {
        console.log(`[MARKETING] Premio otorgado al padrino ${padrino.id} por pedido #${pedidoId}`);
      }
    }

    // 4. Avisar al Padrino por WhatsApp
    let msg = config.referidos_mensaje_padrino || 
      "¡Buenas noticias {padrino}! 🥳 Tu vecino {vecino} recibió su primer pedido. Te ganaste un regalo para tu próxima compra por haberlo invitado. ¡Gracias!";
    
    msg = msg.replace('{padrino}', padrino.cliente || 'Cliente')
             .replace('{vecino}', nombre_vecino || 'tu vecino');

    await encolarMensaje(empresaId, padrino.telefono, msg);

  } catch (e) {
    console.error('[ESTRATEGIAS] Error en ejecutarRecompensaReferido:', e);
  }
}