import express from 'express';
import { z } from 'zod';

function onlyDigits(v) {
  return String(v || '').replace(/\D+/g, '');
}

const PUSH_RATE_LIMIT_WINDOW_MS = Number(process.env.PUBLIC_PUSH_RATE_LIMIT_WINDOW_MS || 60_000);
const PUSH_RATE_LIMIT_MAX = Number(process.env.PUBLIC_PUSH_RATE_LIMIT_MAX || 30);
const pushRateState = new Map();

const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2000).optional(),
  p256dh: z.string().max(1024).optional(),
  auth: z.string().max(1024).optional(),
  keys: z.object({
    p256dh: z.string().max(1024).optional(),
    auth: z.string().max(1024).optional(),
  }).optional(),
  subscription: z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({
      p256dh: z.string().max(1024),
      auth: z.string().max(1024),
    }).optional(),
  }).optional(),
  empresa_id: z.coerce.number().int().positive().optional(),
  pedido_id: z.coerce.number().int().positive().optional(),
  tracking_token: z.string().trim().min(1).max(128).optional(),
  pedidos: z.array(z.object({
    pedido_id: z.coerce.number().int().positive(),
    tracking_token: z.string().trim().min(1).max(128),
  })).max(50).optional(),
});

const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(2000).optional(),
  subscription: z.object({ endpoint: z.string().url().max(2000) }).optional(),
});

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(req) {
  const now = Date.now();
  const key = clientIp(req);
  const current = pushRateState.get(key);

  if (!current || now > current.resetAt) {
    const next = { count: 1, resetAt: now + PUSH_RATE_LIMIT_WINDOW_MS };
    pushRateState.set(key, next);
    return { allowed: true, remaining: PUSH_RATE_LIMIT_MAX - 1, resetAt: next.resetAt };
  }

  current.count += 1;
  if (current.count > PUSH_RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetAt: current.resetAt };
  }

  return { allowed: true, remaining: Math.max(0, PUSH_RATE_LIMIT_MAX - current.count), resetAt: current.resetAt };
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

