// src/adm/alquileresController.js

import { query, pool } from '../db.js';
import { resolveEmpresaId } from '../services.js';
import { MercadoPagoConfig, Preference } from 'mercadopago';

// ==================================================================
// Configuración Mercado Pago para ALQUILERES
// ==================================================================
const mpAccessToken = process.env.MP_ACCESS_TOKEN || '';
let mpClient = null;

if (mpAccessToken) {
  mpClient = new MercadoPagoConfig({
    accessToken: mpAccessToken,
    options: {
      timeout: 5000,
      integratorId: process.env.MP_CLIENT_ID || undefined
    }
  });
}

/**
 * Crea una preferencia de pago de Mercado Pago para un alquiler mensual.
 * Idealmente este helper podría moverse a src/mercadoPagoService.js si
 * querés centralizar toda la integración en un solo módulo.
 */
async function crearPreferenciaAlquiler({
  empresaId,
  clienteId,
  clienteNombre,
  periodo,
  monto,
  email
}) {
  if (!mpClient) {
    throw new Error('Mercado Pago no está configurado (falta MP_ACCESS_TOKEN).');
  }
  if (!monto || Number(monto) <= 0) {
    throw new Error('Monto inválido para generar link de pago.');
  }

  const preference = new Preference(mpClient);

  const webhookUrl = process.env.MP_WEBHOOK_URL || undefined;
  const baseUrl = process.env.APP_BASE_URL || 'https://pedivoy.com';

  const periodoDate = new Date(periodo);
  const periodoLabel = isNaN(periodoDate.getTime())
    ? String(periodo)
    : `${String(periodoDate.getMonth() + 1).padStart(2, '0')}/${periodoDate.getFullYear()}`;

  // External reference para poder cruzar pagos en el webhook
  const externalRef = [
    'ALQ',
    `emp:${empresaId}`,
    `cli:${clienteId}`,
    `per:${periodoLabel}`
  ].join('|');

  const result = await preference.create({
    body: {
      items: [
        {
          id: externalRef,
          title: `Alquiler de activos - ${clienteNombre}`,
          description: `Alquiler de activos correspondientes al período ${periodoLabel}`,
          quantity: 1,
          unit_price: Number(monto),
          currency_id: 'ARS'
        }
      ],
      payer: {
        email: email || 'cliente@example.com'
      },
      external_reference: externalRef,
      notification_url: webhookUrl,
      back_urls: {
        success: `${baseUrl}/pedidos/alquileres.html?status=approved`,
        failure: `${baseUrl}/pedidos/alquileres.html?status=failure`,
        pending: `${baseUrl}/pedidos/alquileres.html?status=pending`
      },
      auto_return: 'approved'
    }
  });

  return {
    init_point: result.init_point,
    sandbox_init_point: result.sandbox_init_point,
    id: result.id
  };
}

// ==================================================================
// Helper de período
// ==================================================================
function normalizarPeriodo(rawPeriodo) {
  if (!rawPeriodo) return null;
  // Si viene como YYYY-MM, lo completamos a YYYY-MM-01
  if (/^\d{4}-\d{2}$/.test(rawPeriodo)) {
    return `${rawPeriodo}-01`;
  }
  // Si viene como Date o string YYYY-MM-DD, devolvemos YYYY-MM-01
  const d = new Date(rawPeriodo);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

// ==================================================================
// 1. LISTAR ALQUILERES DEL PERÍODO
// ==================================================================
export async function listarAlquileres(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);
    if (!empresaId) {
      return res.status(400).json({ error: 'Falta empresa.' });
    }

    const periodoNorm = normalizarPeriodo(req.query.periodo);
    if (!periodoNorm) {
      return res.status(400).json({ error: 'Período inválido.' });
    }

    const estado = (req.query.estado || '').toLowerCase();
    const params = [empresaId, periodoNorm];
    const whereEstado =
      estado && estado !== 'todos'
        ? `AND lower(a.estado) = $3`
        : '';

    if (whereEstado) {
      params.push(estado);
    }

  const rows = await query(
    `
    SELECT
      a.id,
      a.empresa_id,
      a.cliente_id,
      p.nombre            AS cliente_nombre,
      COALESCE(p.direccion_completa, p.direccion) AS cliente_direccion,
      p.telefono         AS cliente_telefono,
      a.periodo,
      a.total_activos,
      a.monto_total,
      a.estado,
      a.ultimo_pago_fecha,
      a.ultimo_pago_monto,
      a.mp_link,
      a.detalle_activos
    FROM empresa_activos_alquileres a
    LEFT JOIN puntos_entrega p
      ON p.id = a.cliente_id
    WHERE a.empresa_id = $1
      AND a.periodo = date_trunc('month', $2::date)
      ${whereEstado}
    ORDER BY cliente_nombre ASC, a.cliente_id ASC
    `,
    params
  );

    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('Error listarAlquileres:', e);
    return res.status(500).json({ error: e.message || 'Error listando alquileres' });
  }
}

