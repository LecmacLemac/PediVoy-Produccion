// src/estrategias.js
import { query } from './db.js';
import { sendSmsViaIfttt } from './services/sms.js';

let telemetryReady = false;
let telemetryEnsureTried = false;

async function ensureTelemetryTable() {
  if (telemetryReady || telemetryEnsureTried) return telemetryReady;
  telemetryEnsureTried = true;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS marketing_envios_telemetria (
        id BIGSERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL,
        estrategia TEXT NOT NULL,
        canal TEXT NOT NULL,
        telefono TEXT,
        mensaje_hash TEXT,
        estado TEXT NOT NULL,
        proveedor TEXT,
        costo_estimado NUMERIC(12,2),
        detalle_error TEXT,
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query('CREATE INDEX IF NOT EXISTS idx_marketing_tel_empresa_fecha ON marketing_envios_telemetria (empresa_id, created_at DESC)');
    await query('CREATE INDEX IF NOT EXISTS idx_marketing_tel_estrategia_canal_fecha ON marketing_envios_telemetria (estrategia, canal, created_at DESC)');
    telemetryReady = true;
  } catch (e) {
    console.error('[ESTRATEGIAS] TELEMETRY_TABLE_ERROR', e?.message || e);
    telemetryReady = false;
  }
  return telemetryReady;
}

function shortHash(input) {
  const s = String(input || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h) + s.charCodeAt(i);
  return Math.abs(h).toString(16);
}

