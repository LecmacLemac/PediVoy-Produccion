import crypto from 'node:crypto';
import express from 'express';
import QRCode from 'qrcode';

let schemaReady = false;

const CAMPAIGN_SELECT = `
  jc.id, jc.empresa_id, jc.slug, jc.nombre, jc.titulo_publico, jc.descripcion_publica,
  jc.tipo_juego, jc.estado, jc.participacion_limite, jc.max_participaciones,
  jc.max_ganadores, jc.codigo_prefijo, jc.whatsapp_mensaje, jc.bases_condiciones,
  jc.valid_from, jc.valid_to, jc.created_at, jc.updated_at,
  e.nombre AS empresa_nombre
`;

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  if (digits.length < 8 || digits.length > 18) return null;
  return digits;
}

function normalizeSlug(raw, fallback = 'campania') {
  const base = String(raw || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || fallback;
}

function toNullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function publicCampaignUrl(req, campaign) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'pedivoy.com';
  const base = `${proto}://${host}`.replace(/\/+$/, '');
  return `${base}/pedidos/juegos/?empresa_id=${encodeURIComponent(campaign.empresa_id)}&campania=${encodeURIComponent(campaign.slug)}`;
}

function resultIsWinner(type) {
  return type && type !== 'sin_premio';
}

function randomCode(prefix = 'PV') {
  const token = crypto.randomBytes(5).toString('hex').toUpperCase();
  const cleanPrefix = String(prefix || 'PV').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8) || 'PV';
  return `${cleanPrefix}-${token}`;
}

function createTrackingToken() {
  return crypto.randomBytes(16).toString('hex');
}

function cleanText(value, max = 220) {
  const out = String(value || '').trim();
  return out ? out.slice(0, max) : null;
}

function renderWhatsappMessage(template, { campaign, prize, code }) {
  const fallback =
    'Felicitaciones! Ganaste {premio} en {campania}. Tu codigo es {codigo}. Presentalo para reclamar tu premio.';
  return String(template || fallback)
    .replaceAll('{premio}', prize?.nombre_publico || 'un premio')
    .replaceAll('{codigo}', code || '')
    .replaceAll('{campania}', campaign?.titulo_publico || campaign?.nombre || 'PediVoy');
}

