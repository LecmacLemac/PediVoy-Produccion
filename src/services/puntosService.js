export async function awardPointsForDeliveredOrder({ queryFn, empresaId, puntoEntregaId, pedidoId, monto = 0 }) {
  if (typeof queryFn !== 'function') return { ok: false, reason: 'queryFn_missing' };
  const emp = Number(empresaId || 0);
  const cliente = Number(puntoEntregaId || 0);
  const ped = Number(pedidoId || 0);
  if (!emp || !cliente || !ped) return { ok: false, reason: 'missing_params' };

  const cfgRows = await queryFn(
    `SELECT points_config
       FROM promociones_config
      WHERE empresa_id = $1
      LIMIT 1`,
    [emp]
  );

  const cfg = cfgRows?.[0]?.points_config || {};
  if (!cfg?.enabled) return { ok: false, reason: 'points_disabled' };

  const pointsPerOrder = Number(cfg.points_per_order || 0);
  const pointsPer1000 = Number(cfg.points_per_1000 || 0);
  const amount = Number(monto || 0);

  const pointsByAmount = pointsPer1000 > 0 ? Math.floor((Math.max(amount, 0) / 1000) * pointsPer1000) : 0;
  const points = Math.max(0, Math.floor(pointsPerOrder + pointsByAmount));

  if (points <= 0) return { ok: false, reason: 'zero_points' };

  const inserted = await queryFn(
    `INSERT INTO puntos_movimientos (empresa_id, punto_entrega_id, pedido_id, tipo, puntos, detalle)
     VALUES ($1, $2, $3, 'acumulacion_entrega', $4, $5)
     ON CONFLICT (empresa_id, pedido_id, tipo) WHERE pedido_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [emp, cliente, ped, points, `Puntos por pedido entregado #${ped}`]
  );

  return { ok: true, inserted: inserted?.length > 0, points };
}
