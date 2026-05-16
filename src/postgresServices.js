// src/postgresServices.js – PostgreSQL rewrite
import { query } from './db.js';
import { nowIso } from './utils.js';

// -----------------------------
// Helpers
// -----------------------------
export const digitsOnly = v => String(v || '').replace(/\D+/g, '');

// -----------------------------
// Buscar PEDIDO por teléfono
// -----------------------------
export async function findPedidoIdByTelefono(arg) {
  const telefono = String(arg?.telefono || arg || '').trim();
  const raw = digitsOnly(telefono);
  const tel10 = raw.slice(-10);

  const rows = await query(`
    SELECT p.id
    FROM pedidos p
    JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
    WHERE RIGHT(REGEXP_REPLACE(pe.telefono, '\D', '', 'g'), 10) = $1
    ORDER BY p.fecha DESC, p.id DESC
    LIMIT 1
  `, [tel10]);

  return rows?.[0]?.id || null;
}

// -----------------------------
// Insertar COMPROBANTE
// -----------------------------
export async function saveComprobante(pedido_id, imagen_path, extra = {}) {
  const fecha = extra.fecha || nowIso();
  const params = [
    pedido_id,
    imagen_path,
    fecha,
    extra.monto || 0,
    extra.moneda || 'ARS',
    extra.banco_origen || null,
    extra.banco_destino || null,
    extra.alias_destino || null,
    extra.cbu_destino || null,
    extra.nro_operacion || null,
    extra.titular_origen || null,
    extra.fecha_operacion || null,
    extra.ocr_text || null,
    extra.ocr_confidence || 0
  ];

  const rows = await query(`
    INSERT INTO comprobantes_transferencia
      (pedido_id, imagen_path, fecha, monto, moneda,
       banco_origen, banco_destino, alias_destino, cbu_destino,
       nro_operacion, titular_origen, fecha_operacion,
       ocr_text, ocr_confidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING id
  `, params);

  return { id: rows?.[0]?.id };
}

// -----------------------------
// Obtener ítems de pedido
// -----------------------------
export async function getPedidoItems(pedido_id) {
  return await query(`
    SELECT id, producto, cantidad, precio_unitario
    FROM items_pedido
    WHERE pedido_id = $1
    ORDER BY id ASC
  `, [pedido_id]);
}

// -----------------------------
// Actualizar ítems (upsert + delete faltantes)
// -----------------------------
export async function updatePedidoItems(pedido_id, items = []) {
  // Eliminar todos primero
  await query(`
    DELETE FROM items_pedido WHERE pedido_id = $1
  `, [pedido_id]);

  // Insertar nuevos
  for (const it of items) {
    if (!it.producto) continue;

    await query(`
      INSERT INTO items_pedido (pedido_id, producto, cantidad, precio_unitario)
      VALUES ($1,$2,$3,$4)
    `, [
      pedido_id,
      it.producto,
      Number(it.cantidad) || 0,
      Number(it.precio_unitario) || 0
    ]);
  }

  return true;
}
