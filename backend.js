import webpush from 'web-push';
import { query, pointInAnyZone as corePointInAnyZone } from './src/services.js';

// -------------------------------------------------------------------
// WebPush (VAPID)
// -------------------------------------------------------------------
const {
  VAPID_PUBLIC_KEY = '',
  VAPID_PRIVATE_KEY = '',
  VAPID_SUBJECT = 'mailto:admin@example.com',
} = process.env;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// -------------------------------------------------------------------
// Push templates por estado
// -------------------------------------------------------------------
const STATE_PUSH_TEMPLATES = {
  pendiente: (pedido_id) => ({
    title: '¡Recibimos tu pedido!',
    body: 'Tu pedido fue recibido correctamente.',
    url: `/Pedidos/pedido.html?id=${pedido_id}`,
    pedido_id,
  }),
  en_ruta: (pedido_id) => ({
    title: 'Estamos llegando',
    body: 'Tu pedido ya está en camino.',
    url: `/Pedidos/pedido.html?id=${pedido_id}`,
    pedido_id,
  }),
  entregado: (pedido_id) => ({
    title: 'Pedido entregado',
    body: 'Tu pedido fue entregado. ¡Gracias!',
    url: `/Pedidos/pedido.html?id=${pedido_id}`,
    pedido_id,
  }),
};

function buildPushForEstado(pedido_id, estado) {
  const tpl = STATE_PUSH_TEMPLATES[String(estado || '').toLowerCase()];
  return tpl ? tpl(pedido_id) : null;
}

export async function notifyEstadoPedidoPush(pedido_id, estado) {
  const payload = buildPushForEstado(pedido_id, estado);
  if (!payload) return;
  await notifyByPedido(pedido_id, payload);
}

// -------------------------------------------------------------------
// Helper: notificar por pedido
// -------------------------------------------------------------------
export async function notifyByPedido(pedido_id, payload) {
  const rows = await query(
    `SELECT s.endpoint, s.p256dh, s.auth
     FROM push_sub_pedidos m
     JOIN push_subs s ON s.id = m.sub_id
     WHERE m.pedido_id = $1`,
    [pedido_id]
  );

  for (const r of rows) {
    const sub = {
      endpoint: r.endpoint,
      keys: { p256dh: r.p256dh, auth: r.auth },
    };

    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await query(`DELETE FROM push_subs WHERE endpoint=$1`, [r.endpoint]);
      }
    }
  }
}

export const pointInAnyZone = corePointInAnyZone;

export default { notifyByPedido, pointInAnyZone };

export async function getEmpresaById(req, res) {
  try {
    const { id } = req.params;
    const usuario = req.user || {};

    if (usuario.role !== 'super' && Number(id) !== Number(usuario.empresa_id)) {
      return res.status(403).json({ error: 'No tienes permiso para ver esta licencia.' });
    }

    const rows = await query('SELECT * FROM empresas WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Empresa no encontrada' });

    return res.json(rows[0]);
  } catch (err) {
    console.error('Error getEmpresaById:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}
