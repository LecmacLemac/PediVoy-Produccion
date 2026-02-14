import express from 'express';

function onlyDigits(v) {
  return String(v || '').replace(/\D+/g, '');
}

function toWhatsAppE164AR(tel) {
  let d = onlyDigits(tel);
  if (!d) return null;
  if (d.startsWith('549')) return d;
  if (d.startsWith('54')) return '549' + d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.startsWith('15')) d = d.slice(2);
  return '549' + d;
}

export function createPublicLegacyPedidosRouter({ query }) {
  if (typeof query !== 'function') throw new Error('createPublicLegacyPedidosRouter: falta query(fn)');

  const router = express.Router();

  router.get('/pedido-chofer-wpp', async (req, res) => {
    try {
      const pedido_id = Number(req.query.pedido_id || req.query.id);
      if (!Number.isFinite(pedido_id)) return res.status(400).json({ error: 'pedido_id inválido' });

      let rows = await query(
        `SELECT c.id AS chofer_id, c.nombre, c.telefono
         FROM pedidos p
         JOIN choferes c ON c.id = p.chofer_id
         WHERE p.id=$1`,
        [pedido_id]
      );

      if (!rows.length) {
        rows = await query(
          `SELECT c.id AS chofer_id, c.nombre, c.telefono
           FROM pedidos p
           JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
           JOIN zona_chofer zc ON zc.zona_id = pe.zona_id
           JOIN choferes c ON c.id = zc.chofer_id
           WHERE p.id=$1
           ORDER BY zc.chofer_id ASC
           LIMIT 1`,
          [pedido_id]
        );
      }

      if (!rows.length) return res.status(404).json({ error: 'chofer no asignado' });

      const row = rows[0];
      return res.json({
        ok: true,
        chofer: {
          id: row.chofer_id,
          nombre: row.nombre,
          telefono: row.telefono,
          wa: toWhatsAppE164AR(row.telefono),
        },
      });
    } catch {
      return res.status(500).json({ error: 'No se pudo obtener el WhatsApp del chofer' });
    }
  });

  router.get('/pedido-estado', async (req, res) => {
    try {
      const id = Number(req.query.id);
      if (!id) return res.status(400).json({ error: 'id requerido' });

      const base = await query(
        `SELECT p.id, p.estado, p.fecha,
                pe.cliente, pe.direccion, pe.latitud, pe.longitud, p.monto
         FROM pedidos p
         JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
         WHERE p.id=$1`,
        [id]
      );

      if (!base.length) return res.status(404).json({ error: 'pedido no encontrado' });

      const items = await query(
        `SELECT cantidad, precio_unitario
         FROM items_pedido
         WHERE pedido_id=$1`,
        [id]
      );

      const totalCalc = (items || []).reduce(
        (a, it) => a + (Number(it.cantidad) || 0) * (Number(it.precio_unitario) || 0),
        0
      );

      const row = base[0];
      const monto = Number(row.monto || 0) || Math.round(totalCalc * 100) / 100;
      return res.json({ ...row, monto });
    } catch {
      return res.status(500).json({ error: 'No se pudo obtener el estado del pedido' });
    }
  });

  router.get('/push/vapid-key', (_req, res) => {
    res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
  });

  router.post('/push/subscribe', async (req, res) => {
    try {
      const body = req.body || {};
      const sub = body.subscription
        ? body.subscription
        : {
            endpoint: body.endpoint,
            keys: {
              p256dh: body.p256dh || body.keys?.p256dh,
              auth: body.auth || body.keys?.auth,
            },
          };

      const endpoint = sub?.endpoint;
      if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });

      const p256dh = sub?.keys?.p256dh || null;
      const auth = sub?.keys?.auth || null;
      const empresa_id = Number(body.empresa_id) || null;
      const pedido_id = Number(body.pedido_id) || null;

      const rows = await query(
        `INSERT INTO push_subs (endpoint, p256dh, auth, empresa_id, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           empresa_id = EXCLUDED.empresa_id
         RETURNING id`,
        [endpoint, p256dh, auth, empresa_id]
      );

      const subId = rows[0]?.id;
      if (pedido_id && subId) {
        await query(
          `INSERT INTO push_sub_pedidos (sub_id, pedido_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [subId, pedido_id]
        );
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error('PUSH.SUBSCRIBE ERROR:', e);
      return res.status(500).json({ error: 'No se pudo guardar la suscripción' });
    }
  });

  router.post('/push/unsubscribe', async (req, res) => {
    try {
      const body = req.body || {};
      const endpoint = body.endpoint || body.subscription?.endpoint;
      if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });

      await query(`DELETE FROM push_subs WHERE endpoint=$1`, [endpoint]);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'No se pudo borrar la suscripción' });
    }
  });

  return router;
}