async function logTelemetria({ empresaId, estrategia, canal, telefono, mensaje, estado, proveedor = null, costoEstimado = null, detalleError = null, meta = null }) {
  try {
    const ok = await ensureTelemetryTable();
    if (!ok) return;
    await query(
      `INSERT INTO marketing_envios_telemetria
        (empresa_id, estrategia, canal, telefono, mensaje_hash, estado, proveedor, costo_estimado, detalle_error, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        Number(empresaId),
        String(estrategia || 'desconocida'),
        String(canal || 'desconocido'),
        telefono ? String(telefono).replace(/\D+/g, '') : null,
        shortHash(mensaje),
        String(estado || 'unknown'),
        proveedor ? String(proveedor) : null,
        Number.isFinite(Number(costoEstimado)) ? Number(costoEstimado) : null,
        detalleError ? String(detalleError).slice(0, 2000) : null,
        JSON.stringify({ ...(meta || {}), mensaje: String(mensaje || '') }),
      ]
    );
  } catch (e) {
    console.error('[ESTRATEGIAS] TELEMETRY_LOG_ERROR', e?.message || e);
  }
}

function normalizeCanal(canal) {
  const c = String(canal || 'whatsapp').trim().toLowerCase();
  if (c === 'sms' || c === 'ambos') return c;
  return 'whatsapp';
}

function canalIncluyeWhatsApp(canal) {
  const c = normalizeCanal(canal);
  return c === 'whatsapp' || c === 'ambos';
}

function canalIncluyeSms(canal) {
  const c = normalizeCanal(canal);
  return c === 'sms' || c === 'ambos';
}

function renderTemplateMsg(tpl, ctx = {}) {
  return String(tpl || '')
    .replaceAll('{cliente}', String(ctx.cliente || ''))
    .replaceAll('{rubro}', String(ctx.rubro || ''))
    .replaceAll('{zona}', String(ctx.zona || ''));
}

// Helper interno para encolar mensajes (WhatsApp)
async function encolarMensajeWhatsapp(empresaId, telefono, mensaje) {
  if (!telefono || !mensaje) return { queued: false, skipped: true, reason: 'missing_phone_or_message' };
  const tel = String(telefono).replace(/\D+/g, '');

  // Anti-Spam: No enviar el mismo mensaje exacto en 24hs
  const duplicado = await query(`
    SELECT id FROM wpp_outbox
    WHERE telefono = $1 AND mensaje = $2 AND created_at > (NOW() - INTERVAL '24 hours')
  `, [tel, mensaje]);

  if (duplicado.length > 0) return { queued: false, skipped: true, reason: 'duplicate_24h' };

  await query(`
    INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, created_at)
    VALUES ($1, $2, $3, 'pending', NOW())
  `, [empresaId, tel, mensaje]);

  return { queued: true };
}

async function enviarPorCanal({ empresaId, estrategia, telefono, mensaje, canal, meta = null }) {
  const canalNorm = normalizeCanal(canal);

  if (canalIncluyeWhatsApp(canalNorm)) {
    const wpp = await encolarMensajeWhatsapp(empresaId, telefono, mensaje);
    await logTelemetria({
      empresaId,
      estrategia,
      canal: 'whatsapp',
      telefono,
      mensaje,
      estado: wpp?.queued ? 'queued' : (wpp?.skipped ? 'skipped' : 'error'),
      proveedor: 'whatsapp-web.js',
      meta: { ...(meta || {}), reason: wpp?.reason || null },
    });
  }

  if (canalIncluyeSms(canalNorm)) {
    const smsEnabled = String(process.env.IFTTT_SMS_ENABLED || '0') === '1';
    if (!smsEnabled) {
      await logTelemetria({
        empresaId,
        estrategia,
        canal: 'sms',
        telefono,
        mensaje,
        estado: 'skipped',
        proveedor: 'ifttt-webhook',
        detalleError: 'IFTTT_SMS_ENABLED=0',
        meta: meta || {},
      });
      return;
    }

    const smsResp = await sendSmsViaIfttt({ phone: telefono, message: mensaje });
    const ok = !!smsResp?.ok;
    const skipped = !!smsResp?.skipped;
    await logTelemetria({
      empresaId,
      estrategia,
      canal: 'sms',
      telefono,
      mensaje,
      estado: ok ? 'sent' : (skipped ? 'skipped' : 'failed'),
      proveedor: 'ifttt-webhook',
      costoEstimado: ok ? Number(process.env.SMS_COST_ARS || 0) : null,
      detalleError: ok ? null : (smsResp?.error || smsResp?.reason || `status ${smsResp?.status || 'n/a'}`),
      meta: { ...(meta || {}), status: smsResp?.status || null },
    });

    if (!ok && !skipped) {
      console.error('[ESTRATEGIAS] SMS.NOTIFY.ERROR', smsResp?.error || `status ${smsResp?.status || 'n/a'}`);
    }
  }
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
    SELECT pe.id, pe.cliente, pe.telefono, pe.direccion, pe.latitud, pe.longitud
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
    let msg = config.vecinos_mensaje || 'Hola {cliente} 👋, el camión está en tu cuadra. Avisame si te dejo algo!';
    msg = msg.replace('{cliente}', v.cliente);
    await enviarPorCanal({
      empresaId,
      estrategia: 'vecinos',
      telefono: v.telefono,
      mensaje: msg,
      canal: config.vecinos_canal || 'whatsapp',
      meta: {
        cliente_id: v.id || null,
        cliente: v.cliente || null,
        direccion: v.direccion || null,
        latitud: v.latitud == null ? null : Number(v.latitud),
        longitud: v.longitud == null ? null : Number(v.longitud),
      },
    });
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
      SELECT pe.id, pe.cliente, pe.telefono, pe.direccion, pe.latitud, pe.longitud
      FROM puntos_entrega pe
      JOIN pedidos p ON p.punto_entrega_id = pe.id
      JOIN consumo c ON c.punto_entrega_id = pe.id
      WHERE pe.empresa_id = $1
        AND p.fecha = (SELECT MAX(fecha) FROM pedidos WHERE punto_entrega_id = pe.id)
        -- Si la fecha estimada es mañana (rango de 24h)
        AND (p.fecha + (c.dias_promedio || ' days')::interval)::date = (CURRENT_DATE + 1)
    `, [empresaId]);

    for (const c of clientes) {
      let msg = config.predictivo_mensaje || 'Hola {cliente}, parece que te queda poca agua. ¿Te llevo mañana?';
      msg = msg.replace('{cliente}', c.cliente);
      await enviarPorCanal({
        empresaId,
        estrategia: 'predictivo',
        telefono: c.telefono,
        mensaje: msg,
        canal: config.predictivo_canal || 'whatsapp',
        meta: {
          cliente_id: c.id || null,
          cliente: c.cliente || null,
          direccion: c.direccion || null,
          latitud: c.latitud == null ? null : Number(c.latitud),
          longitud: c.longitud == null ? null : Number(c.longitud),
        },
      });
    }
  }
}

/**
 * ESTRATEGIA 6: CAMPAÑA POR CLIMA
 * Disparador: Cron diario (ej: 11:00 y 17:00)
 */
