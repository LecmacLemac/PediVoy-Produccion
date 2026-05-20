let referenteNotificationsSchemaReady = false;

export async function ensureReferenteNotificationsSchema(queryFn) {
  if (referenteNotificationsSchemaReady) return;
  await queryFn(`
    CREATE TABLE IF NOT EXISTS referente_notificaciones (
      id             SERIAL PRIMARY KEY,
      empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      referente_id   INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
      tipo           TEXT NOT NULL,
      titulo         TEXT NOT NULL,
      mensaje        TEXT NOT NULL,
      pedido_id      INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
      comision_id    INTEGER REFERENCES referente_comisiones(id) ON DELETE SET NULL,
      leida_at       TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await queryFn(`
    CREATE INDEX IF NOT EXISTS referente_notificaciones_ref_idx
      ON referente_notificaciones (empresa_id, referente_id, leida_at, created_at DESC)
  `);
  referenteNotificationsSchemaReady = true;
}

function estadoLabel(estado) {
  const value = String(estado || '').toLowerCase();
  return {
    pendiente: 'pendiente',
    en_ruta: 'en ruta',
    en_camino: 'en camino',
    entregado: 'entregado',
    cancelado: 'cancelado',
  }[value] || value || 'actualizado';
}

export async function createPedidoEstadoNotifications({ queryFn, empresaId, pedidoId, estado }) {
  if (!queryFn || !empresaId || !pedidoId || !estado) return [];
  await ensureReferenteNotificationsSchema(queryFn);
  const label = estadoLabel(estado);
  return queryFn(
    `INSERT INTO referente_notificaciones (
       empresa_id, referente_id, tipo, titulo, mensaje, pedido_id
     )
     SELECT DISTINCT
            p.empresa_id,
            cr.referente_id,
            'pedido_estado',
            'Pedido #' || p.id || ' ' || $3,
            'El pedido de ' || COALESCE(pe.cliente, 'cliente vinculado') || ' cambió a estado ' || $3 || '.',
            p.id
       FROM pedidos p
       JOIN cliente_referentes cr
         ON cr.empresa_id = p.empresa_id
       AND cr.punto_entrega_id = p.punto_entrega_id
        AND cr.estado = 'activo'
       LEFT JOIN puntos_entrega pe
         ON pe.id = p.punto_entrega_id
        AND pe.empresa_id = p.empresa_id
      WHERE p.empresa_id = $1
        AND p.id = $2
        AND COALESCE(p.fecha, p.fecha_entrega, NOW()) >= COALESCE(cr.asociado_at, '-infinity'::timestamptz)
     RETURNING id, referente_id`,
    [empresaId, pedidoId, label]
  );
}

export async function createComisionLiquidadaNotifications({ queryFn, empresaId, comisiones = [] }) {
  if (!queryFn || !empresaId || !comisiones.length) return [];
  await ensureReferenteNotificationsSchema(queryFn);
  const ids = [...new Set(comisiones.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];

  return queryFn(
    `INSERT INTO referente_notificaciones (
       empresa_id, referente_id, tipo, titulo, mensaje, pedido_id, comision_id
     )
     SELECT rc.empresa_id,
            rc.referente_id,
            'comision_liquidada',
            'Comisión liquidada',
            'Se liquidó una comisión de $' || ROUND(COALESCE(rc.monto_comision, 0))::text || ' del pedido #' || COALESCE(rc.pedido_id::text, '-'),
            rc.pedido_id,
            rc.id
       FROM referente_comisiones rc
      WHERE rc.empresa_id = $1
        AND rc.id = ANY($2::int[])
     RETURNING id, referente_id`,
    [empresaId, ids]
  );
}