export function createPublicLegacyPedidosRouter({ query, withTransaction }) {
  if (typeof query !== 'function') throw new Error('createPublicLegacyPedidosRouter: falta query(fn)');
  const runInTransaction = typeof withTransaction === 'function'
    ? withTransaction
    : async (work) => work(query);

  const router = express.Router();

  router.get('/pedido-chofer-wpp', async (req, res) => {
    try {
      const pedido_id = Number(req.query.pedido_id || req.query.id);
      const token = String(req.query.token || req.query.t || '').trim();
      if (!Number.isFinite(pedido_id)) return res.status(400).json({ error: 'pedido_id inválido' });
      if (!token) {
        return res.status(410).json({
          error: 'Endpoint legacy protegido',
          tracking_required: true,
        });
      }

      let rows = await query(
        `SELECT c.id AS chofer_id, c.nombre, c.telefono
         FROM pedidos p
         JOIN choferes c ON c.id = p.chofer_id
         WHERE p.id=$1 AND p.tracking_token=$2`,
        [pedido_id, token]
      );

      if (!rows.length) {
        rows = await query(
          `SELECT c.id AS chofer_id, c.nombre, c.telefono
           FROM pedidos p
           JOIN puntos_entrega pe
             ON pe.id = p.punto_entrega_id
            AND pe.empresa_id = p.empresa_id
           JOIN zona_chofer zc ON zc.zona_id = pe.zona_id
           JOIN choferes c ON c.id = zc.chofer_id
           WHERE p.id=$1 AND p.tracking_token=$2
           ORDER BY zc.chofer_id ASC
           LIMIT 1`,
          [pedido_id, token]
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
      const token = String(req.query.token || req.query.t || '').trim();
      if (!id) return res.status(400).json({ error: 'id requerido' });
      if (!token) {
        return res.status(410).json({
          error: 'Endpoint legacy protegido',
          tracking_required: true,
        });
      }

      const base = await query(
        `SELECT p.id, p.estado, p.fecha, p.empresa_id, p.tracking_token,
                pe.cliente, pe.direccion, pe.latitud, pe.longitud, p.monto
         FROM pedidos p
         JOIN puntos_entrega pe
           ON pe.id = p.punto_entrega_id
          AND pe.empresa_id = p.empresa_id
         WHERE p.id=$1 AND p.tracking_token=$2`,
        [id, token]
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
      const trackingToken = row.tracking_token;
      const monto = Number(row.monto || 0) || Math.round(totalCalc * 100) / 100;
      return res.json({
        id: row.id,
        estado: row.estado,
        fecha: row.fecha,
        cliente: row.cliente,
        direccion: row.direccion,
        latitud: row.latitud,
        longitud: row.longitud,
        monto,
        tracking_token: trackingToken,
        tracking_url: trackingToken ? `/pedidos/seguimiento.html?t=${encodeURIComponent(trackingToken)}` : null,
      });
    } catch {
      return res.status(500).json({ error: 'No se pudo obtener el estado del pedido' });
    }
  });

  router.get('/push/vapid-key', (_req, res) => {
    res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
  });

  router.post('/push/subscribe', async (req, res) => {
    try {
      const rl = checkRateLimit(req);
      res.set('x-ratelimit-limit', String(PUSH_RATE_LIMIT_MAX));
      res.set('x-ratelimit-remaining', String(rl.remaining));
      res.set('x-ratelimit-reset', String(Math.ceil(rl.resetAt / 1000)));
      if (!rl.allowed) return res.status(429).json({ error: 'Demasiadas solicitudes' });

      const parsed = pushSubscribeSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: 'payload inválido',
          details: parsed.error.issues.slice(0, 3).map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }

      const body = parsed.data;
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
      if (!p256dh || !auth) {
        return res.status(400).json({ error: 'payload inválido', details: [{ path: 'keys', message: 'p256dh y auth requeridos' }] });
      }
      const empresa_id = Number(body.empresa_id) || null;
      const pedido_id = Number(body.pedido_id) || null;
      const tracking_token = String(body.tracking_token || '').trim() || null;
      const requestedMap = new Map();
      for (const item of body.pedidos || []) {
        requestedMap.set(Number(item.pedido_id), String(item.tracking_token || '').trim());
      }
      if (pedido_id) requestedMap.set(pedido_id, tracking_token);
      const requestedPedidos = [...requestedMap.entries()].map(([id, token]) => ({ id, token }));

      if (requestedPedidos.length && (!empresa_id || requestedPedidos.some((item) => !item.token))) {
        return res.status(403).json({ error: 'tracking token requerido' });
      }

      const pedidoIds = requestedPedidos.map((item) => item.id);
      const trackingTokens = requestedPedidos.map((item) => item.token);
      const linked = await runInTransaction(async (txQuery) => {
        if (pedidoIds.length) {
          const ownedPedidos = await txQuery(
            `SELECT p.id
               FROM pedidos p
               JOIN unnest($2::bigint[], $3::text[]) AS requested(pedido_id, tracking_token)
                 ON p.id = requested.pedido_id
                AND p.tracking_token = requested.tracking_token
              WHERE p.empresa_id = $1
              FOR SHARE OF p`,
            [empresa_id, pedidoIds, trackingTokens]
          );
          if (ownedPedidos.length !== pedidoIds.length) return null;
        }

        const rows = await txQuery(
          `WITH upserted AS (
             INSERT INTO push_subs (endpoint, p256dh, auth, empresa_id, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT(endpoint) DO UPDATE SET
               p256dh = EXCLUDED.p256dh,
               auth = EXCLUDED.auth,
               empresa_id = EXCLUDED.empresa_id
             RETURNING id
           ), cleared AS (
             DELETE FROM push_sub_pedidos links
             USING upserted
             WHERE links.sub_id = upserted.id
             RETURNING links.sub_id
           ), linked AS (
             INSERT INTO push_sub_pedidos (sub_id, pedido_id)
             SELECT upserted.id, requested.pedido_id
               FROM upserted
               CROSS JOIN (SELECT COUNT(*) FROM cleared) AS clear_done
               CROSS JOIN unnest($5::bigint[]) AS requested(pedido_id)
             ON CONFLICT DO NOTHING
             RETURNING sub_id
           )
           SELECT COUNT(*)::int AS linked_count FROM linked`,
          [endpoint, p256dh, auth, empresa_id, pedidoIds]
        );
        return Number(rows[0]?.linked_count || 0);
      });

      if (linked === null) return res.status(403).json({ error: 'tracking token inválido' });
      return res.json({ ok: true, linked });
    } catch (e) {
      console.error('PUSH.SUBSCRIBE ERROR:', e);
      return res.status(500).json({ error: 'No se pudo guardar la suscripción' });
    }
  });

  router.post('/push/unsubscribe', async (req, res) => {
    try {
      const rl = checkRateLimit(req);
      res.set('x-ratelimit-limit', String(PUSH_RATE_LIMIT_MAX));
      res.set('x-ratelimit-remaining', String(rl.remaining));
      res.set('x-ratelimit-reset', String(Math.ceil(rl.resetAt / 1000)));
      if (!rl.allowed) return res.status(429).json({ error: 'Demasiadas solicitudes' });

      const parsed = pushUnsubscribeSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: 'payload inválido',
          details: parsed.error.issues.slice(0, 3).map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }

      const body = parsed.data;
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
