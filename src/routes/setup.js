// src/routes/setup.js
// Onboarding / configuración inicial (extraído desde server.js)

import express from 'express';

const CATALOG_TEMPLATES = {
  distribuidora_b2b: [
    { sku: 'B2B-LIMP-5L', nombre: 'Detergente Industrial 5L', precio: 12500, categoria: 'Limpieza', unidad_medida: 'unidad', descripcion: 'Bidón 5 litros para uso profesional.' },
    { sku: 'B2B-ROL-8', nombre: 'Rollo Industrial x8', precio: 9800, categoria: 'Papel', unidad_medida: 'pack', descripcion: 'Pack x8 rollos industriales.' },
    { sku: 'B2B-GUANT-100', nombre: 'Guantes Nitrilo x100', precio: 15400, categoria: 'Descartables', unidad_medida: 'caja', descripcion: 'Caja x100 unidades.' },
  ],
  gastronomia: [
    { sku: 'GASTRO-COMBO-1', nombre: 'Combo Clásico', precio: 8900, categoria: 'Combos', unidad_medida: 'unidad', descripcion: 'Principal + guarnición + bebida.' },
    { sku: 'GASTRO-PIZZA-MUZ', nombre: 'Pizza Muzza', precio: 11200, categoria: 'Pizzas', unidad_medida: 'unidad', descripcion: 'Muzzarella tradicional 8 porciones.' },
    { sku: 'GASTRO-EMP-DOZ', nombre: 'Empanadas x12', precio: 15600, categoria: 'Empanadas', unidad_medida: 'docena', descripcion: 'Docena surtida.' },
  ],
  farmacia_barrio: [
    { sku: 'FARM-IBU-400', nombre: 'Ibuprofeno 400mg x10', precio: 4300, categoria: 'OTC', unidad_medida: 'unidad', descripcion: 'Analgésico/antitérmico de venta libre.' },
    { sku: 'FARM-ALC-GEL', nombre: 'Alcohol en Gel 250ml', precio: 3200, categoria: 'Higiene', unidad_medida: 'unidad', descripcion: 'Higiene de manos.' },
    { sku: 'FARM-SHAM-400', nombre: 'Shampoo 400ml', precio: 6700, categoria: 'Perfumería', unidad_medida: 'unidad', descripcion: 'Uso diario.' },
  ],
};

const VERTICAL_TEMPLATES = {
  distribuidora_b2b: {
    id: 'distribuidora_b2b',
    title: 'Distribuidora B2B',
    rubro: 'distribuidora_b2b',
    summary: 'Pedidos recurrentes, cuentas corrientes y reparto por zonas.',
    suggestedSteps: {
      1: true,
      2: true,
      3: true,
      7: true,
      vertical_setup: true,
    },
    checklist: [
      'Definir precios por volumen y mínimos de compra',
      'Configurar días de reparto por zona',
      'Activar seguimiento de cobranzas',
    ],
  },
  gastronomia: {
    id: 'gastronomia',
    title: 'Gastronomía Delivery',
    rubro: 'gastronomia',
    summary: 'Pedidos de alta rotación, ETA de entrega y picos horarios.',
    suggestedSteps: {
      1: true,
      2: true,
      3: true,
      4: true,
      5: true,
      vertical_setup: true,
    },
    checklist: [
      'Configurar combos y promos por franja horaria',
      'Definir cobertura y costo de envío por zona',
      'Revisar SLA de despacho por turno',
    ],
  },
  farmacia_barrio: {
    id: 'farmacia_barrio',
    title: 'Farmacia de Barrio',
    rubro: 'farmacia_barrio',
    summary: 'Recompra frecuente, urgencias y entregas de cercanía.',
    suggestedSteps: {
      1: true,
      2: true,
      3: true,
      7: true,
      vertical_setup: true,
    },
    checklist: [
      'Configurar categorías OTC e higiene',
      'Definir prioridad de pedidos urgentes',
      'Programar campañas de recompra 15/30 días',
    ],
  },
};

async function upsertCatalogTemplate({ query, empresaId, vertical, overwrite = false }) {
  const items = CATALOG_TEMPLATES[vertical] || [];
  if (!items.length) return { inserted: 0, updated: 0, skipped: 0, total: 0 };

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const it of items) {
    const sku = String(it.sku || '').trim();
    if (!sku) continue;

    const existing = await query(
      `SELECT id FROM productos
       WHERE empresa_id = $1
         AND lower(sku) = lower($2)
         AND deleted_at IS NULL
       LIMIT 1`,
      [empresaId, sku]
    );

    if (existing.length && !overwrite) {
      skipped += 1;
      continue;
    }

    if (existing.length && overwrite) {
      await query(
        `UPDATE productos
         SET nombre = $1,
             descripcion = $2,
             precio = $3,
             categoria = $4,
             unidad_medida = $5,
             activo = TRUE,
             mostrar_en_catalogo = TRUE,
             updated_at = NOW()
         WHERE id = $6`,
        [it.nombre, it.descripcion || null, Number(it.precio || 0), it.categoria || null, it.unidad_medida || 'unidad', existing[0].id]
      );
      updated += 1;
      continue;
    }

    await query(
      `INSERT INTO productos (
          empresa_id, nombre, descripcion, precio, categoria, unidad_medida,
          activo, mostrar_en_catalogo, mostrar_en_landing, sku
       ) VALUES ($1,$2,$3,$4,$5,$6,TRUE,TRUE,TRUE,$7)`,
      [empresaId, it.nombre, it.descripcion || null, Number(it.precio || 0), it.categoria || null, it.unidad_medida || 'unidad', sku]
    );
    inserted += 1;
  }

  return { inserted, updated, skipped, total: items.length };
}

