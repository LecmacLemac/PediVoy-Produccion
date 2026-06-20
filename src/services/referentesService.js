function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function isPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

export function normalizeReferenteCode(value) {
  return normalizeCode(value);
}

export async function findActiveReferenteByCode({ queryFn, empresaId, codigo }) {
  const code = normalizeCode(codigo);
  if (!code || !empresaId) return null;

  const rows = await queryFn(
    `SELECT id, empresa_id, nombre, codigo, porcentaje_comision, vigente_desde, vigente_hasta, activo
       FROM referentes
      WHERE empresa_id = $1
        AND LOWER(codigo) = LOWER($2)
        AND activo = TRUE
        AND deleted_at IS NULL
        AND (vigente_desde IS NULL OR vigente_desde <= CURRENT_DATE)
        AND (vigente_hasta IS NULL OR vigente_hasta >= CURRENT_DATE)
      LIMIT 1`,
    [empresaId, code]
  );

  return rows[0] || null;
}

export async function associateClienteWithReferente({ queryFn, empresaId, puntoEntregaId, codigo }) {
  if (!empresaId || !puntoEntregaId) return null;

  const referente = await findActiveReferenteByCode({ queryFn, empresaId, codigo });
  if (!referente) return null;

  const existing = await queryFn(
    `SELECT cr.id, cr.referente_id, r.codigo
       FROM cliente_referentes cr
       JOIN referentes r ON r.id = cr.referente_id
      WHERE cr.empresa_id = $1
        AND cr.punto_entrega_id = $2
        AND cr.estado = 'activo'
      LIMIT 1`,
    [empresaId, puntoEntregaId]
  );

  if (existing.length) {
    return {
      referente_id: Number(existing[0].referente_id),
      codigo: existing[0].codigo,
      created: false,
    };
  }

  const rows = await queryFn(
    `INSERT INTO cliente_referentes (
       empresa_id, punto_entrega_id, referente_id, codigo_referente, estado, asociado_at
     ) VALUES ($1,$2,$3,$4,'activo',NOW())
     ON CONFLICT DO NOTHING
     RETURNING id, referente_id, codigo_referente`,
    [empresaId, puntoEntregaId, referente.id, referente.codigo]
  );

  if (!rows.length) return null;
  return {
    id: rows[0].id,
    referente_id: Number(rows[0].referente_id),
    codigo: rows[0].codigo_referente,
    created: true,
  };
}

export async function generateComisionesForDeliveredOrder({ queryFn, empresaId, pedidoId }) {
  if (!empresaId || !pedidoId) return { inserted: 0 };

  const pedidoRows = await queryFn(
    `SELECT id, empresa_id, punto_entrega_id, estado, fecha_entrega, fecha
       FROM pedidos
      WHERE id = $1
        AND empresa_id = $2
      LIMIT 1`,
    [pedidoId, empresaId]
  );

  const pedido = pedidoRows[0];
  if (!pedido || String(pedido.estado || '').toLowerCase() !== 'entregado' || !pedido.punto_entrega_id) {
    return { inserted: 0 };
  }

  const assocRows = await queryFn(
    `SELECT cr.referente_id, r.porcentaje_comision
       FROM cliente_referentes cr
       JOIN referentes r ON r.id = cr.referente_id
      WHERE cr.empresa_id = $1
        AND cr.punto_entrega_id = $2
        AND cr.estado = 'activo'
        AND COALESCE($3::timestamptz, NOW()) >= COALESCE(cr.asociado_at, '-infinity'::timestamptz)
        AND r.activo = TRUE
        AND r.deleted_at IS NULL
        AND (r.vigente_desde IS NULL OR r.vigente_desde <= COALESCE($3::date, CURRENT_DATE))
        AND (r.vigente_hasta IS NULL OR r.vigente_hasta >= COALESCE($3::date, CURRENT_DATE))
      ORDER BY cr.asociado_at DESC
      LIMIT 1`,
    [empresaId, pedido.punto_entrega_id, pedido.fecha_entrega || pedido.fecha || null]
  );

  const assoc = assocRows[0];
  if (!assoc) return { inserted: 0 };

  const deliveredDate = pedido.fecha_entrega || pedido.fecha || null;

  const items = await queryFn(
    `SELECT ip.id AS item_pedido_id,
            ip.producto_id,
            ip.cantidad,
            ip.precio_unitario,
            rp.porcentaje_comision AS porcentaje_producto,
            rp.vigente_desde,
            rp.vigente_hasta
       FROM items_pedido ip
       JOIN referente_productos rp
         ON rp.producto_id = ip.producto_id
        AND rp.empresa_id = $2
        AND rp.referente_id = $3
        AND rp.activo = TRUE
        AND (rp.vigente_desde IS NULL OR rp.vigente_desde <= COALESCE($4::date, CURRENT_DATE))
        AND (rp.vigente_hasta IS NULL OR rp.vigente_hasta >= COALESCE($4::date, CURRENT_DATE))
      WHERE ip.pedido_id = $1
        AND ip.producto_id IS NOT NULL`,
    [pedidoId, empresaId, assoc.referente_id, deliveredDate]
  );

  let inserted = 0;

  for (const item of items) {
    const percent = Number(item.porcentaje_producto ?? assoc.porcentaje_comision ?? 0);
    const subtotal = Number(item.cantidad || 0) * Number(item.precio_unitario || 0);
    if (!isPositiveNumber(percent) || !isPositiveNumber(subtotal)) continue;

    const rows = await queryFn(
      `INSERT INTO referente_comisiones (
         empresa_id, referente_id, punto_entrega_id, pedido_id, item_pedido_id,
         producto_id, base_monto, porcentaje, monto_comision, estado, validada_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,ROUND((($7::numeric * $8::numeric) / 100)::numeric, 2),'validada',COALESCE($9::timestamptz,NOW())
       )
       ON CONFLICT (pedido_id, item_pedido_id, referente_id) DO NOTHING
       RETURNING id`,
      [
        empresaId,
        assoc.referente_id,
        pedido.punto_entrega_id,
        pedidoId,
        item.item_pedido_id,
        item.producto_id,
        subtotal,
        percent,
        deliveredDate,
      ]
    );
    inserted += rows.length;
  }

  return { inserted };
}