function ipHash(req) {
  const raw = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function ensureSchema(query) {
  if (schemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS juegos_campanias (
      id SERIAL PRIMARY KEY,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      nombre TEXT NOT NULL,
      titulo_publico TEXT NOT NULL,
      descripcion_publica TEXT,
      tipo_juego TEXT NOT NULL DEFAULT 'raspadita',
      estado TEXT NOT NULL DEFAULT 'borrador',
      participacion_limite TEXT NOT NULL DEFAULT 'once',
      max_participaciones INTEGER,
      max_ganadores INTEGER,
      codigo_prefijo TEXT DEFAULT 'PV',
      whatsapp_mensaje TEXT,
      bases_condiciones TEXT,
      valid_from TIMESTAMPTZ,
      valid_to TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (empresa_id, slug)
    );

    CREATE TABLE IF NOT EXISTS juegos_premios (
      id SERIAL PRIMARY KEY,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      campania_id INTEGER NOT NULL REFERENCES juegos_campanias(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,
      producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
      nombre_publico TEXT NOT NULL,
      descripcion TEXT,
      valor NUMERIC(12,2),
      probabilidad INTEGER NOT NULL DEFAULT 1,
      stock_total INTEGER,
      stock_diario INTEGER,
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      orden INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS juegos_participaciones (
      id SERIAL PRIMARY KEY,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      campania_id INTEGER NOT NULL REFERENCES juegos_campanias(id) ON DELETE CASCADE,
      premio_id INTEGER REFERENCES juegos_premios(id) ON DELETE SET NULL,
      producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
      telefono TEXT NOT NULL,
      telefono_norm TEXT NOT NULL,
      punto_entrega_id INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
      pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
      codigo TEXT,
      resultado_tipo TEXT NOT NULL,
      resultado_nombre TEXT NOT NULL,
      ip_hash TEXT,
      user_agent TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      enviado_whatsapp_at TIMESTAMPTZ,
      redimido_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS juegos_campanias_empresa_estado_idx
      ON juegos_campanias (empresa_id, estado, valid_from, valid_to);
    CREATE INDEX IF NOT EXISTS juegos_premios_campania_idx
      ON juegos_premios (campania_id, activo, orden);
    CREATE INDEX IF NOT EXISTS juegos_participaciones_campania_tel_idx
      ON juegos_participaciones (campania_id, telefono_norm, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS juegos_participaciones_codigo_uniq
      ON juegos_participaciones (codigo)
      WHERE codigo IS NOT NULL;

    ALTER TABLE juegos_participaciones
      ADD COLUMN IF NOT EXISTS punto_entrega_id INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL;
  `);
  schemaReady = true;
}

function createJsonError(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, ...extra });
}

export function createJuegosRouter(deps) {
  const { query, pool, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createJuegosRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createJuegosRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createJuegosRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createJuegosRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

  function resolveEmpresa(req) {
    const superAdmin = isSuper(req);
    let empresaId = getEmpresaIdFromToken(req);
    if (superAdmin && req.query?.empresa_id) empresaId = Number(req.query.empresa_id);
    if (superAdmin && req.body?.empresa_id) empresaId = Number(req.body.empresa_id);
    return { superAdmin, empresaId: Number(empresaId || 0) || null };
  }

  async function withTransaction(fn) {
    if (!pool?.connect) return fn(query);
    const client = await pool.connect();
    const q = async (sql, params = []) => {
      const result = await client.query(sql, params);
      return result.rows;
    };
    try {
      await client.query('BEGIN');
      const out = await fn(q);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function replacePrizes(q, empresaId, campaignId, prizes = []) {
    await q('DELETE FROM juegos_premios WHERE empresa_id = $1 AND campania_id = $2', [empresaId, campaignId]);
    for (const raw of prizes) {
      const tipo = String(raw.tipo || '').trim() || 'sin_premio';
      const productoId = tipo === 'producto_gratis' ? toNullableNumber(raw.producto_id) : null;
      const probabilidad = Math.max(0, Number(raw.probabilidad || 0));
      const nombre = String(raw.nombre_publico || '').trim();
      if (!nombre || probabilidad <= 0) continue;

      if (productoId) {
        const [product] = await q(
          `SELECT id FROM productos WHERE id = $1 AND empresa_id = $2 AND deleted_at IS NULL LIMIT 1`,
          [productoId, empresaId]
        );
        if (!product) throw new Error(`Producto premio invalido: ${productoId}`);
      }

      await q(
        `INSERT INTO juegos_premios (
           empresa_id, campania_id, tipo, producto_id, nombre_publico, descripcion,
           valor, probabilidad, stock_total, stock_diario, activo, orden
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          empresaId,
          campaignId,
          tipo,
          productoId,
          nombre,
          raw.descripcion ? String(raw.descripcion) : null,
          toNullableNumber(raw.valor),
          probabilidad,
          toNullableNumber(raw.stock_total),
          toNullableNumber(raw.stock_diario),
          raw.activo !== false,
          Number(raw.orden || 0),
        ]
      );
    }
  }

  router.get('/campanias', withAuth, async (req, res) => {
    try {
      await ensureSchema(query);
      const { empresaId } = resolveEmpresa(req);
      if (!empresaId) return createJsonError(res, 400, 'Falta empresa.');
      const rows = await query(
        `SELECT ${CAMPAIGN_SELECT},
                COALESCE(stats.participaciones, 0)::int AS participaciones,
                COALESCE(stats.ganadores, 0)::int AS ganadores
           FROM juegos_campanias jc
           JOIN empresas e ON e.id = jc.empresa_id
           LEFT JOIN (
             SELECT campania_id,
                    COUNT(*)::int AS participaciones,
                    COUNT(*) FILTER (WHERE resultado_tipo <> 'sin_premio')::int AS ganadores
               FROM juegos_participaciones
              WHERE empresa_id = $1
              GROUP BY campania_id
           ) stats ON stats.campania_id = jc.id
          WHERE jc.empresa_id = $1
          ORDER BY jc.updated_at DESC, jc.id DESC`,
        [empresaId]
      );
      return res.json({ items: rows.map((r) => ({ ...r, public_url: publicCampaignUrl(req, r) })) });
    } catch (e) {
      console.error(e);
      return createJsonError(res, 500, 'Error listando juegos.');
    }
  });

  router.get('/campanias/:id', withAuth, async (req, res) => {
    try {
      await ensureSchema(query);
      const { empresaId } = resolveEmpresa(req);
      if (!empresaId) return createJsonError(res, 400, 'Falta empresa.');
      const [campaign] = await query(
        `SELECT ${CAMPAIGN_SELECT}
           FROM juegos_campanias jc
           JOIN empresas e ON e.id = jc.empresa_id
          WHERE jc.id = $1 AND jc.empresa_id = $2`,
        [req.params.id, empresaId]
      );
      if (!campaign) return createJsonError(res, 404, 'Campania no encontrada.');
      const prizes = await query(
        `SELECT jp.*, p.nombre AS producto_nombre
           FROM juegos_premios jp
           LEFT JOIN productos p ON p.id = jp.producto_id AND p.empresa_id = jp.empresa_id
          WHERE jp.campania_id = $1 AND jp.empresa_id = $2
          ORDER BY jp.orden ASC, jp.id ASC`,
        [campaign.id, empresaId]
      );
      return res.json({ ...campaign, public_url: publicCampaignUrl(req, campaign), premios: prizes });
    } catch (e) {
      console.error(e);
      return createJsonError(res, 500, 'Error leyendo juego.');
    }
  });

  router.post('/campanias', withAuth, async (req, res) => {
    try {
      await ensureSchema(query);
      const { empresaId } = resolveEmpresa(req);
      if (!empresaId) return createJsonError(res, 400, 'Falta empresa.');
      const b = req.body || {};
      const nombre = String(b.nombre || '').trim();
      if (!nombre) return createJsonError(res, 400, 'Falta nombre.');
      const slug = normalizeSlug(b.slug || nombre);
      const premios = Array.isArray(b.premios) ? b.premios : [];
      if (!premios.some((p) => p?.activo !== false && Number(p?.probabilidad || 0) > 0)) {
        return createJsonError(res, 400, 'Agrega al menos un premio o resultado activo.');
      }

      const campaign = await withTransaction(async (q) => {
        const [created] = await q(
          `INSERT INTO juegos_campanias (
             empresa_id, slug, nombre, titulo_publico, descripcion_publica, tipo_juego,
             estado, participacion_limite, max_participaciones, max_ganadores,
             codigo_prefijo, whatsapp_mensaje, bases_condiciones, valid_from, valid_to,
             updated_at
           )
           VALUES ($1,$2,$3,$4,$5,'raspadita',$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
           RETURNING *`,
          [
            empresaId,
            slug,
            nombre,
            String(b.titulo_publico || nombre).trim(),
            b.descripcion_publica ? String(b.descripcion_publica) : null,
            ['activa', 'pausada', 'borrador'].includes(String(b.estado)) ? String(b.estado) : 'borrador',
            ['daily', 'once'].includes(String(b.participacion_limite)) ? String(b.participacion_limite) : 'once',
            toNullableNumber(b.max_participaciones),
            toNullableNumber(b.max_ganadores),
            b.codigo_prefijo ? String(b.codigo_prefijo).trim().toUpperCase() : 'PV',
            b.whatsapp_mensaje ? String(b.whatsapp_mensaje) : null,
            b.bases_condiciones ? String(b.bases_condiciones) : null,
            b.valid_from || null,
            b.valid_to || null,
          ]
        );
        await replacePrizes(q, empresaId, created.id, premios);
        return created;
      });

      return res.json({ ok: true, id: campaign.id, slug: campaign.slug, public_url: publicCampaignUrl(req, campaign) });
    } catch (e) {
      if (e?.code === '23505') return createJsonError(res, 409, 'Ya existe una campania con ese slug para esta empresa.');
      console.error(e);
      return createJsonError(res, 500, e.message || 'Error creando juego.');
    }
  });

  router.put('/campanias/:id', withAuth, async (req, res) => {
    try {
      await ensureSchema(query);
      const { empresaId } = resolveEmpresa(req);
      if (!empresaId) return createJsonError(res, 400, 'Falta empresa.');
      const b = req.body || {};
      const nombre = String(b.nombre || '').trim();
      if (!nombre) return createJsonError(res, 400, 'Falta nombre.');
      const slug = normalizeSlug(b.slug || nombre);
      const premios = Array.isArray(b.premios) ? b.premios : [];
      if (!premios.some((p) => p?.activo !== false && Number(p?.probabilidad || 0) > 0)) {
        return createJsonError(res, 400, 'Agrega al menos un premio o resultado activo.');
      }

      const campaign = await withTransaction(async (q) => {
        const [updated] = await q(
          `UPDATE juegos_campanias
              SET slug = $1,
                  nombre = $2,
                  titulo_publico = $3,
                  descripcion_publica = $4,
                  estado = $5,
                  participacion_limite = $6,
                  max_participaciones = $7,
                  max_ganadores = $8,
                  codigo_prefijo = $9,
                  whatsapp_mensaje = $10,
                  bases_condiciones = $11,
                  valid_from = $12,
                  valid_to = $13,
                  updated_at = NOW()
            WHERE id = $14 AND empresa_id = $15
            RETURNING *`,
          [
            slug,
            nombre,
            String(b.titulo_publico || nombre).trim(),
            b.descripcion_publica ? String(b.descripcion_publica) : null,
            ['activa', 'pausada', 'borrador'].includes(String(b.estado)) ? String(b.estado) : 'borrador',
            ['daily', 'once'].includes(String(b.participacion_limite)) ? String(b.participacion_limite) : 'once',
            toNullableNumber(b.max_participaciones),
            toNullableNumber(b.max_ganadores),
            b.codigo_prefijo ? String(b.codigo_prefijo).trim().toUpperCase() : 'PV',
            b.whatsapp_mensaje ? String(b.whatsapp_mensaje) : null,
            b.bases_condiciones ? String(b.bases_condiciones) : null,
            b.valid_from || null,
            b.valid_to || null,
            req.params.id,
            empresaId,
          ]
        );
        if (!updated) return null;
        await replacePrizes(q, empresaId, updated.id, premios);
        return updated;
      });

      if (!campaign) return createJsonError(res, 404, 'Campania no encontrada.');
      return res.json({ ok: true, id: campaign.id, slug: campaign.slug, public_url: publicCampaignUrl(req, campaign) });
    } catch (e) {
      if (e?.code === '23505') return createJsonError(res, 409, 'Ya existe una campania con ese slug para esta empresa.');
      console.error(e);
      return createJsonError(res, 500, e.message || 'Error actualizando juego.');
    }
  });

  router.get('/campanias/:id/qr', withAuth, async (req, res) => {
    try {
      await ensureSchema(query);
      const { empresaId } = resolveEmpresa(req);
      if (!empresaId) return createJsonError(res, 400, 'Falta empresa.');
      const [campaign] = await query(
        `SELECT id, empresa_id, slug FROM juegos_campanias WHERE id = $1 AND empresa_id = $2`,
        [req.params.id, empresaId]
      );
      if (!campaign) return createJsonError(res, 404, 'Campania no encontrada.');
      const url = publicCampaignUrl(req, campaign);
      const data_url = await QRCode.toDataURL(url, { margin: 1, width: 420 });
      return res.json({ url, data_url });
    } catch (e) {
      console.error(e);
      return createJsonError(res, 500, 'Error generando QR.');
    }
  });

  router.get('/campanias/:id/participaciones', withAuth, async (req, res) => {
    try {
      await ensureSchema(query);
      const { empresaId } = resolveEmpresa(req);
      if (!empresaId) return createJsonError(res, 400, 'Falta empresa.');
      const rows = await query(
        `SELECT id, telefono, codigo, resultado_tipo, resultado_nombre, redimido_at, created_at
           FROM juegos_participaciones
          WHERE empresa_id = $1 AND campania_id = $2
          ORDER BY created_at DESC
          LIMIT 100`,
        [empresaId, req.params.id]
      );
      return res.json({ items: rows });
    } catch (e) {
      console.error(e);
      return createJsonError(res, 500, 'Error listando participaciones.');
    }
  });

  return router;
}

export function createJuegosPublicosRouter(deps) {
  const { query, pool } = deps || {};
  if (typeof query !== 'function') throw new Error('createJuegosPublicosRouter: falta query(fn)');

  const router = express.Router();

  async function withTransaction(fn) {
    if (!pool?.connect) return fn(query);
    const client = await pool.connect();
    const q = async (sql, params = []) => {
      const result = await client.query(sql, params);
      return result.rows;
    };
    try {
      await client.query('BEGIN');
      const out = await fn(q);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function loadCampaign(q, empresaId, slug) {
    const [campaign] = await q(
      `SELECT ${CAMPAIGN_SELECT}
         FROM juegos_campanias jc
         JOIN empresas e ON e.id = jc.empresa_id
        WHERE jc.empresa_id = $1 AND jc.slug = $2`,
      [empresaId, slug]
    );
    return campaign || null;
  }

  function campaignAvailability(campaign) {
    if (!campaign) return { ok: false, reason: 'Campania no encontrada.' };
    if (campaign.estado !== 'activa') return { ok: false, reason: 'La campania no esta activa.' };
    const now = Date.now();
    const fromMs = campaign.valid_from ? Date.parse(campaign.valid_from) : NaN;
    const toMs = campaign.valid_to ? Date.parse(campaign.valid_to) : NaN;
    if (Number.isFinite(fromMs) && now < fromMs) return { ok: false, reason: 'La campania todavia no empezo.' };
    if (Number.isFinite(toMs) && now > toMs) return { ok: false, reason: 'La campania ya finalizo.' };
    return { ok: true };
  }

  async function loadAvailablePrizes(q, campaign) {
    const prizes = await q(
      `SELECT jp.*, p.nombre AS producto_nombre
         FROM juegos_premios jp
         LEFT JOIN productos p ON p.id = jp.producto_id AND p.empresa_id = jp.empresa_id
        WHERE jp.empresa_id = $1
          AND jp.campania_id = $2
          AND jp.activo = TRUE
        ORDER BY jp.orden ASC, jp.id ASC`,
      [campaign.empresa_id, campaign.id]
    );

    const available = [];
    for (const prize of prizes) {
      if (Number(prize.probabilidad || 0) <= 0) continue;
      if (prize.tipo === 'producto_gratis' && !prize.producto_id) continue;

      const totalStock = Number(prize.stock_total || 0);
      if (totalStock > 0) {
        const [used] = await q(
          `SELECT COUNT(*)::int AS c
             FROM juegos_participaciones
            WHERE empresa_id = $1 AND campania_id = $2 AND premio_id = $3`,
          [campaign.empresa_id, campaign.id, prize.id]
        );
        if (Number(used?.c || 0) >= totalStock) continue;
      }

      const dailyStock = Number(prize.stock_diario || 0);
      if (dailyStock > 0) {
        const [used] = await q(
          `SELECT COUNT(*)::int AS c
             FROM juegos_participaciones
            WHERE empresa_id = $1
              AND campania_id = $2
              AND premio_id = $3
              AND created_at >= DATE_TRUNC('day', NOW())`,
          [campaign.empresa_id, campaign.id, prize.id]
        );
        if (Number(used?.c || 0) >= dailyStock) continue;
      }

      available.push(prize);
    }

    if (!available.length) {
      available.push({
        id: null,
        tipo: 'sin_premio',
        producto_id: null,
        nombre_publico: 'Esta vez no hubo premio',
        descripcion: 'Segui atento a nuevas promociones.',
        probabilidad: 1,
      });
    }

    return available;
  }

  function pickPrize(prizes) {
    const total = prizes.reduce((acc, p) => acc + Math.max(0, Number(p.probabilidad || 0)), 0);
    if (total <= 0) return prizes[0];
    let hit = Math.random() * total;
    for (const prize of prizes) {
      hit -= Math.max(0, Number(prize.probabilidad || 0));
      if (hit <= 0) return prize;
    }
    return prizes[prizes.length - 1];
  }

  router.get('/campania', async (req, res) => {
    try {
      await ensureSchema(query);
      const empresaId = Number(req.query?.empresa_id || 0);
      const slug = normalizeSlug(req.query?.campania || req.query?.slug || '');
      if (!empresaId || !slug) return createJsonError(res, 400, 'Faltan datos de campania.');
      const campaign = await loadCampaign(query, empresaId, slug);
      if (!campaign) return createJsonError(res, 404, 'Campania no encontrada.');
      const prizes = await query(
        `SELECT tipo, nombre_publico, descripcion, valor, producto_id
           FROM juegos_premios
          WHERE empresa_id = $1 AND campania_id = $2 AND activo = TRUE
          ORDER BY orden ASC, id ASC`,
        [empresaId, campaign.id]
      );
      return res.json({
        id: campaign.id,
        empresa_id: campaign.empresa_id,
        empresa_nombre: campaign.empresa_nombre,
        slug: campaign.slug,
        titulo_publico: campaign.titulo_publico,
        descripcion_publica: campaign.descripcion_publica,
        estado: campaign.estado,
        disponible: campaignAvailability(campaign),
        participacion_limite: campaign.participacion_limite,
        bases_condiciones: campaign.bases_condiciones,
        premios: prizes.map((p) => ({
          tipo: p.tipo,
          nombre_publico: p.nombre_publico,
          descripcion: p.descripcion,
          valor: p.valor,
          producto_id: p.producto_id,
        })),
      });
    } catch (e) {
      console.error(e);
      return createJsonError(res, 500, 'Error cargando campania.');
    }
  });

  router.post('/participar', async (req, res) => {
    try {
      await ensureSchema(query);
      const empresaId = Number(req.body?.empresa_id || 0);
      const slug = normalizeSlug(req.body?.campania || req.body?.slug || '');
      const telefono = String(req.body?.telefono || '').trim();
      const telefonoNorm = normalizePhone(telefono);
      if (!empresaId || !slug || !telefonoNorm) return createJsonError(res, 400, 'Telefono o campania invalida.');

      const result = await withTransaction(async (q) => {
        const campaign = await loadCampaign(q, empresaId, slug);
        const availability = campaignAvailability(campaign);
        if (!availability.ok) return { status: 409, payload: { error: availability.reason } };

        await q('SELECT pg_advisory_xact_lock(hashtext($1))', [`juego:${empresaId}:${campaign.id}:${telefonoNorm}`]);

        if (Number(campaign.max_participaciones || 0) > 0) {
          const [total] = await q(
            `SELECT COUNT(*)::int AS c FROM juegos_participaciones WHERE empresa_id = $1 AND campania_id = $2`,
            [empresaId, campaign.id]
          );
          if (Number(total?.c || 0) >= Number(campaign.max_participaciones)) {
            return { status: 409, payload: { error: 'La campania ya alcanzo el limite de participaciones.' } };
          }
        }

        if (Number(campaign.max_ganadores || 0) > 0) {
          const [winners] = await q(
            `SELECT COUNT(*)::int AS c
               FROM juegos_participaciones
              WHERE empresa_id = $1 AND campania_id = $2 AND resultado_tipo <> 'sin_premio'`,
            [empresaId, campaign.id]
          );
          if (Number(winners?.c || 0) >= Number(campaign.max_ganadores)) {
            return { status: 409, payload: { error: 'La campania ya entrego todos los premios disponibles.' } };
          }
        }

        const alreadySql = campaign.participacion_limite === 'daily'
          ? `SELECT id, created_at
               FROM juegos_participaciones
              WHERE empresa_id = $1 AND campania_id = $2 AND telefono_norm = $3
                AND created_at >= DATE_TRUNC('day', NOW())
              LIMIT 1`
          : `SELECT id, created_at
               FROM juegos_participaciones
              WHERE empresa_id = $1 AND campania_id = $2 AND telefono_norm = $3
              LIMIT 1`;
        const already = await q(alreadySql, [empresaId, campaign.id, telefonoNorm]);
        if (already.length) {
          return {
            status: 409,
            payload: {
              already: true,
              error: campaign.participacion_limite === 'daily'
                ? 'Ese telefono ya participo hoy.'
                : 'Ese telefono ya participo en esta campania.',
            },
          };
        }

        const prizes = await loadAvailablePrizes(q, campaign);
        const prize = pickPrize(prizes);
        const winner = resultIsWinner(prize.tipo);
        const code = winner ? randomCode(campaign.codigo_prefijo) : null;

        const [participation] = await q(
          `INSERT INTO juegos_participaciones (
             empresa_id, campania_id, premio_id, producto_id, telefono, telefono_norm,
             codigo, resultado_tipo, resultado_nombre, ip_hash, user_agent, metadata
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id, codigo, resultado_tipo, resultado_nombre, created_at`,
          [
            empresaId,
            campaign.id,
            prize.id || null,
            prize.producto_id || null,
            telefono,
            telefonoNorm,
            code,
            prize.tipo,
            prize.nombre_publico,
            ipHash(req),
            String(req.headers['user-agent'] || '').slice(0, 300) || null,
            { source: 'raspadita_publica' },
          ]
        );

        if (winner && code) {
          const message = renderWhatsappMessage(campaign.whatsapp_mensaje, { campaign, prize, code });
          await q(
            `INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, created_at)
             VALUES ($1, $2, $3, 'pending', NOW())`,
            [empresaId, telefonoNorm, message]
          );
          await q(
            `UPDATE juegos_participaciones SET enviado_whatsapp_at = NOW() WHERE id = $1`,
            [participation.id]
          );
        }

        return {
          status: 200,
          payload: {
            ok: true,
            ganador: winner,
            codigo: code,
            resultado_tipo: prize.tipo,
            resultado_nombre: prize.nombre_publico,
            descripcion: prize.descripcion,
          },
        };
      });

      return res.status(result.status).json(result.payload);
    } catch (e) {
      if (e?.code === '23505') return createJsonError(res, 409, 'No se pudo generar el codigo. Intenta nuevamente.');
      console.error(e);
      return createJsonError(res, 500, 'Error registrando participacion.');
    }
  });

  router.post('/premio-entrega', async (req, res) => {
    try {
      await ensureSchema(query);
      const empresaId = Number(req.body?.empresa_id || 0);
      const slug = normalizeSlug(req.body?.campania || req.body?.slug || '');
      const codigo = String(req.body?.codigo || '').trim().toUpperCase();
      const telefono = String(req.body?.telefono || '').trim();
      const telefonoNorm = normalizePhone(telefono);
      const cliente = cleanText(req.body?.nombre || req.body?.cliente, 160);
      const direccion = cleanText(req.body?.direccion, 220);
      const ciudad = cleanText(req.body?.ciudad, 120);
      const provincia = cleanText(req.body?.provincia, 120);
      const notas = cleanText(req.body?.notas || req.body?.referencia, 300);

      if (!empresaId || !slug || !codigo || !telefonoNorm) {
        return createJsonError(res, 400, 'Faltan datos del premio.');
      }
      if (!cliente || !direccion) {
        return createJsonError(res, 400, 'Nombre y direccion son requeridos.');
      }

      const result = await withTransaction(async (q) => {
        const campaign = await loadCampaign(q, empresaId, slug);
        if (!campaign) return { status: 404, payload: { error: 'Campania no encontrada.' } };

        const [participation] = await q(
          `SELECT id, empresa_id, campania_id, producto_id, telefono, telefono_norm,
                  codigo, resultado_tipo, resultado_nombre, pedido_id
             FROM juegos_participaciones
            WHERE empresa_id = $1
              AND campania_id = $2
              AND codigo = $3
              AND telefono_norm = $4
              AND resultado_tipo <> 'sin_premio'
            LIMIT 1
            FOR UPDATE`,
          [empresaId, campaign.id, codigo, telefonoNorm]
        );

        if (!participation) return { status: 404, payload: { error: 'Premio no encontrado para ese telefono.' } };
        if (participation.pedido_id) {
          return {
            status: 200,
            payload: {
              ok: true,
              already: true,
              pedido_id: participation.pedido_id,
              message: 'El premio ya tenia pedido generado.',
            },
          };
        }
        if (!participation.producto_id) return { status: 409, payload: { error: 'El premio no tiene producto asociado.' } };

        const [product] = await q(
          `SELECT id, nombre
             FROM productos
            WHERE id = $1
              AND empresa_id = $2
              AND deleted_at IS NULL
            LIMIT 1`,
          [participation.producto_id, empresaId]
        );
        if (!product) return { status: 409, payload: { error: 'Producto premio no disponible.' } };

        const [existingPoint] = await q(
          `SELECT id
             FROM puntos_entrega
            WHERE empresa_id = $1
              AND telefono_normalizado LIKE '%' || $2
              AND LOWER(TRIM(COALESCE(direccion, ''))) = LOWER(TRIM($3))
            ORDER BY id DESC
            LIMIT 1`,
          [empresaId, telefonoNorm, direccion]
        );

        let puntoEntregaId = existingPoint?.id || null;
        if (puntoEntregaId) {
          await q(
            `UPDATE puntos_entrega
                SET cliente = $1,
                    nombre = $1,
                    ciudad = COALESCE($2, ciudad),
                    provincia = COALESCE($3, provincia),
                    telefono = $4,
                    telefono_normalizado = $5,
                    notas = COALESCE($6, notas)
              WHERE id = $7 AND empresa_id = $8`,
            [cliente, ciudad, provincia, telefono, telefonoNorm, notas, puntoEntregaId, empresaId]
          );
        } else {
          const inserted = await q(
            `INSERT INTO puntos_entrega (
               empresa_id, cliente, nombre, direccion, ciudad, provincia,
               telefono, telefono_normalizado, notas
             )
             VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8)
             RETURNING id`,
            [empresaId, cliente, direccion, ciudad, provincia, telefono, telefonoNorm, notas]
          );
          puntoEntregaId = inserted[0].id;
        }

        const submissionId = `juego-${empresaId}-${participation.id}`;
        const pedidoRows = await q(
          `INSERT INTO pedidos (
             empresa_id, punto_entrega_id, fecha, estado,
             cantidad, cantidad_entregada, monto, metodo_pago,
             aviso_recibido, sats, submission_id, tracking_token, notas, origen
           )
           VALUES ($1,$2,NOW(),'pendiente',1,0,0,'premio',0,0,$3,$4,$5,'juego_raspadita')
           ON CONFLICT (empresa_id, submission_id) WHERE submission_id IS NOT NULL
           DO UPDATE SET punto_entrega_id = EXCLUDED.punto_entrega_id
           RETURNING id, estado, tracking_token`,
          [
            empresaId,
            puntoEntregaId,
            submissionId,
            createTrackingToken(),
            `Premio raspadita ${campaign.titulo_publico || campaign.nombre}. Codigo ${codigo}.`,
          ]
        );
        const pedido = pedidoRows[0];

        await q(
          `INSERT INTO items_pedido (pedido_id, producto, producto_id, cantidad, precio_unitario)
           VALUES ($1,$2,$3,1,0)`,
          [pedido.id, product.nombre, product.id]
        );

        await q(
          `UPDATE juegos_participaciones
              SET punto_entrega_id = $1,
                  pedido_id = $2,
                  metadata = metadata || $3::jsonb
            WHERE id = $4`,
          [
            puntoEntregaId,
            pedido.id,
            JSON.stringify({
              entrega: {
                nombre: cliente,
                direccion,
                ciudad,
                provincia,
                notas,
                confirmed_at: new Date().toISOString(),
              },
            }),
            participation.id,
          ]
        );

        return {
          status: 200,
          payload: {
            ok: true,
            pedido_id: pedido.id,
            punto_entrega_id: puntoEntregaId,
            tracking_token: pedido.tracking_token,
          },
        };
      });

      return res.status(result.status).json(result.payload);
    } catch (e) {
      console.error(e);
      return createJsonError(res, 500, 'Error generando pedido del premio.');
    }
  });

  return router;
}