export async function ejecutarCampaniaClima() {
  const empresas = await query(`
    SELECT id, config_estrategias
    FROM empresas
    WHERE config_estrategias->>'clima_activado' = 'true'
  `);

  for (const emp of empresas) {
    const empresaId = emp.id;
    const config = emp.config_estrategias || {};

    const tempAlta = Number(config.clima_temp_alta ?? 30);
    const tempBaja = Number(config.clima_temp_baja ?? 8);

    // 1) Ubicación de referencia: promedio de puntos con coordenadas de la empresa
    const geo = await query(`
      SELECT AVG(latitud)::float AS lat, AVG(longitud)::float AS lng
      FROM puntos_entrega
      WHERE empresa_id = $1
        AND latitud IS NOT NULL
        AND longitud IS NOT NULL
    `, [empresaId]);

    const lat = geo?.[0]?.lat;
    const lng = geo?.[0]?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    // 2) Clima actual (Open-Meteo sin API key)
    let tempActual = null;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true&timezone=auto`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) continue;
      const wx = await resp.json();
      tempActual = Number(wx?.current_weather?.temperature);
    } catch {
      continue;
    }

    if (!Number.isFinite(tempActual)) continue;

    let mensajeBase = null;
    if (tempActual >= tempAlta) {
      mensajeBase = config.clima_mensaje_calor || 'Se viene calor hoy 🔥 ¿Te llevo agua antes de que te quedes sin stock?';
    } else if (tempActual <= tempBaja) {
      mensajeBase = config.clima_mensaje_frio || 'Hoy está feo para salir 🌧️ Si querés te lo llevo a domicilio.';
    }

    if (!mensajeBase) continue; // No dispara en temperatura templada

    // 3) Segmento objetivo: clientes sin compra en los últimos N días
    const diasSinCompra = Number(config.clima_dias_sin_compra ?? 5);
    const limite = Number(config.clima_max_envios ?? 25);

    const clientes = await query(`
      SELECT pe.id, pe.cliente, pe.telefono, pe.direccion, pe.latitud, pe.longitud
      FROM puntos_entrega pe
      WHERE pe.empresa_id = $1
        AND pe.telefono IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM pedidos p
          WHERE p.punto_entrega_id = pe.id
            AND p.fecha > NOW() - ($2::text || ' days')::interval
        )
        AND NOT EXISTS (
          SELECT 1
          FROM wpp_outbox o
          WHERE o.empresa_id = $1
            AND o.telefono = regexp_replace(pe.telefono, '\\D+', '', 'g')
            AND o.created_at > NOW() - INTERVAL '20 hours'
        )
      LIMIT $3
    `, [empresaId, diasSinCompra, limite]);

    for (const c of clientes) {
      const msg = String(mensajeBase).replace('{cliente}', c.cliente || 'Cliente');
      await enviarPorCanal({
        empresaId,
        estrategia: 'clima',
        telefono: c.telefono,
        mensaje: msg,
        canal: config.clima_canal || 'whatsapp',
        meta: {
          cliente_id: c.id || null,
          cliente: c.cliente || null,
          direccion: c.direccion || null,
          latitud: c.latitud == null ? null : Number(c.latitud),
          longitud: c.longitud == null ? null : Number(c.longitud),
        },
      });
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
        pe.id,
        pe.cliente,
        pe.telefono,
        pe.direccion,
        pe.latitud,
        pe.longitud,
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
  let host = data.landing_domain || 'https://pedivoy.com';

  // Aseguramos que empiece con https
  if (!host.startsWith('http')) host = `https://${host}`;

  // 4. Generar el Link Único
  const link = `${host}/?ref=VECINO-${pedidoId}`;

  // 5. Preparar el mensaje
  let msg = config.referidos_mensaje
    || '¡Gracias por tu compra {cliente}! 🌟 Si compartís este link con un vecino, ambos ganan descuento en la próxima: {link}';

  msg = msg.replace('{cliente}', data.cliente || 'Vecino')
    .replace('{link}', link);

  // 6. Envío por canal configurado
  await enviarPorCanal({
    empresaId,
    estrategia: 'referidos',
    telefono: data.telefono,
    mensaje: msg,
    canal: config.referidos_canal || 'whatsapp',
    meta: {
      cliente_id: data.id || null,
      cliente: data.cliente || null,
      direccion: data.direccion || null,
      latitud: data.latitud == null ? null : Number(data.latitud),
      longitud: data.longitud == null ? null : Number(data.longitud),
    },
  });

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

    if (!referido_por_id) return;

    // 2. Obtener datos del Padrino (quien refirió)
    const padrinoRows = await query(`
      SELECT id, cliente, telefono
      FROM puntos_entrega
      WHERE id = $1 AND empresa_id = $2
    `, [referido_por_id, empresaId]);

    if (!padrinoRows.length) return;
    const padrino = padrinoRows[0];

    // 3. Otorgar Recompensa (Insertar en cliente_recompensas)
    const idPremio = config.referidos_producto_id ? parseInt(config.referidos_producto_id, 10) : null;

    if (idPremio) {
      await query(`
        INSERT INTO cliente_recompensas (cliente_id, producto_id, cantidad, reclamado, fecha_generado)
        VALUES ($1, $2, 1, FALSE, NOW())
      `, [padrino.id, idPremio]);

      if (process.env.DEBUG_ORDERS === '1') {
        console.log(`[MARKETING] Premio otorgado al padrino ${padrino.id} por pedido #${pedidoId}`);
      }
    }

    // 4. Avisar al Padrino por canal configurado
    let msg = config.referidos_mensaje_padrino
      || '¡Buenas noticias {padrino}! 🥳 Tu vecino {vecino} recibió su primer pedido. Te ganaste un regalo para tu próxima compra por haberlo invitado. ¡Gracias!';

    msg = msg.replace('{padrino}', padrino.cliente || 'Cliente')
      .replace('{vecino}', nombre_vecino || 'tu vecino');

    await enviarPorCanal({
      empresaId,
      estrategia: 'referidos_recompensa',
      telefono: padrino.telefono,
      mensaje: msg,
      canal: config.referidos_canal || 'whatsapp',
      meta: {
        cliente_id: padrino.id || null,
        cliente: padrino.cliente || null,
      },
    });
  } catch (e) {
    console.error('[ESTRATEGIAS] Error en ejecutarRecompensaReferido:', e);
  }
}