// ==================================================================
// 2. RESUMEN / KPI DEL PERÍODO
// ==================================================================
export async function resumenAlquileres(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);
    if (!empresaId) {
      return res.status(400).json({ error: 'Falta empresa.' });
    }

    const periodoNorm = normalizarPeriodo(req.query.periodo);
    if (!periodoNorm) {
      return res.status(400).json({ error: 'Período inválido.' });
    }

    const rows = await query(
      `
      SELECT
        COALESCE(SUM(a.monto_total), 0)::numeric                       AS total_monto,
        COALESCE(SUM(CASE WHEN lower(a.estado) = 'cobrado'
                          THEN a.monto_total ELSE 0 END), 0)::numeric AS cobrado,
        COALESCE(SUM(CASE WHEN lower(a.estado) IN ('pendiente','facturado')
                          THEN a.monto_total ELSE 0 END), 0)::numeric AS pendiente,
        COUNT(DISTINCT a.cliente_id)                                   AS clientes
      FROM empresa_activos_alquileres a
      WHERE a.empresa_id = $1
        AND a.periodo = date_trunc('month', $2::date)
      `,
      [empresaId, periodoNorm]
    );

    const data = rows[0] || {
      total_monto: 0,
      cobrado: 0,
      pendiente: 0,
      clientes: 0
    };

    return res.json({ ok: true, data });
  } catch (e) {
    console.error('Error resumenAlquileres:', e);
    return res.status(500).json({ error: e.message || 'Error obteniendo resumen de alquileres' });
  }
}

// ==================================================================
// 3. GENERAR LINK MERCADO PAGO PARA UN CLIENTE + PERÍODO
// ==================================================================
export async function generarLinkMercadoPago(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);
    if (!empresaId) {
      return res.status(400).json({ error: 'Falta empresa.' });
    }

    const { cliente_id, periodo, email } = req.body || {};
    const clienteId = Number(cliente_id);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'cliente_id inválido.' });
    }

    const periodoNorm = normalizarPeriodo(periodo || req.body?.periodo);
    if (!periodoNorm) {
      return res.status(400).json({ error: 'Período inválido.' });
    }

    // Traer info del registro de alquiler + cliente
    const rows = await query(
      `
      SELECT
        a.id,
        a.empresa_id,
        a.cliente_id,
        a.periodo,
        a.monto_total,
        a.estado,
        a.mp_link,
        a.mp_preference_id,
        p.nombre              AS cliente_nombre,
        COALESCE(p.email, p.email_facturacion) AS cliente_email
      FROM empresa_activos_alquileres a
      LEFT JOIN puntos_entrega p
        ON p.id = a.cliente_id
      WHERE a.empresa_id = $1
        AND a.cliente_id = $2
        AND a.periodo = date_trunc('month', $3::date)
      LIMIT 1
      `,
      [empresaId, clienteId, periodoNorm]
    );

    const alquiler = rows[0];
    if (!alquiler) {
      return res.status(404).json({ error: 'No hay alquiler registrado para ese cliente y período.' });
    }

    const monto = Number(alquiler.monto_total || 0);
    if (!monto || monto <= 0) {
      return res.status(400).json({ error: 'El monto del alquiler es 0. No se puede generar un cobro.' });
    }

    const clienteNombre = alquiler.cliente_nombre || `Cliente ${alquiler.cliente_id}`;
    const correo = email || alquiler.cliente_email || 'cliente@example.com';

    // Crear preferencia en Mercado Pago
    const pref = await crearPreferenciaAlquiler({
      empresaId,
      clienteId,
      clienteNombre,
      periodo: periodoNorm,
      monto,
      email: correo
    });

    const mpLink = pref.init_point;
    const mpPreferenceId = pref.id || null;

    // Guardar link y preference id para tener el cruce luego

    const updated = await query(
    `
    UPDATE empresa_activos_alquileres
        SET mp_link          = $3,
            mp_preference_id = $4,
            estado           = CASE 
                                WHEN estado = 'pendiente' THEN 'facturado'
                                ELSE estado
                                END,
            updated_at       = NOW()
    WHERE id = $1
        AND empresa_id = $2
    RETURNING
        id,
        empresa_id,
        cliente_id,
        periodo,
        total_activos,
        monto_total,
        estado,
        ultimo_pago_fecha,
        ultimo_pago_monto,
        mp_link,
        mp_preference_id
    `,
    [
        alquiler.id,     // $1
        empresaId,       // $2
        mpLink,          // $3
        mpPreferenceId   // $4
    ]
    );

    return res.json({
      ok: true,
      mp_link: mpLink,
      mp_preference_id: mpPreferenceId,
      data: updated[0] || null
    });
  } catch (e) {
    console.error('Error generarLinkMercadoPago:', e);
    return res.status(500).json({ error: e.message || 'Error generando link de pago' });
  }
}

