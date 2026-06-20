// src/transferenciasServices.js — PostgreSQL (Versión Final Completa)
import { query } from './db.js';

function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

// ============================================
// 1. CHEQUEAR DUPLICADO (Validación de Seguridad)
// ============================================
export async function verificarDuplicadoOperacionPg(nroOperacion) {
  if (!nroOperacion) return false;

  const cleanOp = String(nroOperacion).trim();

  const rows = await query(
    `SELECT id FROM comprobantes_transferencia 
     WHERE LOWER(nro_operacion) = LOWER($1) 
     LIMIT 1`,
    [cleanOp]
  );

  return rows.length > 0;
}

// ============================================
// 2. INSERTAR NUEVO COMPROBANTE (Con Vinculación Automática)
// ============================================
export async function insertarComprobantePg({
  telefono,
  imagen_path,
  fecha,
  mimetype, // (por ahora no se usa, pero lo dejamos por si se loguea a futuro)
  bytes     // (idem)
}) {
  const telClean = digitsOnly(telefono);
  // Usamos los últimos 10 dígitos para mejorar el "match" (evita problemas con 549 vs 0)
  const telSuffix = telClean.slice(-10) || telClean;

  // --- LÓGICA DE VINCULACIÓN ---
  // Buscamos el último pedido asociado a este teléfono.
  // Prioridad: El más reciente (ORDER BY id DESC).
  // Estados: Incluimos 'entregado' para clientes que pagan post-entrega.
  const sqlMatch = `
    SELECT 
      p.id AS pedido_id, 
      p.empresa_id, 
      p.chofer_id,
      p.monto
    FROM pedidos p
    JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
    WHERE 
      pe.telefono_normalizado LIKE '%' || $1
      AND p.estado IN ('pendiente', 'en_ruta', 'en_camino', 'entregado')
    ORDER BY p.id DESC 
    LIMIT 1
  `;

  const matchResult = await query(sqlMatch, [telSuffix]);
  const pedidoEncontrado = matchResult[0] || {};

  // Datos para vincular (o NULL si no se encontró nada)
  const pid = pedidoEncontrado.pedido_id || null;
  const eid = pedidoEncontrado.empresa_id || null;
  const cid = pedidoEncontrado.chofer_id || null;

  if (pid) {
    console.log(
      `[Transferencia] ✅ Vinculado Automáticamente al Pedido #${pid} (Empresa ${eid})`
    );
  } else {
    console.log(
      `[Transferencia] ⚠️ No se encontró pedido reciente para Tel ${telClean}. ` +
      `Se guarda para revisión manual.`
    );
  }

  // --- INSERTAR ---
  const rows = await query(
    `
    INSERT INTO comprobantes_transferencia
      (telefono, archivo_path, comprobante_path, fecha, 
       pedido_id, empresa_id, chofer_id,
       created_at, updated_at, validado, procesado)
    VALUES ($1, $2, $3, $4, 
            $5, $6, $7,
            NOW(), NOW(), 0, FALSE)
    RETURNING id, empresa_id, pedido_id
    `,
    [
      telClean,
      imagen_path,
      imagen_path,
      fecha,
      pid, // ID del pedido vinculado (o null)
      eid, // Empresa (o null)
      cid  // Chofer (o null)
    ]
  );

  // rows[0] tiene forma: { id, empresa_id, pedido_id }
  return rows[0];
}

// ============================================
// 3. ACTUALIZAR DATOS DEL COMPROBANTE (Post GPT)
// ============================================
export async function actualizarComprobanteDatosPg(id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;

  // Construcción dinámica del UPDATE
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(',');
  const params = [id, ...keys.map((k) => data[k])];

  await query(
    `UPDATE comprobantes_transferencia SET ${sets}, updated_at=NOW() WHERE id=$1`,
    params
  );
}

// ============================================
// 4. MARCAR COMO PROCESADO
// ============================================
export async function marcarComprobanteComoProcesadoPg(id) {
  await query(
    `UPDATE comprobantes_transferencia 
     SET procesado = TRUE, 
         fecha_procesado = NOW(),
         validado = 1,
         estado_revision = 'aprobado',
         verified_reason = COALESCE(verified_reason, 'Validacion automatica por IA desde WhatsApp'),
         verified_at = COALESCE(verified_at, NOW()),
         updated_at = NOW() 
     WHERE id = $1`,
    [id]
  );
}

// ============================================
// 5. ENCOLAR MENSAJE WHATSAPP (multi-tenant)
// ============================================
export async function enqueueWppMessagePg({ phone, message, empresaId = null }) {
  if (!phone || !message) return;

  const cleanPhone = digitsOnly(phone);
  const cleanMsg = String(message).trim();
  if (!cleanMsg) return;

  await query(
    `
    INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, created_at)
    VALUES ($1, $2, $3, 'pending', NOW())
    `,
    [empresaId, cleanPhone, cleanMsg]
  );
}