export function createSetupRouter(deps) {
  const { query, withAuth, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createSetupRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createSetupRouter: falta withAuth(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createSetupRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

  // GET /api/setup/progress
  router.get('/progress', withAuth, async (req, res) => {
    try {
      const empresaId = getEmpresaIdFromToken(req);
      const rows = await query('SELECT setup_steps FROM empresas WHERE id=$1', [empresaId]);

      let steps = {};
      if (rows.length && rows[0].setup_steps) {
        try {
          steps = JSON.parse(rows[0].setup_steps);
        } catch {
          steps = {};
        }
      }

      return res.json(steps);
    } catch {
      return res.status(500).json({ error: 'Error obteniendo progreso' });
    }
  });

  // POST /api/setup/step
  router.post('/step', withAuth, async (req, res) => {
    try {
      const { step, done } = req.body || {};
      const empresaId = getEmpresaIdFromToken(req);

      const rows = await query('SELECT setup_steps FROM empresas WHERE id=$1', [empresaId]);
      let steps = {};
      if (rows.length && rows[0].setup_steps) {
        try {
          steps = JSON.parse(rows[0].setup_steps);
        } catch {
          steps = {};
        }
      }

      steps[step] = !!done;

      await query('UPDATE empresas SET setup_steps=$1 WHERE id=$2', [JSON.stringify(steps), empresaId]);
      return res.json({ ok: true, steps });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error guardando paso' });
    }
  });

  // GET /api/setup/activation-kpis
  router.get('/activation-kpis', withAuth, async (req, res) => {
    try {
      const empresaId = getEmpresaIdFromToken(req);

      const [productosRow] = await query(
        `SELECT COUNT(*)::int AS c
         FROM productos
         WHERE empresa_id=$1 AND deleted_at IS NULL AND activo=TRUE`,
        [empresaId]
      );

      const [clientesRow] = await query(
        `SELECT COUNT(*)::int AS c
         FROM puntos_entrega
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [choferesRow] = await query(
        `SELECT COUNT(*)::int AS c
         FROM choferes
         WHERE empresa_id=$1 AND activo=TRUE`,
        [empresaId]
      );

      const [pedidosRow] = await query(
        `SELECT COUNT(*)::int AS c, COALESCE(SUM(monto),0)::numeric AS monto
         FROM pedidos
         WHERE empresa_id=$1 AND created_at >= NOW() - INTERVAL '7 days'`,
        [empresaId]
      );

      const [stepsRow] = await query('SELECT setup_steps FROM empresas WHERE id=$1', [empresaId]);
      let steps = {};
      if (stepsRow?.setup_steps) {
        try { steps = JSON.parse(stepsRow.setup_steps); } catch { steps = {}; }
      }

      const totalSteps = String(req?.user?.role || '').toLowerCase() === 'super' ? 10 : 9;
      let done = 0;
      for (let i = 1; i <= totalSteps; i += 1) {
        if (steps[i]) done += 1;
      }

      const setupCompletion = totalSteps ? Math.round((done / totalSteps) * 100) : 0;

      const kpis = {
        productos_activos: Number(productosRow?.c || 0),
        clientes: Number(clientesRow?.c || 0),
        choferes_activos: Number(choferesRow?.c || 0),
        pedidos_7d: Number(pedidosRow?.c || 0),
        facturacion_7d: Number(pedidosRow?.monto || 0),
        setup_completion: setupCompletion,
      };

      const suggestions = [];
      if (kpis.setup_completion < 100) {
        suggestions.push({
          level: 'high',
          code: 'setup_incomplete',
          text: 'Completá el setup inicial para desbloquear operación plena.',
          actionLabel: 'Abrir Configuración Inicial',
          actionPath: '/pedidos/inicio/inicial.html',
        });
      }
      if (kpis.productos_activos === 0) {
        suggestions.push({
          level: 'high',
          code: 'no_products',
          text: 'No hay productos activos. Cargá catálogo para empezar a vender.',
          actionLabel: 'Ir a Productos',
          actionPath: '/pedidos/inicio/producto.html',
        });
      }
      if (kpis.clientes === 0) {
        suggestions.push({
          level: 'high',
          code: 'no_clients',
          text: 'No hay clientes cargados. Importá clientes para activar ventas.',
          actionLabel: 'Ir a Clientes',
          actionPath: '/pedidos/inicio/clientes.html',
        });
      }
      if (kpis.choferes_activos === 0) {
        suggestions.push({
          level: 'medium',
          code: 'no_drivers',
          text: 'No hay choferes activos. Registrá al menos un chofer para despachar.',
          actionLabel: 'Ir a Choferes',
          actionPath: '/pedidos/inicio/choferes.html',
        });
      }
      if (kpis.pedidos_7d === 0) {
        suggestions.push({
          level: 'medium',
          code: 'no_orders_7d',
          text: 'No hubo pedidos en los últimos 7 días. Activá campañas o revisá canales.',
          actionLabel: 'Ir a Marketing',
          actionPath: '/pedidos/inicio/marketing.html',
        });
      }
      if (kpis.pedidos_7d > 0 && kpis.facturacion_7d <= 0) {
        suggestions.push({
          level: 'medium',
          code: 'no_revenue_7d',
          text: 'Hubo pedidos pero facturación 0. Revisá precios y métodos de cobro.',
          actionLabel: 'Ir a Costos',
          actionPath: '/pedidos/costos.html',
        });
      }

      return res.json({ ok: true, kpis, suggestions });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo KPIs de activación' });
    }
  });

  // GET /api/setup/vertical-templates
  router.get('/vertical-templates', withAuth, (_req, res) => {
    const items = Object.values(VERTICAL_TEMPLATES).map(v => ({
      id: v.id,
      title: v.title,
      rubro: v.rubro,
      summary: v.summary,
      checklist: v.checklist,
    }));
    return res.json({ items });
  });

  // POST /api/setup/apply-vertical
  router.post('/apply-vertical', withAuth, async (req, res) => {
    try {
      const empresaId = getEmpresaIdFromToken(req);
      const vertical = String(req.body?.vertical || '').trim();
      const tpl = VERTICAL_TEMPLATES[vertical];
      if (!tpl) return res.status(400).json({ error: 'Vertical inválida' });

      const rows = await query('SELECT setup_steps FROM empresas WHERE id=$1', [empresaId]);
      let steps = {};
      if (rows.length && rows[0].setup_steps) {
        try {
          steps = JSON.parse(rows[0].setup_steps);
        } catch {
          steps = {};
        }
      }

      const mergedSteps = { ...steps, ...tpl.suggestedSteps };

      await query(
        'UPDATE empresas SET rubro=$1, setup_steps=$2 WHERE id=$3',
        [tpl.rubro, JSON.stringify(mergedSteps), empresaId]
      );

      return res.json({
        ok: true,
        applied: {
          id: tpl.id,
          title: tpl.title,
          rubro: tpl.rubro,
          checklist: tpl.checklist,
        },
        steps: mergedSteps,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error aplicando vertical' });
    }
  });

  // POST /api/setup/seed-catalog
  router.post('/seed-catalog', withAuth, async (req, res) => {
    try {
      const empresaId = getEmpresaIdFromToken(req);
      const vertical = String(req.body?.vertical || '').trim();
      const overwrite = !!req.body?.overwrite;
      if (!CATALOG_TEMPLATES[vertical]) {
        return res.status(400).json({ error: 'Vertical inválida para catálogo' });
      }

      const summary = await upsertCatalogTemplate({ query, empresaId, vertical, overwrite });
      return res.json({ ok: true, vertical, summary });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error aplicando catálogo base' });
    }
  });

  // POST /api/setup/apply-vertical-full
  router.post('/apply-vertical-full', withAuth, async (req, res) => {
    try {
      const empresaId = getEmpresaIdFromToken(req);
      const vertical = String(req.body?.vertical || '').trim();
      const overwrite = !!req.body?.overwrite;
      const tpl = VERTICAL_TEMPLATES[vertical];
      if (!tpl) return res.status(400).json({ error: 'Vertical inválida' });

      const rows = await query('SELECT setup_steps FROM empresas WHERE id=$1', [empresaId]);
      let steps = {};
      if (rows.length && rows[0].setup_steps) {
        try { steps = JSON.parse(rows[0].setup_steps); } catch { steps = {}; }
      }

      const mergedSteps = { ...steps, ...tpl.suggestedSteps };
      await query('UPDATE empresas SET rubro=$1, setup_steps=$2 WHERE id=$3', [tpl.rubro, JSON.stringify(mergedSteps), empresaId]);
      const summary = await upsertCatalogTemplate({ query, empresaId, vertical, overwrite });

      return res.json({
        ok: true,
        applied: { id: tpl.id, title: tpl.title, rubro: tpl.rubro, checklist: tpl.checklist },
        steps: mergedSteps,
        catalog: summary,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error aplicando vertical completo' });
    }
  });

  return router;
}
