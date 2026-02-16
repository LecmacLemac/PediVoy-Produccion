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

  const resolveEmpresaIdForSetup = (req, { fromBody = false } = {}) => {
    const role = String(req?.user?.role || '').toLowerCase();
    const ownEmpresaId = Number(getEmpresaIdFromToken(req));

    if (role === 'super') {
      const raw = fromBody ? req?.body?.empresa_id : req?.query?.empresa_id;
      const eid = Number(raw);
      if (Number.isFinite(eid) && eid > 0) return eid;
      return null;
    }

    return Number.isFinite(ownEmpresaId) && ownEmpresaId > 0 ? ownEmpresaId : null;
  };

  // GET /api/setup/progress
  router.get('/progress', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
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
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

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
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

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
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
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
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
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
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
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

  // =========================
  // FASE 1: CRM + Cta Cte + Dashboard Unificado
  // =========================

  // GET /api/setup/fase1/dashboard
  router.get('/fase1/dashboard', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [ventas30] = await query(
        `SELECT COUNT(*)::int AS pedidos, COALESCE(SUM(monto),0)::numeric AS monto
         FROM pedidos
         WHERE empresa_id=$1 AND created_at >= NOW() - INTERVAL '30 days'`,
        [empresaId]
      );

      const [cobranzas30] = await query(
        `SELECT COALESCE(SUM(monto),0)::numeric AS monto
         FROM transferencias
         WHERE empresa_id=$1
           AND created_at >= NOW() - INTERVAL '30 days'
           AND (tipo='cobro' OR tipo IS NULL)`,
        [empresaId]
      );

      const [saldoRow] = await query(
        `SELECT COALESCE(SUM(debe - haber),0)::numeric AS saldo
         FROM cliente_cta_corriente_mov
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [vencidoRow] = await query(
        `SELECT COUNT(*)::int AS c
         FROM cliente_cta_corriente_mov
         WHERE empresa_id=$1
           AND estado='pendiente'
           AND vencimiento IS NOT NULL
           AND vencimiento < NOW()
           AND (debe - haber) > 0`,
        [empresaId]
      );

      const [clientesRow] = await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE crm_riesgo IN ('alto','critico') OR crm_estado='en_riesgo')::int AS en_riesgo
         FROM puntos_entrega
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [pipelineRow] = await query(
        `SELECT COALESCE(SUM(monto_estimado),0)::numeric AS total,
                COALESCE(SUM(monto_estimado * (GREATEST(LEAST(probabilidad,100),0)::numeric/100.0)),0)::numeric AS ponderado,
                COUNT(*)::int AS oportunidades
         FROM crm_oportunidades
         WHERE empresa_id=$1 AND estado='abierta'`,
        [empresaId]
      );

      const serie = await query(
        `SELECT TO_CHAR(date_trunc('month', d), 'YYYY-MM') AS mes,
                COALESCE(SUM(p.monto),0)::numeric AS facturacion,
                COALESCE((
                  SELECT SUM(t.monto)
                  FROM transferencias t
                  WHERE t.empresa_id=$1
                    AND date_trunc('month', t.created_at)=date_trunc('month', d)
                    AND (t.tipo='cobro' OR t.tipo IS NULL)
                ),0)::numeric AS cobranzas
         FROM generate_series(date_trunc('month', NOW()) - INTERVAL '5 months', date_trunc('month', NOW()), INTERVAL '1 month') d
         LEFT JOIN pedidos p
           ON p.empresa_id=$1 AND date_trunc('month', p.created_at)=date_trunc('month', d)
         GROUP BY 1
         ORDER BY 1`,
        [empresaId]
      );

      return res.json({
        ok: true,
        kpis: {
          ventas_30d: Number(ventas30?.monto || 0),
          pedidos_30d: Number(ventas30?.pedidos || 0),
          cobranzas_30d: Number(cobranzas30?.monto || 0),
          saldo_cta_corriente: Number(saldoRow?.saldo || 0),
          vencimientos_pendientes: Number(vencidoRow?.c || 0),
          clientes_total: Number(clientesRow?.total || 0),
          clientes_en_riesgo: Number(clientesRow?.en_riesgo || 0),
          pipeline_abierto: Number(pipelineRow?.total || 0),
          pipeline_ponderado: Number(pipelineRow?.ponderado || 0),
          oportunidades_abiertas: Number(pipelineRow?.oportunidades || 0),
        },
        serie_mensual: serie.map((r) => ({
          mes: r.mes,
          facturacion: Number(r.facturacion || 0),
          cobranzas: Number(r.cobranzas || 0),
        })),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error construyendo dashboard fase 1' });
    }
  });

  // GET /api/setup/fase1/pipeline
  router.get('/fase1/pipeline', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const etapa = String(req.query?.etapa || '').trim();
      const estado = String(req.query?.estado || 'abierta').trim();
      const params = [empresaId];
      let where = 'WHERE o.empresa_id=$1';

      if (estado) {
        params.push(estado);
        where += ` AND o.estado=$${params.length}`;
      }
      if (etapa) {
        params.push(etapa);
        where += ` AND o.etapa=$${params.length}`;
      }

      const rows = await query(
        `SELECT o.*, c.cliente AS cliente_nombre
         FROM crm_oportunidades o
         LEFT JOIN puntos_entrega c ON c.id=o.cliente_id
         ${where}
         ORDER BY o.proxima_accion NULLS LAST, o.updated_at DESC
         LIMIT 500`,
        params
      );

      return res.json({ ok: true, items: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo pipeline' });
    }
  });

  // POST /api/setup/fase1/pipeline
  router.post('/fase1/pipeline', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const body = req.body || {};
      const nombre = String(body.nombre || '').trim();
      if (!nombre) return res.status(400).json({ error: 'nombre requerido' });

      const [row] = await query(
        `INSERT INTO crm_oportunidades (
          empresa_id, cliente_id, nombre, rubro, canal, etapa, probabilidad, monto_estimado,
          fecha_cierre_estimada, origen, proxima_accion, responsable_usuario_id, notas, estado
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'abierta')
        RETURNING *`,
        [
          empresaId,
          body.cliente_id ? Number(body.cliente_id) : null,
          nombre,
          body.rubro || null,
          body.canal || null,
          body.etapa || 'prospecto',
          Number(body.probabilidad || 20),
          Number(body.monto_estimado || 0),
          body.fecha_cierre_estimada || null,
          body.origen || null,
          body.proxima_accion || null,
          req?.user?.id ? Number(req.user.id) : null,
          body.notas || null,
        ]
      );

      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error creando oportunidad' });
    }
  });

  // PUT /api/setup/fase1/pipeline/:id
  router.put('/fase1/pipeline/:id', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

      const b = req.body || {};
      const [row] = await query(
        `UPDATE crm_oportunidades
         SET nombre=COALESCE($1,nombre),
             cliente_id=COALESCE($2,cliente_id),
             rubro=COALESCE($3,rubro),
             canal=COALESCE($4,canal),
             etapa=COALESCE($5,etapa),
             probabilidad=COALESCE($6,probabilidad),
             monto_estimado=COALESCE($7,monto_estimado),
             fecha_cierre_estimada=COALESCE($8,fecha_cierre_estimada),
             proxima_accion=COALESCE($9,proxima_accion),
             notas=COALESCE($10,notas),
             estado=COALESCE($11,estado),
             perdida_motivo=COALESCE($12,perdida_motivo),
             updated_at=NOW()
         WHERE id=$13 AND empresa_id=$14
         RETURNING *`,
        [
          b.nombre ?? null,
          b.cliente_id ? Number(b.cliente_id) : null,
          b.rubro ?? null,
          b.canal ?? null,
          b.etapa ?? null,
          b.probabilidad != null ? Number(b.probabilidad) : null,
          b.monto_estimado != null ? Number(b.monto_estimado) : null,
          b.fecha_cierre_estimada ?? null,
          b.proxima_accion ?? null,
          b.notas ?? null,
          b.estado ?? null,
          b.perdida_motivo ?? null,
          id,
          empresaId,
        ]
      );

      if (!row) return res.status(404).json({ error: 'Oportunidad no encontrada' });
      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error actualizando oportunidad' });
    }
  });

  // POST /api/setup/fase1/pipeline/:id/actividad
  router.post('/fase1/pipeline/:id/actividad', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

      const b = req.body || {};
      const [row] = await query(
        `INSERT INTO crm_oportunidad_actividades (
           empresa_id, oportunidad_id, tipo, descripcion, usuario_id, fecha_programada, completada
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          empresaId,
          id,
          b.tipo || 'nota',
          b.descripcion || null,
          req?.user?.id ? Number(req.user.id) : null,
          b.fecha_programada || null,
          !!b.completada,
        ]
      );

      await query(
        `UPDATE crm_oportunidades
         SET proxima_accion=COALESCE($1,proxima_accion), updated_at=NOW()
         WHERE id=$2 AND empresa_id=$3`,
        [b.fecha_programada || null, id, empresaId]
      );

      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error guardando actividad' });
    }
  });

  // GET /api/setup/fase1/cuentas-corrientes/resumen
  router.get('/fase1/cuentas-corrientes/resumen', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const q = String(req.query?.q || '').trim().toLowerCase();
      const params = [empresaId];
      let where = 'WHERE p.empresa_id=$1';
      if (q) {
        params.push(`%${q}%`);
        where += ` AND (LOWER(p.cliente) LIKE $${params.length} OR LOWER(COALESCE(p.telefono,'')) LIKE $${params.length})`;
      }

      const rows = await query(
        `SELECT p.id AS cliente_id,
                p.cliente,
                p.telefono,
                COALESCE(SUM(m.debe - m.haber),0)::numeric AS saldo,
                COUNT(*) FILTER (WHERE m.estado='pendiente' AND m.vencimiento < NOW() AND (m.debe-m.haber)>0)::int AS vencidos
         FROM puntos_entrega p
         LEFT JOIN cliente_cta_corriente_mov m
           ON m.cliente_id=p.id AND m.empresa_id=p.empresa_id
         ${where}
         GROUP BY p.id, p.cliente, p.telefono
         ORDER BY saldo DESC, p.cliente ASC
         LIMIT 500`,
        params
      );

      return res.json({ ok: true, items: rows.map((r) => ({
        ...r,
        saldo: Number(r.saldo || 0),
        vencidos: Number(r.vencidos || 0),
      })) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo cuentas corrientes' });
    }
  });

  // POST /api/setup/fase1/cuentas-corrientes/movimiento
  router.post('/fase1/cuentas-corrientes/movimiento', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const b = req.body || {};
      const clienteId = Number(b.cliente_id);
      if (!Number.isFinite(clienteId) || clienteId <= 0) {
        return res.status(400).json({ error: 'cliente_id inválido' });
      }

      const debe = Number(b.debe || 0);
      const haber = Number(b.haber || 0);
      if (debe <= 0 && haber <= 0) {
        return res.status(400).json({ error: 'debe o haber debe ser mayor a 0' });
      }

      const [row] = await query(
        `INSERT INTO cliente_cta_corriente_mov (
          empresa_id, cliente_id, pedido_id, tipo, concepto, debe, haber,
          fecha, vencimiento, estado, referencia, usuario_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *`,
        [
          empresaId,
          clienteId,
          b.pedido_id ? Number(b.pedido_id) : null,
          b.tipo || (debe > 0 ? 'cargo_manual' : 'cobro_manual'),
          b.concepto || null,
          debe,
          haber,
          b.fecha || new Date().toISOString(),
          b.vencimiento || null,
          b.estado || 'pendiente',
          b.referencia || null,
          req?.user?.id ? Number(req.user.id) : null,
        ]
      );

      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error guardando movimiento de cuenta corriente' });
    }
  });

  // GET /api/setup/fase1/cuentas-corrientes/aging
  router.get('/fase1/cuentas-corrientes/aging', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [row] = await query(
        `SELECT
            COALESCE(SUM(CASE WHEN vencimiento IS NULL OR NOW() <= vencimiento THEN (debe - haber) ELSE 0 END),0)::numeric AS al_dia,
            COALESCE(SUM(CASE WHEN NOW() > vencimiento AND NOW() <= vencimiento + INTERVAL '30 days' THEN (debe - haber) ELSE 0 END),0)::numeric AS d30,
            COALESCE(SUM(CASE WHEN NOW() > vencimiento + INTERVAL '30 days' AND NOW() <= vencimiento + INTERVAL '60 days' THEN (debe - haber) ELSE 0 END),0)::numeric AS d60,
            COALESCE(SUM(CASE WHEN NOW() > vencimiento + INTERVAL '60 days' THEN (debe - haber) ELSE 0 END),0)::numeric AS d90
         FROM cliente_cta_corriente_mov
         WHERE empresa_id=$1 AND estado='pendiente'`,
        [empresaId]
      );

      return res.json({
        ok: true,
        aging: {
          al_dia: Number(row?.al_dia || 0),
          d30: Number(row?.d30 || 0),
          d60: Number(row?.d60 || 0),
          d90: Number(row?.d90 || 0),
        },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo aging de cuentas corrientes' });
    }
  });

  // GET /api/setup/fase1/alertas
  router.get('/fase1/alertas', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const alertas = [];

      const [vencidos] = await query(
        `SELECT COUNT(*)::int AS c, COALESCE(SUM(debe - haber),0)::numeric AS monto
         FROM cliente_cta_corriente_mov
         WHERE empresa_id=$1 AND estado='pendiente' AND vencimiento < NOW() AND (debe - haber) > 0`,
        [empresaId]
      );
      if (Number(vencidos?.c || 0) > 0) {
        alertas.push({
          nivel: 'high',
          tipo: 'cobranzas_vencidas',
          texto: `Hay ${Number(vencidos.c)} movimientos vencidos por ${Number(vencidos.monto || 0).toFixed(2)}`,
        });
      }

      const stale = await query(
        `SELECT id, nombre, etapa, proxima_accion
         FROM crm_oportunidades
         WHERE empresa_id=$1 AND estado='abierta'
           AND (proxima_accion IS NULL OR proxima_accion < NOW() - INTERVAL '7 days')
         ORDER BY updated_at ASC
         LIMIT 10`,
        [empresaId]
      );

      stale.forEach((o) => {
        alertas.push({
          nivel: 'medium',
          tipo: 'oportunidad_sin_seguimiento',
          oportunidad_id: o.id,
          texto: `Oportunidad sin seguimiento: ${o.nombre} (${o.etapa || 'sin etapa'})`,
        });
      });

      return res.json({ ok: true, items: alertas });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo alertas' });
    }
  });

  // GET /api/setup/fase1/alertas-resumen
  // Devuelve un resumen textual listo para enviar por recordatorio diario.
  router.get('/fase1/alertas-resumen', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [empresa] = await query('SELECT nombre FROM empresas WHERE id=$1', [empresaId]);
      const [vencidos] = await query(
        `SELECT COUNT(*)::int AS c, COALESCE(SUM(debe - haber),0)::numeric AS monto
         FROM cliente_cta_corriente_mov
         WHERE empresa_id=$1 AND estado='pendiente' AND vencimiento < NOW() AND (debe - haber) > 0`,
        [empresaId]
      );
      const [opp] = await query(
        `SELECT COUNT(*)::int AS c
         FROM crm_oportunidades
         WHERE empresa_id=$1 AND estado='abierta'
           AND (proxima_accion IS NULL OR proxima_accion < NOW() - INTERVAL '7 days')`,
        [empresaId]
      );
      const [ventas30] = await query(
        `SELECT COALESCE(SUM(monto),0)::numeric AS monto
         FROM pedidos
         WHERE empresa_id=$1 AND created_at >= NOW() - INTERVAL '30 days'`,
        [empresaId]
      );

      const lines = [];
      lines.push(`Resumen diario · ${empresa?.nombre || 'Empresa'} · ${new Date().toLocaleString('es-AR')}`);
      lines.push(`Ventas 30d: ${Number(ventas30?.monto || 0).toFixed(2)}`);
      lines.push(`Vencidos cta corriente: ${Number(vencidos?.c || 0)} (${Number(vencidos?.monto || 0).toFixed(2)})`);
      lines.push(`Oportunidades sin seguimiento: ${Number(opp?.c || 0)}`);
      lines.push('Siguiente acción sugerida: priorizar cobranzas vencidas y seguimiento comercial.');

      return res.json({ ok: true, summary: lines.join('\n') });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error construyendo resumen de alertas' });
    }
  });

  // GET /api/setup/fase1/clientes-crm
  router.get('/fase1/clientes-crm', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const q = String(req.query?.q || '').trim().toLowerCase();
      const params = [empresaId];
      let where = 'WHERE empresa_id=$1';
      if (q) {
        params.push(`%${q}%`);
        where += ` AND (LOWER(cliente) LIKE $${params.length} OR LOWER(COALESCE(telefono,'')) LIKE $${params.length})`;
      }

      const rows = await query(
        `SELECT id, cliente, telefono, crm_estado, crm_riesgo, crm_segmento, crm_motivo, crm_ticket_objetivo, crm_proxima_accion, crm_ultima_accion
         FROM puntos_entrega
         ${where}
         ORDER BY cliente ASC
         LIMIT 500`,
        params
      );

      return res.json({ ok: true, items: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo CRM de clientes' });
    }
  });

  // PUT /api/setup/fase1/clientes-crm/:id
  router.put('/fase1/clientes-crm/:id', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

      const b = req.body || {};
      const [row] = await query(
        `UPDATE puntos_entrega
         SET crm_estado = COALESCE($1, crm_estado),
             crm_riesgo = COALESCE($2, crm_riesgo),
             crm_segmento = COALESCE($3, crm_segmento),
             crm_motivo = COALESCE($4, crm_motivo),
             crm_ticket_objetivo = COALESCE($5, crm_ticket_objetivo),
             crm_proxima_accion = COALESCE($6, crm_proxima_accion),
             crm_ultima_accion = NOW()
         WHERE id=$7 AND empresa_id=$8
         RETURNING id, cliente, telefono, crm_estado, crm_riesgo, crm_segmento, crm_motivo, crm_ticket_objetivo, crm_proxima_accion, crm_ultima_accion`,
        [
          b.crm_estado ?? null,
          b.crm_riesgo ?? null,
          b.crm_segmento ?? null,
          b.crm_motivo ?? null,
          b.crm_ticket_objetivo != null ? Number(b.crm_ticket_objetivo) : null,
          b.crm_proxima_accion ?? null,
          id,
          empresaId,
        ]
      );

      if (!row) return res.status(404).json({ error: 'Cliente no encontrado' });
      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error actualizando CRM de cliente' });
    }
  });

  // GET /api/setup/fase1/clientes-priorizados
  // Ranking simple (RFM + riesgo CRM) para "a contactar hoy".
  router.get('/fase1/clientes-priorizados', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const rows = await query(
        `WITH base AS (
           SELECT c.id, c.cliente, c.telefono, c.crm_estado, c.crm_riesgo,
                  MAX(p.created_at) AS last_order_at,
                  COUNT(p.id)::int AS orders_90d,
                  COALESCE(SUM(p.monto),0)::numeric AS revenue_90d,
                  COALESCE(c.crm_ticket_objetivo,0)::numeric AS ticket_objetivo
           FROM puntos_entrega c
           LEFT JOIN pedidos p
             ON p.punto_entrega_id=c.id
            AND p.empresa_id=c.empresa_id
            AND p.created_at >= NOW() - INTERVAL '90 days'
           WHERE c.empresa_id=$1
           GROUP BY c.id, c.cliente, c.telefono, c.crm_estado, c.crm_riesgo, c.crm_ticket_objetivo
         )
         SELECT *,
           (
             CASE WHEN crm_estado='perdido' THEN 50 WHEN crm_estado='en_riesgo' THEN 35 WHEN crm_estado='nuevo' THEN 20 ELSE 0 END +
             CASE WHEN crm_riesgo='critico' THEN 40 WHEN crm_riesgo='alto' THEN 30 WHEN crm_riesgo='medio' THEN 15 ELSE 5 END +
             CASE WHEN last_order_at IS NULL THEN 30
                  WHEN last_order_at < NOW() - INTERVAL '30 days' THEN 25
                  WHEN last_order_at < NOW() - INTERVAL '14 days' THEN 15 ELSE 5 END +
             CASE WHEN ticket_objetivo > revenue_90d THEN 15 ELSE 0 END
           )::int AS prioridad_score
         FROM base
         ORDER BY prioridad_score DESC, revenue_90d DESC, cliente ASC
         LIMIT 30`,
        [empresaId]
      );

      return res.json({ ok: true, items: rows.map((r) => ({
        ...r,
        revenue_90d: Number(r.revenue_90d || 0),
        ticket_objetivo: Number(r.ticket_objetivo || 0),
      })) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo clientes priorizados' });
    }
  });

  // POST /api/setup/fase1/clientes-crm/:id/oportunidad
  router.post('/fase1/clientes-crm/:id/oportunidad', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const clienteId = Number(req.params.id);
      if (!Number.isFinite(clienteId) || clienteId <= 0) return res.status(400).json({ error: 'id inválido' });

      const [cliente] = await query(
        `SELECT id, cliente, crm_segmento, crm_ticket_objetivo
         FROM puntos_entrega
         WHERE id=$1 AND empresa_id=$2`,
        [clienteId, empresaId]
      );
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

      const b = req.body || {};
      const [row] = await query(
        `INSERT INTO crm_oportunidades (
          empresa_id, cliente_id, nombre, rubro, canal, etapa, probabilidad, monto_estimado,
          proxima_accion, responsable_usuario_id, notas, estado
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'abierta')
        RETURNING *`,
        [
          empresaId,
          cliente.id,
          b.nombre || `Upsell / seguimiento · ${cliente.cliente}`,
          b.rubro || cliente.crm_segmento || null,
          b.canal || 'whatsapp',
          b.etapa || 'calificado',
          b.probabilidad != null ? Number(b.probabilidad) : 35,
          b.monto_estimado != null ? Number(b.monto_estimado) : Number(cliente.crm_ticket_objetivo || 0),
          b.proxima_accion || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          req?.user?.id ? Number(req.user.id) : null,
          b.notas || 'Creada desde CRM de cliente',
        ]
      );

      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error creando oportunidad desde cliente' });
    }
  });

  return router;
}