function getArgentinaNowParts() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const weekMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    dow: weekMap[map.weekday] || 1,
    minutes: (Number(map.hour) * 60) + Number(map.minute),
  };
}

function parseDiasCsv(raw) {
  const vals = String(raw || '1,2,3,4,5,6').split(',').map(v => Number(String(v).trim())).filter(v => Number.isFinite(v) && v >= 1 && v <= 7);
  return vals.length ? new Set(vals) : new Set([1, 2, 3, 4, 5, 6]);
}

function parseFranjas(raw) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map((chunk) => {
      const m = chunk.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const from = (Number(m[1]) * 60) + Number(m[2]);
      const to = (Number(m[3]) * 60) + Number(m[4]);
      if (from < 0 || from > 1439 || to < 0 || to > 1439 || from === to) return null;
      return { from, to };
    })
    .filter(Boolean);
}

function estaEnFranja(minutos, franjas) {
  for (const f of franjas) {
    if (f.from < f.to && minutos >= f.from && minutos <= f.to) return true;
    if (f.from > f.to && (minutos >= f.from || minutos <= f.to)) return true; // cruza medianoche
  }
  return false;
}

export async function ejecutarCampaniaBaseImportadaAuto() {
  try {
    const empresas = await query(`
      SELECT id, config_estrategias
      FROM empresas
      WHERE config_estrategias->>'auto_launch_activado' = 'true'
    `);

    const nowAr = getArgentinaNowParts();

    for (const emp of empresas) {
      const empresaId = Number(emp.id);
      const cfg = emp.config_estrategias || {};
      const franjas = parseFranjas(cfg.auto_launch_franjas || '');
      if (!franjas.length || !estaEnFranja(nowAr.minutes, franjas)) continue;

      const dias = parseDiasCsv(cfg.auto_launch_dias || '1,2,3,4,5,6');
      if (!dias.has(nowAr.dow)) continue;

      const mensajeTpl = String(cfg.launch_mensaje || '').trim();
      if (!mensajeTpl) continue;

      const intervaloMin = Math.min(Math.max(Number(cfg.auto_launch_intervalo_min || 15), 5), 240);
      const reciente = await query(
        `SELECT 1
         FROM marketing_envios_telemetria
         WHERE empresa_id = $1
           AND estrategia = 'base_importada_auto'
           AND created_at > NOW() - ($2::text || ' minutes')::interval
         LIMIT 1`,
        [empresaId, intervaloMin]
      );
      if (reciente.length) continue;

      const canal = normalizeCanal(cfg.launch_canal || cfg.import_canal_objetivo || 'whatsapp');
      const maxEnvios = Math.min(Math.max(Number(cfg.launch_max_envios || 100), 1), 1000);
      const frecuenciaHoras = Math.min(Math.max(Number(cfg.launch_frecuencia_horas || 24), 1), 24 * 30);

      const listaNombre = String(cfg.import_lista_nombre || '').trim();
      const rubro = String(cfg.import_rubro || '').trim();
      const zona = String(cfg.import_zona || '').trim();
      const estrategia = 'base_importada_auto';

      const filtrosBase = [
        'mc.empresa_id = $1',
        "COALESCE(mc.consent_status,'unknown')='granted'",
        'mc.optout_at IS NULL',
        "COALESCE(mc.estado, 'new') NOT IN ('opted_out','invalid')"
      ];
      const paramsBase = [empresaId];
      let idxBase = 2;
      if (listaNombre) { filtrosBase.push(`mc.lista_nombre = $${idxBase++}`); paramsBase.push(listaNombre); }
      if (rubro) { filtrosBase.push(`mc.rubro = $${idxBase++}`); paramsBase.push(rubro); }
      if (zona) { filtrosBase.push(`mc.zona = $${idxBase++}`); paramsBase.push(zona); }
      paramsBase.push(frecuenciaHoras);
      const freqIdxBase = idxBase++;

      const recentClause = `NOT EXISTS (
        SELECT 1
        FROM marketing_envios_telemetria t
        WHERE t.empresa_id = mc.empresa_id
          AND t.estrategia = '${estrategia}'
          AND t.telefono = mc.telefono_normalizado
          AND t.created_at > NOW() - ($${freqIdxBase}::text || ' hours')::interval
      )`;

      const readyCountRows = await query(
        `SELECT COUNT(*)::int AS total
         FROM marketing_contactos mc
         WHERE ${filtrosBase.join(' AND ')}
           AND mc.estado IN ('ready','replied')
           AND ${recentClause}`,
        paramsBase
      );

      const readyDisponibles = Number(readyCountRows?.[0]?.total || 0);
      const faltan = Math.max(0, maxEnvios - readyDisponibles);

      if (faltan > 0) {
        const refillParams = [...paramsBase, faltan];
        const refillLimitIdx = idxBase;
        const refillRows = await query(
          `SELECT mc.id
           FROM marketing_contactos mc
           WHERE ${filtrosBase.join(' AND ')}
             AND COALESCE(mc.estado, 'new') NOT IN ('ready','replied','opted_out','invalid')
             AND ${recentClause}
           ORDER BY
             CASE
               WHEN mc.estado = 'validated' THEN 0
               WHEN mc.estado IN ('new','nuevo') THEN 1
               WHEN mc.estado = 'contacted' THEN 2
               ELSE 9
             END,
             mc.updated_at ASC,
             mc.id ASC
           LIMIT $${refillLimitIdx}`,
          refillParams
        );

        if (refillRows.length) {
          await query(
            `UPDATE marketing_contactos
             SET estado = 'ready', updated_at = NOW()
             WHERE empresa_id = $1
               AND id = ANY($2::bigint[])`,
            [empresaId, refillRows.map((r) => Number(r.id)).filter(Boolean)]
          );
        }
      }

      const rows = await query(
        `SELECT mc.id, mc.telefono, mc.rubro, mc.zona, mc.lista_nombre
         FROM marketing_contactos mc
         WHERE ${filtrosBase.join(' AND ')}
           AND mc.estado IN ('ready','replied')
           AND ${recentClause}
         ORDER BY
           CASE WHEN mc.estado = 'replied' THEN 0 ELSE 1 END,
           mc.updated_at DESC,
           mc.id DESC
         LIMIT $${idxBase}`,
        [...paramsBase, maxEnvios]
      );

      for (const c of rows) {
        const msg = renderTemplateMsg(mensajeTpl, { cliente: '', rubro: c.rubro, zona: c.zona });
        await enviarPorCanal({
          empresaId,
          estrategia,
          telefono: c.telefono,
          mensaje: msg,
          canal,
          meta: {
            contacto_id: c.id,
            lista_nombre: c.lista_nombre,
            rubro: c.rubro,
            zona: c.zona,
            auto: true,
          },
        });

        await query(`UPDATE marketing_contactos SET estado='contacted', updated_at=NOW() WHERE id=$1 AND empresa_id=$2`, [c.id, empresaId]);
      }
    }
  } catch (e) {
    console.error('[ESTRATEGIAS] Error en ejecutarCampaniaBaseImportadaAuto:', e?.message || e);
  }
}