// ==================================================================
// 4. MARCAR ALQUILER COMO COBRADO
// ==================================================================
export async function marcarAlquilerCobrado(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);
    if (!empresaId) {
      return res.status(400).json({ error: 'Falta empresa.' });
    }

    const { id, monto_pagado } = req.body || {};
    const alquilerId = Number(id);
    if (!Number.isInteger(alquilerId) || alquilerId <= 0) {
      return res.status(400).json({ error: 'ID de alquiler inválido.' });
    }

    const montoPagadoNum =
      monto_pagado === undefined || monto_pagado === null
        ? null
        : Number(monto_pagado);

    const rows = await query(
      `
      UPDATE empresa_activos_alquileres
         SET estado = 'cobrado',
             ultimo_pago_fecha = NOW(),
             ultimo_pago_monto = COALESCE($3, ultimo_pago_monto, monto_total),
             updated_at = NOW()
       WHERE id = $1
         AND empresa_id = $2
       RETURNING *
      `,
      [alquilerId, empresaId, montoPagadoNum]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Alquiler no encontrado.' });
    }

    return res.json({ ok: true, data: row });
  } catch (e) {
    console.error('Error marcarAlquilerCobrado:', e);
    return res.status(500).json({ error: e.message || 'Error marcando alquiler como cobrado' });
  }
}

// ==================================================================
// 5. GENERAR CARGOS DEL PERÍODO 
// ==================================================================

export async function generarCargosPeriodo(req, res) {
  let client;

  try {
    client = await pool.connect();

    // 1. Lógica Super Admin
    let empresaId = resolveEmpresaId(req);
    if (req.user.role === 'super' && req.body.empresa_id) {
      empresaId = Number(req.body.empresa_id);
    }

    const rawPeriodo = req.body?.periodo; 
    const periodoNorm = normalizarPeriodo(rawPeriodo);

    if (!periodoNorm) {
      return res.status(400).json({ error: 'Período inválido.' });
    }

    await client.query('BEGIN');

    // --- CAMBIO 1: Eliminamos el bloque que verificaba existencia y daba error 400 ---
    // Queremos permitir la regeneración (actualización) si ya existen.

    // 2. Calcular cargos con PRORRATEO
    const sqlCalculo = `
      WITH periodo_params AS (
        SELECT 
          $2::date as inicio_mes,
          ($2::date + INTERVAL '1 month' - INTERVAL '1 day')::date as fin_mes
      )
      SELECT
        a.cliente_id,
        SUM(
          CASE 
            WHEN a.fecha_inicio_alquiler >= (SELECT inicio_mes FROM periodo_params) THEN
              ROUND(
                (a.alquiler_mensual / 30.0) * (
                  EXTRACT(DAY FROM (SELECT fin_mes FROM periodo_params)) 
                  - EXTRACT(DAY FROM a.fecha_inicio_alquiler) 
                  + 1
                )
              , 2)
            ELSE a.alquiler_mensual 
          END
        ) as monto_total,
        COUNT(a.id) as cantidad_activos,
        jsonb_agg(
          jsonb_build_object(
            'codigo',         a.codigo,
            'modelo',         a.modelo,
            'alquiler_full',  a.alquiler_mensual,
            'fecha_inicio',   a.fecha_inicio_alquiler,
            'es_prorrateo',   (a.fecha_inicio_alquiler >= $2::date)
          )
        ) as detalle_activos
      FROM empresa_activos a
      WHERE a.empresa_id = $1
        AND a.cliente_id IS NOT NULL
        AND a.estado = 'prestado'
        AND a.alquiler_mensual > 0
        AND a.fecha_inicio_alquiler <= (SELECT fin_mes FROM periodo_params)
      GROUP BY a.cliente_id
    `;

    const { rows: cargos } = await client.query(sqlCalculo, [
      empresaId,
      periodoNorm
    ]);

    if (cargos.length === 0) {
      await client.query('ROLLBACK');
      return res.json({
        mensaje: 'No hay activos alquilados para facturar en este período.'
      });
    }

    // 3. Insertar o Actualizar (Upsert) los cargos
    // --- CAMBIO 2: Usamos ON CONFLICT para actualizar si ya existe ---
    for (const c of cargos) {
      await client.query(
        `
        INSERT INTO empresa_activos_alquileres 
          (empresa_id, cliente_id, periodo, monto_total, total_activos, detalle_activos, estado, created_at, updated_at)
        VALUES (
          $1,
          $2,
          date_trunc('month', $3::date),
          $4,
          $5,
          $6,
          'pendiente',
          NOW(),
          NOW()
        )
        ON CONFLICT (empresa_id, cliente_id, periodo)
        DO UPDATE SET
          monto_total     = EXCLUDED.monto_total,
          total_activos   = EXCLUDED.total_activos,
          detalle_activos = EXCLUDED.detalle_activos,
          updated_at      = NOW()
        WHERE empresa_activos_alquileres.estado = 'pendiente'
        `,
        [
          empresaId,
          c.cliente_id,
          periodoNorm,
          c.monto_total,
          c.cantidad_activos,
          JSON.stringify(c.detalle_activos)
        ]
      );
    }

    await client.query('COMMIT');

    return res.json({
      mensaje: `Proceso finalizado. Se procesaron ${cargos.length} cargos de alquiler (creados o actualizados).`
    });
  } catch (e) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    console.error('Error generando cargos de alquiler:', e);
    return res.status(500).json({ error: 'Error generando cargos' });
  } finally {
    if (client) {
      client.release();
    }
  }
}



