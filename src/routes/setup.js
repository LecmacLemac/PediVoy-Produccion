// src/routes/setup.js
// Onboarding / configuración inicial (extraído desde server.js)

import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { enqueueWppMessage } from '../services/messaging.js';
import { sendSmsViaIfttt } from '../services/sms.js';

const execFileAsync = promisify(execFile);

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
      // Fallback seguro: si no envían empresa_id, usar la empresa del token
      // (evita que acciones simples del panel fallen silenciosamente para super admin).
      return Number.isFinite(ownEmpresaId) && ownEmpresaId > 0 ? ownEmpresaId : null;
    }

    return Number.isFinite(ownEmpresaId) && ownEmpresaId > 0 ? ownEmpresaId : null;
  };

  const getUserIdForSetup = (req) => {
    const uid = Number(req?.user?.id ?? req?.user?.uid ?? 0);
    return Number.isFinite(uid) && uid > 0 ? uid : null;
  };

  const requireSuperAdmin = (req, res, next) => {
    if (String(req?.user?.role || '').toLowerCase() !== 'super') {
      return res.status(403).json({ error: 'Acceso exclusivo para super admin' });
    }
    return next();
  };
  const requireSuperMarketing = requireSuperAdmin;

  const validateIncidenciaForeignKeys = async ({ empresaId, payload }) => {
    const b = payload || {};

    const fkChecks = [
      { key: 'pedido_id', table: 'pedidos', col: 'id', label: 'pedido_id' },
      { key: 'cliente_id', table: 'puntos_entrega', col: 'id', label: 'cliente_id' },
      { key: 'chofer_id', table: 'choferes', col: 'id', label: 'chofer_id' },
      { key: 'responsable_usuario_id', table: 'usuarios', col: 'id', label: 'responsable_usuario_id' },
    ];

    for (const fk of fkChecks) {
      const raw = b[fk.key];
      if (raw == null || raw === '') continue;
      const id = Number(raw);
      if (!Number.isFinite(id) || id <= 0) {
        return { ok: false, error: `${fk.label} inválido` };
      }

      const rows = await query(
        `SELECT 1
         FROM ${fk.table}
         WHERE ${fk.col}=$1 AND empresa_id=$2
         LIMIT 1`,
        [id, empresaId]
      );

      if (!rows.length) {
        return { ok: false, error: `${fk.label} no pertenece a la empresa seleccionada` };
      }
    }

    return { ok: true };
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
        `WITH meses AS (
           SELECT date_trunc('month', gs.mes) AS mes
           FROM generate_series(
             date_trunc('month', NOW()) - INTERVAL '5 months',
             date_trunc('month', NOW()),
             INTERVAL '1 month'
           ) AS gs(mes)
         ),
         fact AS (
           SELECT date_trunc('month', p.created_at) AS mes, COALESCE(SUM(p.monto),0)::numeric AS facturacion
           FROM pedidos p
           WHERE p.empresa_id=$1
             AND p.created_at >= date_trunc('month', NOW()) - INTERVAL '5 months'
           GROUP BY 1
         ),
         cob AS (
           SELECT date_trunc('month', t.created_at) AS mes, COALESCE(SUM(t.monto),0)::numeric AS cobranzas
           FROM transferencias t
           WHERE t.empresa_id=$1
             AND (t.tipo='cobro' OR t.tipo IS NULL)
             AND t.created_at >= date_trunc('month', NOW()) - INTERVAL '5 months'
           GROUP BY 1
         )
         SELECT TO_CHAR(m.mes, 'YYYY-MM') AS mes,
                COALESCE(f.facturacion,0)::numeric AS facturacion,
                COALESCE(c.cobranzas,0)::numeric AS cobranzas
         FROM meses m
         LEFT JOIN fact f ON f.mes=m.mes
         LEFT JOIN cob c ON c.mes=m.mes
         ORDER BY m.mes`,
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

  // =========================
  // FASE 2: COMPRAS / PROVEEDORES (MVP)
  // =========================

  // GET /api/setup/fase2/proveedores
  router.get('/fase2/proveedores', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const rows = await query(
        `SELECT *
         FROM proveedores
         WHERE empresa_id=$1
         ORDER BY activo DESC, nombre ASC`,
        [empresaId]
      );
      return res.json({ ok: true, items: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo proveedores' });
    }
  });

  // POST /api/setup/fase2/proveedores
  router.post('/fase2/proveedores', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const b = req.body || {};
      const nombre = String(b.nombre || '').trim();
      if (!nombre) return res.status(400).json({ error: 'nombre requerido' });

      const [row] = await query(
        `INSERT INTO proveedores (empresa_id, nombre, cuit, telefono, email, contacto, condiciones_pago, activo, notas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [empresaId, nombre, b.cuit || null, b.telefono || null, b.email || null, b.contacto || null, b.condiciones_pago || null, b.activo !== false, b.notas || null]
      );

      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error creando proveedor' });
    }
  });

  // PUT /api/setup/fase2/proveedores/:id
  router.put('/fase2/proveedores/:id', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
      const b = req.body || {};

      const [row] = await query(
        `UPDATE proveedores
         SET nombre=COALESCE($1,nombre),
             cuit=COALESCE($2,cuit),
             telefono=COALESCE($3,telefono),
             email=COALESCE($4,email),
             contacto=COALESCE($5,contacto),
             condiciones_pago=COALESCE($6,condiciones_pago),
             activo=COALESCE($7,activo),
             notas=COALESCE($8,notas),
             updated_at=NOW()
         WHERE id=$9 AND empresa_id=$10
         RETURNING *`,
        [b.nombre ?? null, b.cuit ?? null, b.telefono ?? null, b.email ?? null, b.contacto ?? null, b.condiciones_pago ?? null, b.activo ?? null, b.notas ?? null, id, empresaId]
      );
      if (!row) return res.status(404).json({ error: 'Proveedor no encontrado' });
      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error actualizando proveedor' });
    }
  });

  // DELETE /api/setup/fase2/proveedores/:id
  router.delete('/fase2/proveedores/:id', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

      const [inUse] = await query(
        `SELECT COUNT(*)::int AS c
         FROM compras_ordenes
         WHERE empresa_id=$1 AND proveedor_id=$2`,
        [empresaId, id]
      );
      if (Number(inUse?.c || 0) > 0) {
        return res.status(400).json({ error: 'No se puede eliminar: proveedor con órdenes asociadas' });
      }

      const [row] = await query(
        `DELETE FROM proveedores
         WHERE id=$1 AND empresa_id=$2
         RETURNING id`,
        [id, empresaId]
      );
      if (!row) return res.status(404).json({ error: 'Proveedor no encontrado' });
      return res.json({ ok: true, id: row.id });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error eliminando proveedor' });
    }
  });

  // GET /api/setup/fase2/compras
  router.get('/fase2/compras', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const rows = await query(
        `SELECT o.*, p.nombre AS proveedor_nombre
         FROM compras_ordenes o
         LEFT JOIN proveedores p ON p.id=o.proveedor_id
         WHERE o.empresa_id=$1
         ORDER BY o.fecha_emision DESC, o.id DESC
         LIMIT 500`,
        [empresaId]
      );
      return res.json({ ok: true, items: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo compras' });
    }
  });

  // POST /api/setup/fase2/compras
  router.post('/fase2/compras', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const b = req.body || {};
      const proveedorId = b.proveedor_id ? Number(b.proveedor_id) : null;
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) return res.status(400).json({ error: 'items requeridos' });

      let subtotal = 0;
      const normalized = items.map((it) => {
        const cantidad = Number(it.cantidad || 0);
        const costo = Number(it.costo_unitario || 0);
        const imp = Number(it.impuesto_pct || 0);
        const st = (cantidad * costo) * (1 + imp / 100);
        subtotal += st;
        return {
          producto_id: it.producto_id ? Number(it.producto_id) : null,
          descripcion: it.descripcion || null,
          cantidad,
          costo_unitario: costo,
          impuesto_pct: imp,
          subtotal: st,
        };
      });

      const impuestos = Number(b.impuestos || 0);
      const total = subtotal + impuestos;

      const [orden] = await query(
        `INSERT INTO compras_ordenes (
          empresa_id, proveedor_id, estado, fecha_entrega_estimada,
          subtotal, impuestos, total, moneda, referencia_externa, observaciones, created_by, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          empresaId,
          proveedorId,
          b.estado || 'emitida',
          b.fecha_entrega_estimada || null,
          subtotal,
          impuestos,
          total,
          b.moneda || 'ARS',
          b.referencia_externa || null,
          b.observaciones || null,
          req?.user?.id ? Number(req.user.id) : null,
          req?.user?.id ? Number(req.user.id) : null,
        ]
      );

      for (const it of normalized) {
        await query(
          `INSERT INTO compras_orden_items (orden_id, producto_id, descripcion, cantidad, costo_unitario, impuesto_pct, subtotal)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [orden.id, it.producto_id, it.descripcion, it.cantidad, it.costo_unitario, it.impuesto_pct, it.subtotal]
        );
      }

      return res.json({ ok: true, item: orden });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error creando orden de compra' });
    }
  });

  // POST /api/setup/fase2/compras/:id/recepcionar
  router.post('/fase2/compras/:id/recepcionar', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

      const [orden] = await query(`SELECT * FROM compras_ordenes WHERE id=$1 AND empresa_id=$2`, [id, empresaId]);
      if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

      const [rec] = await query(
        `INSERT INTO compras_recepciones (empresa_id, orden_id, proveedor_id, numero_remito, observaciones, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [empresaId, orden.id, orden.proveedor_id, req.body?.numero_remito || null, req.body?.observaciones || null, req?.user?.id ? Number(req.user.id) : null]
      );

      const items = await query(`SELECT * FROM compras_orden_items WHERE orden_id=$1`, [orden.id]);
      for (const it of items) {
        await query(
          `INSERT INTO compras_recepcion_items (recepcion_id, producto_id, cantidad, costo_unitario, subtotal)
           VALUES ($1,$2,$3,$4,$5)`,
          [rec.id, it.producto_id, it.cantidad, it.costo_unitario, it.subtotal]
        );
      }

      await query(
        `UPDATE compras_ordenes
         SET estado='recibida', updated_at=NOW(), updated_by=$1
         WHERE id=$2 AND empresa_id=$3`,
        [req?.user?.id ? Number(req.user.id) : null, orden.id, empresaId]
      );

      return res.json({ ok: true, recepcion: rec });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error recepcionando compra' });
    }
  });

  // GET /api/setup/fase2/dashboard
  router.get('/fase2/dashboard', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [ord] = await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE estado='emitida' OR estado='parcial')::int AS abiertas,
                COALESCE(SUM(total) FILTER (WHERE fecha_emision >= NOW() - INTERVAL '30 days'),0)::numeric AS total_30d
         FROM compras_ordenes
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [prov] = await query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE activo=TRUE)::int AS activos
         FROM proveedores
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const topProv = await query(
        `SELECT p.id, p.nombre, COALESCE(SUM(o.total),0)::numeric AS total
         FROM compras_ordenes o
         JOIN proveedores p ON p.id=o.proveedor_id
         WHERE o.empresa_id=$1 AND o.fecha_emision >= NOW() - INTERVAL '90 days'
         GROUP BY p.id, p.nombre
         ORDER BY total DESC
         LIMIT 5`,
        [empresaId]
      );

      return res.json({
        ok: true,
        kpis: {
          ordenes_total: Number(ord?.total || 0),
          ordenes_abiertas: Number(ord?.abiertas || 0),
          compras_30d: Number(ord?.total_30d || 0),
          proveedores_total: Number(prov?.total || 0),
          proveedores_activos: Number(prov?.activos || 0),
        },
        top_proveedores: topProv.map((r) => ({ ...r, total: Number(r.total || 0) })),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo dashboard de compras' });
    }
  });

  // GET /api/setup/fase2/tesoreria
  router.get('/fase2/tesoreria', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const rows = await query(
        `SELECT t.*, p.nombre AS proveedor_nombre, o.referencia_externa
         FROM tesoreria_movimientos t
         LEFT JOIN proveedores p ON p.id=t.proveedor_id
         LEFT JOIN compras_ordenes o ON o.id=t.compra_orden_id
         WHERE t.empresa_id=$1
         ORDER BY t.fecha DESC, t.id DESC
         LIMIT 500`,
        [empresaId]
      );
      return res.json({ ok: true, items: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo tesorería' });
    }
  });

  // POST /api/setup/fase2/tesoreria
  router.post('/fase2/tesoreria', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const b = req.body || {};
      const tipo = String(b.tipo || 'egreso').toLowerCase();
      const categoria = String(b.categoria || 'pago_proveedor').trim() || 'pago_proveedor';
      const monto = Number(b.monto || 0);
      if (!['egreso', 'ingreso'].includes(tipo)) return res.status(400).json({ error: 'tipo inválido' });
      if (!(monto > 0)) return res.status(400).json({ error: 'monto inválido' });

      const [row] = await query(
        `INSERT INTO tesoreria_movimientos (
          empresa_id, tipo, categoria, proveedor_id, compra_orden_id, fecha,
          monto, medio_pago, referencia, notas, conciliado, conciliado_at, created_by
         ) VALUES ($1,$2,$3,$4,$5,COALESCE($6,NOW()),$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          empresaId,
          tipo,
          categoria,
          b.proveedor_id ? Number(b.proveedor_id) : null,
          b.compra_orden_id ? Number(b.compra_orden_id) : null,
          b.fecha || null,
          monto,
          b.medio_pago || null,
          b.referencia || null,
          b.notas || null,
          Boolean(b.conciliado),
          b.conciliado ? new Date().toISOString() : null,
          req?.user?.id ? Number(req.user.id) : null,
        ]
      );

      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error creando movimiento de tesorería' });
    }
  });

  // PUT /api/setup/fase2/tesoreria/:id/conciliar
  router.put('/fase2/tesoreria/:id/conciliar', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

      const [row] = await query(
        `UPDATE tesoreria_movimientos
         SET conciliado=TRUE, conciliado_at=NOW()
         WHERE id=$1 AND empresa_id=$2
         RETURNING *`,
        [id, empresaId]
      );
      if (!row) return res.status(404).json({ error: 'Movimiento no encontrado' });
      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error conciliando movimiento' });
    }
  });

  // GET /api/setup/fase2/tesoreria/dashboard
  router.get('/fase2/tesoreria/dashboard', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [k] = await query(
        `SELECT
           COALESCE(SUM(monto) FILTER (WHERE tipo='egreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS egresos_30d,
           COALESCE(SUM(monto) FILTER (WHERE tipo='ingreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS ingresos_30d,
           COUNT(*) FILTER (WHERE conciliado=FALSE)::int AS pendientes_conciliacion,
           COALESCE(SUM(monto) FILTER (WHERE conciliado=FALSE),0)::numeric AS monto_pendiente_conciliar
         FROM tesoreria_movimientos
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const byProv = await query(
        `SELECT p.id, p.nombre, COALESCE(SUM(t.monto),0)::numeric AS total_egresos
         FROM tesoreria_movimientos t
         JOIN proveedores p ON p.id=t.proveedor_id
         WHERE t.empresa_id=$1 AND t.tipo='egreso' AND t.fecha >= NOW() - INTERVAL '90 days'
         GROUP BY p.id, p.nombre
         ORDER BY total_egresos DESC
         LIMIT 5`,
        [empresaId]
      );

      return res.json({
        ok: true,
        kpis: {
          egresos_30d: Number(k?.egresos_30d || 0),
          ingresos_30d: Number(k?.ingresos_30d || 0),
          pendientes_conciliacion: Number(k?.pendientes_conciliacion || 0),
          monto_pendiente_conciliar: Number(k?.monto_pendiente_conciliar || 0),
        },
        top_egresos_proveedor: byProv.map((r) => ({ ...r, total_egresos: Number(r.total_egresos || 0) })),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo dashboard de tesorería' });
    }
  });

  // GET /api/setup/fase2/alertas
  router.get('/fase2/alertas', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [comp] = await query(
        `SELECT
           COUNT(*) FILTER (WHERE estado IN ('emitida','parcial') AND fecha_entrega_estimada IS NOT NULL AND fecha_entrega_estimada < CURRENT_DATE)::int AS compras_vencidas,
           COUNT(*) FILTER (WHERE estado IN ('emitida','parcial') AND fecha_entrega_estimada IS NOT NULL AND fecha_entrega_estimada <= CURRENT_DATE + INTERVAL '3 days')::int AS compras_por_vencer
         FROM compras_ordenes
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [tes] = await query(
        `SELECT
           COUNT(*) FILTER (WHERE conciliado=FALSE)::int AS pendientes_conciliacion,
           COALESCE(SUM(monto) FILTER (WHERE conciliado=FALSE),0)::numeric AS monto_pendiente,
           COALESCE(SUM(monto) FILTER (WHERE tipo='egreso' AND fecha >= NOW() - INTERVAL '7 days'),0)::numeric AS egresos_7d,
           COALESCE(SUM(monto) FILTER (WHERE tipo='egreso' AND fecha >= NOW() - INTERVAL '30 days' AND fecha < NOW() - INTERVAL '7 days'),0)::numeric AS egresos_30d_previos
         FROM tesoreria_movimientos
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const eg7 = Number(tes?.egresos_7d || 0);
      const egPrev = Number(tes?.egresos_30d_previos || 0);
      const avgSemana = egPrev > 0 ? egPrev / Math.max(1, 23 / 7) : 0;
      const ratioEgreso = avgSemana > 0 ? (eg7 / avgSemana) : 1;

      const alerts = [];
      const push = (nivel, titulo, detalle, valor = null, meta = {}) => alerts.push({ nivel, titulo, detalle, valor, ...meta });

      if (Number(comp?.compras_vencidas || 0) > 0) {
        push('alta', 'Compras vencidas', `${Number(comp.compras_vencidas)} órdenes superaron la fecha estimada de entrega`, Number(comp.compras_vencidas), { key: 'compras_vencidas' });
      }
      if (Number(comp?.compras_por_vencer || 0) > 0) {
        push('media', 'Compras por vencer', `${Number(comp.compras_por_vencer)} órdenes vencen en los próximos 3 días`, Number(comp.compras_por_vencer), { key: 'compras_por_vencer' });
      }

      const pendientes = Number(tes?.pendientes_conciliacion || 0);
      const montoPend = Number(tes?.monto_pendiente || 0);
      if (pendientes >= 10 || montoPend >= 500000) {
        push('alta', 'Conciliación atrasada', `${pendientes} movimientos pendientes por ${montoPend.toFixed(0)}`, montoPend, { key: 'conciliacion_atrasada' });
      } else if (pendientes >= 5) {
        push('media', 'Pendientes de conciliación', `${pendientes} movimientos aún no conciliados`, pendientes, { key: 'conciliacion_pendiente' });
      }

      if (ratioEgreso >= 1.5 && eg7 > 0) {
        push('alta', 'Desvío de egresos', `Egresos últimos 7d ${eg7.toFixed(0)} (x${ratioEgreso.toFixed(2)} vs promedio semanal previo)`, ratioEgreso, { key: 'desvio_egresos' });
      }

      return res.json({
        ok: true,
        totals: {
          compras_vencidas: Number(comp?.compras_vencidas || 0),
          compras_por_vencer: Number(comp?.compras_por_vencer || 0),
          pendientes_conciliacion: pendientes,
          monto_pendiente_conciliar: montoPend,
          ratio_egresos_7d: Number(ratioEgreso.toFixed(2)),
        },
        items: alerts,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo alertas fase2' });
    }
  });

  // GET /api/setup/fase2/presupuesto
  router.get('/fase2/presupuesto', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const now = new Date();
      const anio = Number(req.query?.anio || now.getFullYear());
      const mes = Number(req.query?.mes || (now.getMonth() + 1));

      const rows = await query(
        `SELECT b.*, p.nombre AS proveedor_nombre
         FROM presupuesto_mensual b
         LEFT JOIN proveedores p ON p.id=b.proveedor_id
         WHERE b.empresa_id=$1 AND b.anio=$2 AND b.mes=$3
         ORDER BY b.categoria ASC, p.nombre ASC NULLS LAST`,
        [empresaId, anio, mes]
      );

      return res.json({ ok: true, periodo: { anio, mes }, items: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo presupuesto' });
    }
  });

  // POST /api/setup/fase2/presupuesto
  router.post('/fase2/presupuesto', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const b = req.body || {};
      const now = new Date();
      const anio = Number(b.anio || now.getFullYear());
      const mes = Number(b.mes || (now.getMonth() + 1));
      const categoria = String(b.categoria || '').trim();
      const monto = Number(b.monto_presupuestado || 0);
      const proveedorId = b.proveedor_id ? Number(b.proveedor_id) : null;
      if (!categoria) return res.status(400).json({ error: 'categoria requerida' });
      if (!(mes >= 1 && mes <= 12)) return res.status(400).json({ error: 'mes inválido' });
      if (!(monto > 0)) return res.status(400).json({ error: 'monto_presupuestado inválido' });

      const [existing] = await query(
        `SELECT id FROM presupuesto_mensual
         WHERE empresa_id=$1 AND anio=$2 AND mes=$3 AND categoria=$4 AND COALESCE(proveedor_id,0)=COALESCE($5,0)
         LIMIT 1`,
        [empresaId, anio, mes, categoria, proveedorId]
      );

      let row;
      if (existing?.id) {
        [row] = await query(
          `UPDATE presupuesto_mensual
           SET monto_presupuestado=$1, updated_at=NOW()
           WHERE id=$2 AND empresa_id=$3
           RETURNING *`,
          [monto, existing.id, empresaId]
        );
      } else {
        [row] = await query(
          `INSERT INTO presupuesto_mensual (empresa_id, anio, mes, categoria, proveedor_id, monto_presupuestado, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`,
          [empresaId, anio, mes, categoria, proveedorId, monto, req?.user?.id ? Number(req.user.id) : null]
        );
      }

      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error guardando presupuesto' });
    }
  });

  // GET /api/setup/fase2/presupuesto-vs-ejecutado
  router.get('/fase2/presupuesto-vs-ejecutado', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const now = new Date();
      const anio = Number(req.query?.anio || now.getFullYear());
      const mes = Number(req.query?.mes || (now.getMonth() + 1));

      const rows = await query(
        `WITH bud AS (
           SELECT categoria, proveedor_id, SUM(monto_presupuestado)::numeric AS presupuestado
           FROM presupuesto_mensual
           WHERE empresa_id=$1 AND anio=$2 AND mes=$3
           GROUP BY categoria, proveedor_id
         ), exe AS (
           SELECT categoria, proveedor_id, SUM(monto)::numeric AS ejecutado
           FROM tesoreria_movimientos
           WHERE empresa_id=$1
             AND tipo='egreso'
             AND EXTRACT(YEAR FROM fecha)=$2
             AND EXTRACT(MONTH FROM fecha)=$3
           GROUP BY categoria, proveedor_id
         )
         SELECT COALESCE(bud.categoria, exe.categoria) AS categoria,
                COALESCE(bud.proveedor_id, exe.proveedor_id) AS proveedor_id,
                p.nombre AS proveedor_nombre,
                COALESCE(bud.presupuestado,0)::numeric AS presupuestado,
                COALESCE(exe.ejecutado,0)::numeric AS ejecutado,
                (COALESCE(exe.ejecutado,0) - COALESCE(bud.presupuestado,0))::numeric AS desvio
         FROM bud
         FULL OUTER JOIN exe
           ON exe.categoria=bud.categoria
          AND COALESCE(exe.proveedor_id,0)=COALESCE(bud.proveedor_id,0)
         LEFT JOIN proveedores p
           ON p.id=COALESCE(bud.proveedor_id, exe.proveedor_id)
         ORDER BY ABS(COALESCE(exe.ejecutado,0) - COALESCE(bud.presupuestado,0)) DESC, categoria ASC`,
        [empresaId, anio, mes]
      );

      const summary = rows.reduce((acc, r) => {
        acc.presupuestado += Number(r.presupuestado || 0);
        acc.ejecutado += Number(r.ejecutado || 0);
        return acc;
      }, { presupuestado: 0, ejecutado: 0 });
      summary.desvio = summary.ejecutado - summary.presupuestado;

      return res.json({ ok: true, periodo: { anio, mes }, summary, items: rows.map((r) => ({
        ...r,
        presupuestado: Number(r.presupuestado || 0),
        ejecutado: Number(r.ejecutado || 0),
        desvio: Number(r.desvio || 0),
      })) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo presupuesto vs ejecutado' });
    }
  });

  // GET /api/setup/fase2/tesoreria/proyeccion-caja
  router.get('/fase2/tesoreria/proyeccion-caja', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const saldoInicial = Number(req.query?.saldo_inicial || 0);
      const [m] = await query(
        `SELECT
           COALESCE(SUM(monto) FILTER (WHERE tipo='ingreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS ingresos_30d,
           COALESCE(SUM(monto) FILTER (WHERE tipo='egreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS egresos_30d,
           COUNT(DISTINCT DATE(fecha)) FILTER (WHERE fecha >= NOW() - INTERVAL '30 days')::int AS dias_activos
         FROM tesoreria_movimientos
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const dias = Math.max(1, Number(m?.dias_activos || 0));
      const ingresosDiarios = Number(m?.ingresos_30d || 0) / dias;
      const egresosDiarios = Number(m?.egresos_30d || 0) / dias;
      const netoDiario = ingresosDiarios - egresosDiarios;

      const horizons = [7, 15, 30].map((d) => {
        const flujo = netoDiario * d;
        const proyectado = saldoInicial + flujo;
        return {
          dias: d,
          flujo_estimado: Number(flujo.toFixed(2)),
          saldo_proyectado: Number(proyectado.toFixed(2)),
          riesgo: proyectado < 0 ? 'alto' : (proyectado < (saldoInicial * 0.25) ? 'medio' : 'bajo'),
        };
      });

      const alertas = horizons
        .filter((h) => h.saldo_proyectado < 0 || h.riesgo !== 'bajo')
        .map((h) => ({
          nivel: h.saldo_proyectado < 0 ? 'alta' : 'media',
          titulo: `Proyección ${h.dias} días`,
          detalle: `Saldo proyectado ${h.saldo_proyectado.toFixed(0)} (${h.riesgo})`,
          dias: h.dias,
        }));

      return res.json({
        ok: true,
        base: {
          saldo_inicial: saldoInicial,
          ingresos_diarios_estimados: Number(ingresosDiarios.toFixed(2)),
          egresos_diarios_estimados: Number(egresosDiarios.toFixed(2)),
          neto_diario_estimado: Number(netoDiario.toFixed(2)),
          dias_muestra: dias,
        },
        items: horizons,
        alertas,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo proyección de caja' });
    }
  });

  // GET /api/setup/fase2/vencimientos-proveedores
  router.get('/fase2/vencimientos-proveedores', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const rows = await query(
        `SELECT o.id, o.proveedor_id, p.nombre AS proveedor_nombre, o.estado,
                o.fecha_entrega_estimada,
                o.total,
                (o.fecha_entrega_estimada::date - CURRENT_DATE) AS dias_restantes
         FROM compras_ordenes o
         LEFT JOIN proveedores p ON p.id=o.proveedor_id
         WHERE o.empresa_id=$1
           AND o.estado IN ('emitida','parcial')
           AND o.fecha_entrega_estimada IS NOT NULL
         ORDER BY o.fecha_entrega_estimada ASC
         LIMIT 200`,
        [empresaId]
      );

      const items = rows.map((r) => ({
        ...r,
        total: Number(r.total || 0),
        dias_restantes: Number(r.dias_restantes || 0),
        nivel: Number(r.dias_restantes || 0) < 0 ? 'alta' : (Number(r.dias_restantes || 0) <= 3 ? 'media' : 'baja'),
      }));

      return res.json({ ok: true, items });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo vencimientos de proveedores' });
    }
  });

  // GET /api/setup/fase2/acciones-sugeridas
  router.get('/fase2/acciones-sugeridas', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [pend] = await query(
        `SELECT COUNT(*)::int AS pendientes,
                COALESCE(SUM(monto),0)::numeric AS monto
         FROM tesoreria_movimientos
         WHERE empresa_id=$1 AND conciliado=FALSE`,
        [empresaId]
      );

      const vencidas = await query(
        `SELECT o.id, o.total, o.fecha_entrega_estimada, p.nombre AS proveedor_nombre
         FROM compras_ordenes o
         LEFT JOIN proveedores p ON p.id=o.proveedor_id
         WHERE o.empresa_id=$1
           AND o.estado IN ('emitida','parcial')
           AND o.fecha_entrega_estimada IS NOT NULL
           AND o.fecha_entrega_estimada < CURRENT_DATE
         ORDER BY o.fecha_entrega_estimada ASC
         LIMIT 5`,
        [empresaId]
      );

      const [topCat] = await query(
        `SELECT categoria, COALESCE(SUM(monto),0)::numeric AS total
         FROM tesoreria_movimientos
         WHERE empresa_id=$1 AND tipo='egreso' AND fecha >= NOW() - INTERVAL '30 days'
         GROUP BY categoria
         ORDER BY total DESC
         LIMIT 1`,
        [empresaId]
      );

      const actions = [];
      const add = (prioridad, tipo, titulo, detalle, payload = {}) => actions.push({ prioridad, tipo, titulo, detalle, payload });

      const pendientes = Number(pend?.pendientes || 0);
      const montoPend = Number(pend?.monto || 0);
      if (pendientes > 0) {
        add(
          pendientes >= 10 ? 'alta' : 'media',
          'conciliacion',
          'Limpiar conciliación pendiente',
          `Conciliar ${pendientes} movimientos por ${Math.round(montoPend)} para mejorar visibilidad de caja.`,
          { pendientes, monto: montoPend }
        );
      }

      if (vencidas.length > 0) {
        add(
          'alta',
          'compras_vencidas',
          'Contactar proveedores con órdenes vencidas',
          `Hay ${vencidas.length} órdenes vencidas. Priorizar seguimiento hoy.`,
          { ordenes: vencidas.map((v) => ({ id: v.id, proveedor: v.proveedor_nombre, total: Number(v.total || 0) })) }
        );
      }

      if (topCat?.categoria) {
        add(
          'media',
          'control_egresos',
          'Revisar categoría de mayor egreso',
          `La categoría ${topCat.categoria} concentra ${Math.round(Number(topCat.total || 0))} en 30 días. Evaluar ahorro o renegociación.`,
          { categoria: topCat.categoria, total_30d: Number(topCat.total || 0) }
        );
      }

      return res.json({ ok: true, items: actions });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo acciones sugeridas' });
    }
  });

  // GET /api/setup/fase2/reporte-mensual
  router.get('/fase2/reporte-mensual', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const now = new Date();
      const anio = Number(req.query?.anio || now.getFullYear());
      const mes = Number(req.query?.mes || (now.getMonth() + 1));

      const [compras] = await query(
        `SELECT COUNT(*)::int AS ordenes,
                COALESCE(SUM(total),0)::numeric AS total
         FROM compras_ordenes
         WHERE empresa_id=$1
           AND EXTRACT(YEAR FROM fecha_emision)=$2
           AND EXTRACT(MONTH FROM fecha_emision)=$3`,
        [empresaId, anio, mes]
      );

      const [teso] = await query(
        `SELECT
           COALESCE(SUM(monto) FILTER (WHERE tipo='ingreso'),0)::numeric AS ingresos,
           COALESCE(SUM(monto) FILTER (WHERE tipo='egreso'),0)::numeric AS egresos,
           COUNT(*) FILTER (WHERE conciliado=FALSE)::int AS pendientes_conciliacion
         FROM tesoreria_movimientos
         WHERE empresa_id=$1
           AND EXTRACT(YEAR FROM fecha)=$2
           AND EXTRACT(MONTH FROM fecha)=$3`,
        [empresaId, anio, mes]
      );

      const [pres] = await query(
        `WITH b AS (
           SELECT COALESCE(SUM(monto_presupuestado),0)::numeric AS presupuestado
           FROM presupuesto_mensual
           WHERE empresa_id=$1 AND anio=$2 AND mes=$3
         ), e AS (
           SELECT COALESCE(SUM(monto),0)::numeric AS ejecutado
           FROM tesoreria_movimientos
           WHERE empresa_id=$1 AND tipo='egreso'
             AND EXTRACT(YEAR FROM fecha)=$2 AND EXTRACT(MONTH FROM fecha)=$3
         )
         SELECT b.presupuestado, e.ejecutado, (e.ejecutado - b.presupuestado)::numeric AS desvio
         FROM b, e`,
        [empresaId, anio, mes]
      );

      return res.json({
        ok: true,
        periodo: { anio, mes },
        compras: { ordenes: Number(compras?.ordenes || 0), total: Number(compras?.total || 0) },
        tesoreria: {
          ingresos: Number(teso?.ingresos || 0),
          egresos: Number(teso?.egresos || 0),
          pendientes_conciliacion: Number(teso?.pendientes_conciliacion || 0),
        },
        presupuesto: {
          presupuestado: Number(pres?.presupuestado || 0),
          ejecutado: Number(pres?.ejecutado || 0),
          desvio: Number(pres?.desvio || 0),
        },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo reporte mensual fase2' });
    }
  });

  // =========================
  // FASE 3: TABLERO EJECUTIVO + REGLAS AUTOMÁTICAS (MVP)
  // =========================

  // GET /api/setup/fase3/data-health
  router.get('/fase3/data-health', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [inc] = await query(`SELECT COUNT(*)::int AS c FROM incidencias_operativas WHERE empresa_id=$1`, [empresaId]);
      const [tes] = await query(`SELECT COUNT(*)::int AS c FROM tesoreria_movimientos WHERE empresa_id=$1`, [empresaId]);
      const [com] = await query(`SELECT COUNT(*)::int AS c FROM compras_ordenes WHERE empresa_id=$1`, [empresaId]);
      const [crm] = await query(`SELECT COUNT(*)::int AS c FROM crm_oportunidades WHERE empresa_id=$1`, [empresaId]);

      const metrics = {
        incidencias: Number(inc?.c || 0),
        tesoreria: Number(tes?.c || 0),
        compras: Number(com?.c || 0),
        crm: Number(crm?.c || 0),
      };

      const alerts = [];
      if (metrics.incidencias === 0) alerts.push('Sin datos en incidencias_operativas (SLA/criticidad no verificables)');
      if (metrics.tesoreria === 0) alerts.push('Sin datos en tesoreria_movimientos (caja/proyección ciega)');
      if (metrics.compras === 0) alerts.push('Sin datos en compras_ordenes (vencimientos no verificables)');
      if (metrics.crm === 0) alerts.push('Sin datos en crm_oportunidades (pipeline comercial vacío)');

      return res.json({ ok: alerts.length === 0, metrics, alerts, empresa_id: empresaId });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo data health fase3' });
    }
  });

  // GET /api/setup/fase3/integridad-modulos
  router.get('/fase3/integridad-modulos', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [inc] = await query(
        `SELECT COUNT(*)::int AS c, MAX(created_at) AS last_at FROM incidencias_operativas WHERE empresa_id=$1`,
        [empresaId]
      );
      const [tes] = await query(
        `SELECT COUNT(*)::int AS c, MAX(fecha) AS last_at FROM tesoreria_movimientos WHERE empresa_id=$1`,
        [empresaId]
      );
      const [com] = await query(
        `SELECT COUNT(*)::int AS c, MAX(created_at) AS last_at FROM compras_ordenes WHERE empresa_id=$1`,
        [empresaId]
      );
      const [crm] = await query(
        `SELECT COUNT(*)::int AS c, MAX(created_at) AS last_at FROM crm_oportunidades WHERE empresa_id=$1`,
        [empresaId]
      );

      const modules = {
        incidencias: { count: Number(inc?.c || 0), last_at: inc?.last_at || null },
        tesoreria: { count: Number(tes?.c || 0), last_at: tes?.last_at || null },
        compras: { count: Number(com?.c || 0), last_at: com?.last_at || null },
        crm: { count: Number(crm?.c || 0), last_at: crm?.last_at || null },
      };

      const missing = Object.values(modules).filter((m) => Number(m.count || 0) === 0).length;
      const score = Math.max(0, 100 - (missing * 25));

      return res.json({ ok: missing === 0, empresa_id: empresaId, score, modules });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo integridad de módulos fase3' });
    }
  });

  // GET /api/setup/fase3/dashboard
  router.get('/fase3/dashboard', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [comercial] = await query(
        `SELECT
           COUNT(*) FILTER (WHERE estado='abierta')::int AS oportunidades_abiertas,
           COALESCE(SUM(monto_estimado) FILTER (WHERE estado='abierta'),0)::numeric AS pipeline_total,
           COALESCE(SUM(monto_estimado * (probabilidad/100.0)) FILTER (WHERE estado='abierta'),0)::numeric AS pipeline_ponderado
         FROM crm_oportunidades
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [teso] = await query(
        `SELECT
           COALESCE(SUM(monto) FILTER (WHERE tipo='ingreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS ingresos_30d,
           COALESCE(SUM(monto) FILTER (WHERE tipo='egreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS egresos_30d,
           COUNT(*) FILTER (WHERE conciliado=FALSE)::int AS pendientes_conciliacion
         FROM tesoreria_movimientos
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [compras] = await query(
        `SELECT
           COUNT(*) FILTER (WHERE estado IN ('emitida','parcial'))::int AS compras_abiertas,
           COALESCE(SUM(total) FILTER (WHERE estado IN ('emitida','parcial')),0)::numeric AS compras_comprometidas
         FROM compras_ordenes
         WHERE empresa_id=$1`,
        [empresaId]
      );

      return res.json({
        ok: true,
        kpis: {
          oportunidades_abiertas: Number(comercial?.oportunidades_abiertas || 0),
          pipeline_total: Number(comercial?.pipeline_total || 0),
          pipeline_ponderado: Number(comercial?.pipeline_ponderado || 0),
          ingresos_30d: Number(teso?.ingresos_30d || 0),
          egresos_30d: Number(teso?.egresos_30d || 0),
          pendientes_conciliacion: Number(teso?.pendientes_conciliacion || 0),
          compras_abiertas: Number(compras?.compras_abiertas || 0),
          compras_comprometidas: Number(compras?.compras_comprometidas || 0),
        },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo dashboard fase3' });
    }
  });

  // GET /api/setup/fase3/recomendaciones
  router.get('/fase3/recomendaciones', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [k] = await query(
        `SELECT
           COALESCE(SUM(monto) FILTER (WHERE tipo='ingreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS ingresos_30d,
           COALESCE(SUM(monto) FILTER (WHERE tipo='egreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS egresos_30d,
           COUNT(*) FILTER (WHERE conciliado=FALSE)::int AS pendientes_conciliacion
         FROM tesoreria_movimientos
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [p] = await query(
        `SELECT COALESCE(SUM(monto_estimado * (probabilidad/100.0)) FILTER (WHERE estado='abierta'),0)::numeric AS pipeline_ponderado
         FROM crm_oportunidades
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [ov] = await query(
        `SELECT COUNT(*)::int AS vencidas
         FROM compras_ordenes
         WHERE empresa_id=$1
           AND estado IN ('emitida','parcial')
           AND fecha_entrega_estimada IS NOT NULL
           AND fecha_entrega_estimada < CURRENT_DATE`,
        [empresaId]
      );

      const ingresos = Number(k?.ingresos_30d || 0);
      const egresos = Number(k?.egresos_30d || 0);
      const pendientes = Number(k?.pendientes_conciliacion || 0);
      const pipe = Number(p?.pipeline_ponderado || 0);
      const vencidas = Number(ov?.vencidas || 0);

      const items = [];
      const add = (prioridad, titulo, detalle, accion) => items.push({ prioridad, titulo, detalle, accion });

      if (egresos > ingresos * 1.15) {
        add('alta', 'Caja en tensión', 'Egresos 30d superan ingresos en más de 15%.', 'Revisar pagos no críticos y acelerar cobranzas de clientes prioritarios.');
      }
      if (pendientes >= 8) {
        add('media', 'Conciliación atrasada', `Hay ${pendientes} movimientos pendientes de conciliación.`, 'Asignar bloque de 30 minutos diario para dejar saldo real al día.');
      }
      if (vencidas > 0) {
        add('alta', 'Compras vencidas', `Hay ${vencidas} órdenes de compra vencidas.`, 'Contactar proveedores hoy y reprogramar entregas críticas.');
      }
      if (pipe < egresos * 0.7) {
        add('media', 'Pipeline débil vs egresos', 'El pipeline ponderado no cubre bien la presión de egresos.', 'Empujar cierres de oportunidades con mayor probabilidad esta semana.');
      }
      if (!items.length) {
        add('baja', 'Operación estable', 'No se detectaron desvíos críticos hoy.', 'Mantener rutina de conciliación y seguimiento comercial diario.');
      }

      return res.json({ ok: true, items });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo recomendaciones fase3' });
    }
  });

  // GET /api/setup/fase3/semaforo-operativo
  router.get('/fase3/semaforo-operativo', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [k] = await query(
        `SELECT
           COALESCE(SUM(monto) FILTER (WHERE tipo='ingreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS ingresos_30d,
           COALESCE(SUM(monto) FILTER (WHERE tipo='egreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS egresos_30d,
           COUNT(*) FILTER (WHERE conciliado=FALSE)::int AS pendientes_conciliacion
         FROM tesoreria_movimientos
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [v] = await query(
        `SELECT COUNT(*)::int AS compras_vencidas
         FROM compras_ordenes
         WHERE empresa_id=$1
           AND estado IN ('emitida','parcial')
           AND fecha_entrega_estimada IS NOT NULL
           AND fecha_entrega_estimada < CURRENT_DATE`,
        [empresaId]
      );

      const [p] = await query(
        `SELECT COALESCE(SUM(monto_estimado * (probabilidad/100.0)) FILTER (WHERE estado='abierta'),0)::numeric AS pipeline_ponderado
         FROM crm_oportunidades
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const ingresos = Number(k?.ingresos_30d || 0);
      const egresos = Number(k?.egresos_30d || 0);
      const pendientes = Number(k?.pendientes_conciliacion || 0);
      const vencidas = Number(v?.compras_vencidas || 0);
      const pipe = Number(p?.pipeline_ponderado || 0);

      let score = 100;
      if (ingresos > 0 && egresos > ingresos) score -= Math.min(35, Math.round(((egresos - ingresos) / ingresos) * 100));
      score -= Math.min(25, pendientes * 2);
      score -= Math.min(20, vencidas * 4);
      if (egresos > 0 && pipe < egresos * 0.7) score -= 15;
      score = Math.max(0, Math.min(100, score));

      const nivel = score >= 75 ? 'verde' : (score >= 50 ? 'amarillo' : 'rojo');
      return res.json({
        ok: true,
        score,
        nivel,
        factores: {
          ingresos_30d: ingresos,
          egresos_30d: egresos,
          pendientes_conciliacion: pendientes,
          compras_vencidas: vencidas,
          pipeline_ponderado: pipe,
        },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo semáforo operativo' });
    }
  });

  // GET /api/setup/fase3/resumen-diario
  router.get('/fase3/resumen-diario', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [comercial] = await query(
        `SELECT
           COUNT(*) FILTER (WHERE estado='abierta')::int AS oportunidades_abiertas,
           COALESCE(SUM(monto_estimado) FILTER (WHERE estado='abierta'),0)::numeric AS pipeline_total,
           COALESCE(SUM(monto_estimado * (probabilidad/100.0)) FILTER (WHERE estado='abierta'),0)::numeric AS pipeline_ponderado
         FROM crm_oportunidades
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [teso] = await query(
        `SELECT
           COALESCE(SUM(monto) FILTER (WHERE tipo='ingreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS ingresos_30d,
           COALESCE(SUM(monto) FILTER (WHERE tipo='egreso' AND fecha >= NOW() - INTERVAL '30 days'),0)::numeric AS egresos_30d,
           COUNT(*) FILTER (WHERE conciliado=FALSE)::int AS pendientes_conciliacion
         FROM tesoreria_movimientos
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const [compras] = await query(
        `SELECT
           COUNT(*) FILTER (WHERE estado IN ('emitida','parcial'))::int AS compras_abiertas,
           COALESCE(SUM(total) FILTER (WHERE estado IN ('emitida','parcial')),0)::numeric AS compras_comprometidas,
           COUNT(*) FILTER (WHERE estado IN ('emitida','parcial') AND fecha_entrega_estimada IS NOT NULL AND fecha_entrega_estimada < CURRENT_DATE)::int AS compras_vencidas
         FROM compras_ordenes
         WHERE empresa_id=$1`,
        [empresaId]
      );

      const ingresos = Number(teso?.ingresos_30d || 0);
      const egresos = Number(teso?.egresos_30d || 0);
      const pendientes = Number(teso?.pendientes_conciliacion || 0);
      const pipePond = Number(comercial?.pipeline_ponderado || 0);
      const comprasVencidas = Number(compras?.compras_vencidas || 0);

      const recomendaciones = [];
      if (egresos > ingresos * 1.15) recomendaciones.push('Caja en tensión: revisar egresos no críticos y acelerar cobranzas.');
      if (pendientes >= 8) recomendaciones.push(`Conciliación atrasada: ${pendientes} movimientos pendientes.`);
      if (comprasVencidas > 0) recomendaciones.push(`Compras vencidas: ${comprasVencidas} órdenes requieren seguimiento.`);
      if (pipePond < egresos * 0.7) recomendaciones.push('Pipeline ponderado débil vs egresos: enfocar cierres con alta probabilidad.');
      if (!recomendaciones.length) recomendaciones.push('Operación estable: mantener rutina diaria de seguimiento comercial y conciliación.');

      const resumen = [
        '📌 Resumen ejecutivo diario',
        `- Oportunidades abiertas: ${Number(comercial?.oportunidades_abiertas || 0)}`,
        `- Pipeline total: ${Number(comercial?.pipeline_total || 0).toFixed(0)}`,
        `- Pipeline ponderado: ${pipePond.toFixed(0)}`,
        `- Ingresos 30d: ${ingresos.toFixed(0)}`,
        `- Egresos 30d: ${egresos.toFixed(0)}`,
        `- Pendientes conciliación: ${pendientes}`,
        `- Compras abiertas: ${Number(compras?.compras_abiertas || 0)}`,
        `- Compras comprometidas: ${Number(compras?.compras_comprometidas || 0).toFixed(0)}`,
        `- Compras vencidas: ${comprasVencidas}`,
        '',
        '🎯 Recomendaciones:',
        ...recomendaciones.map((r) => `- ${r}`),
      ].join('\n');

      return res.json({
        ok: true,
        resumen,
        recomendaciones,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo resumen diario fase3' });
    }
  });

  // GET /api/setup/fase3/control-cierre
  router.get('/fase3/control-cierre', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const [pend] = await query(
        `SELECT COUNT(*)::int AS pendientes,
                COALESCE(SUM(monto),0)::numeric AS monto
         FROM tesoreria_movimientos
         WHERE empresa_id=$1 AND conciliado=FALSE`,
        [empresaId]
      );

      const [venc] = await query(
        `SELECT COUNT(*)::int AS vencidas
         FROM compras_ordenes
         WHERE empresa_id=$1
           AND estado IN ('emitida','parcial')
           AND fecha_entrega_estimada IS NOT NULL
           AND fecha_entrega_estimada < CURRENT_DATE`,
        [empresaId]
      );

      const now = new Date();
      const anio = Number(req.query?.anio || now.getFullYear());
      const mes = Number(req.query?.mes || (now.getMonth() + 1));

      const [pres] = await query(
        `WITH b AS (
           SELECT COALESCE(SUM(monto_presupuestado),0)::numeric AS presupuestado
           FROM presupuesto_mensual
           WHERE empresa_id=$1 AND anio=$2 AND mes=$3
         ), e AS (
           SELECT COALESCE(SUM(monto),0)::numeric AS ejecutado
           FROM tesoreria_movimientos
           WHERE empresa_id=$1 AND tipo='egreso'
             AND EXTRACT(YEAR FROM fecha)=$2 AND EXTRACT(MONTH FROM fecha)=$3
         )
         SELECT b.presupuestado, e.ejecutado, (e.ejecutado - b.presupuestado)::numeric AS desvio
         FROM b, e`,
        [empresaId, anio, mes]
      );

      const pendientes = Number(pend?.pendientes || 0);
      const montoPendiente = Number(pend?.monto || 0);
      const comprasVencidas = Number(venc?.vencidas || 0);
      const presupuestado = Number(pres?.presupuestado || 0);
      const ejecutado = Number(pres?.ejecutado || 0);
      const desvio = Number(pres?.desvio || 0);

      const checklist = [
        {
          key: 'conciliacion',
          titulo: 'Conciliar pendientes críticos',
          status: pendientes === 0 ? 'ok' : (pendientes <= 5 ? 'atencion' : 'critico'),
          detalle: pendientes === 0
            ? 'Sin pendientes de conciliación.'
            : `${pendientes} pendientes por ${Math.round(montoPendiente)}.`,
        },
        {
          key: 'vencimientos',
          titulo: 'Revisar vencimientos proveedores',
          status: comprasVencidas === 0 ? 'ok' : (comprasVencidas <= 3 ? 'atencion' : 'critico'),
          detalle: comprasVencidas === 0 ? 'Sin compras vencidas.' : `${comprasVencidas} órdenes vencidas.`,
        },
        {
          key: 'presupuesto',
          titulo: 'Validar desvío presupuesto vs ejecutado',
          status: presupuestado <= 0
            ? (ejecutado > 0 ? 'atencion' : 'ok')
            : (desvio > presupuestado * 0.2 ? 'critico' : (desvio > presupuestado * 0.05 ? 'atencion' : 'ok')),
          detalle: `Presupuestado ${Math.round(presupuestado)} · Ejecutado ${Math.round(ejecutado)} · Desvío ${Math.round(desvio)}.`,
        },
      ];

      return res.json({ ok: true, periodo: { anio, mes }, checklist });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo control de cierre' });
    }
  });

  // GET /api/setup/fase3/automatizaciones
  router.get('/fase3/automatizaciones', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      // Referencia operativa: jobs programados en OpenClaw para seguimiento ejecutivo.
      const jobs = [
        {
          id: 'f9258056-a087-4332-86e5-5f59bbe56477',
          nombre: 'Resumen ejecutivo diario (Fase 3)',
          cron: '0 9 * * 1-6',
          tz: 'America/Argentina/Salta',
          objetivo: 'Arranque de jornada con foco en tablero ejecutivo y tesorería',
        },
        {
          id: '4f286c37-81d0-4486-8a6d-77a1ad401bdc',
          nombre: 'Cierre operativo diario (Fase 3)',
          cron: '30 18 * * 1-6',
          tz: 'America/Argentina/Salta',
          objetivo: 'Checklist de cierre: conciliación, vencimientos, desvíos y resumen',
        },
        {
          id: '8856423f-9fab-4888-b084-60c9fa13efa0',
          nombre: 'Planificación semanal ejecutiva (Fase 3)',
          cron: '30 8 * * 1',
          tz: 'America/Argentina/Salta',
          objetivo: 'Definir foco semanal en caja, comercial y compras críticas',
        },
      ];

      return res.json({ ok: true, items: jobs });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo automatizaciones fase3' });
    }
  });

  const PEDIVOY_AGENT_META = {
    '8ff11c9c-a6f6-4caa-af41-ca3e5c765a34': { tipo: 'qa', objetivo: 'Chequeo QA rápido de Fase 3 con foco en riesgos críticos.' },
    '1321ce4e-55a4-4cc2-afce-7fc7be49f0b3': { tipo: 'operativo', objetivo: 'Alertar sobre SLA, conciliación, compras vencidas y señal de caja.' },
    'bf97975b-bc23-4b04-bb60-1adda91563a8': { tipo: 'comercial', objetivo: 'Detectar pipeline estancado y proponer acciones de seguimiento.' },
  };

  async function openclawCron(args = [], opts = {}) {
    const node22 = '/home/lemac/.nvm/versions/node/v22.22.0/bin/node';
    const cliEntry = '/home/lemac/.npm-global/lib/node_modules/openclaw/openclaw.mjs';
    const nodeExec = node22;
    const cmdArgs = [cliEntry, 'cron', ...args];

    const env = { ...process.env };
    const nodeBinDir = nodeExec.includes('/') ? nodeExec.slice(0, nodeExec.lastIndexOf('/')) : '';
    if (nodeBinDir) env.PATH = `${nodeBinDir}:${env.PATH || ''}`;

    const timeoutMs = Number(opts.timeoutMs || 15000);
    const { stdout } = await execFileAsync(nodeExec, cmdArgs, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env,
    });
    return String(stdout || '');
  }

  // GET /api/setup/fase3/agentes
  router.get('/fase3/agentes', withAuth, requireSuperAdmin, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const raw = await openclawCron(['list', '--all', '--json', '--timeout', '10000'], { timeoutMs: 12000 });
      let parsed = [];
      try { parsed = JSON.parse(raw); } catch { parsed = []; }
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.jobs) ? parsed.jobs : []);
      const items = list
        .filter((j) => PEDIVOY_AGENT_META[String(j.id || '')])
        .map((j) => ({
          id: j.id,
          nombre: j.name || j.id,
          cron: j.schedule?.expr || '-',
          tz: j.schedule?.tz || 'America/Argentina/Salta',
          tipo: PEDIVOY_AGENT_META[String(j.id)]?.tipo || 'general',
          objetivo: PEDIVOY_AGENT_META[String(j.id)]?.objetivo || '',
          estado: j.enabled === false ? 'pausado' : 'activo',
          nextRunAt: j.state?.nextRunAtMs || null,
        }));

      return res.json({
        ok: true,
        items,
        ayuda: {
          ver: 'openclaw cron list --all --json',
          historial: 'openclaw cron runs <id>',
          ejecutarAhora: 'openclaw cron run <id>',
          pausar: 'openclaw cron disable <id>',
          reanudar: 'openclaw cron enable <id>',
        },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo panel de agentes' });
    }
  });

  // POST /api/setup/fase3/agentes/:id/accion
  router.post('/fase3/agentes/:id/accion', withAuth, requireSuperAdmin, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const id = String(req.params.id || '').trim();
      const accion = String(req.body?.accion || '').trim().toLowerCase();
      if (!PEDIVOY_AGENT_META[id]) return res.status(404).json({ error: 'Agente no permitido en panel PediVoy' });

      if (accion === 'run') await openclawCron(['run', id, '--timeout', '10000'], { timeoutMs: 12000 });
      else if (accion === 'pause') await openclawCron(['disable', id, '--timeout', '10000'], { timeoutMs: 12000 });
      else if (accion === 'resume') await openclawCron(['enable', id, '--timeout', '10000'], { timeoutMs: 12000 });
      else return res.status(400).json({ error: 'Acción inválida. Usá: run | pause | resume' });

      return res.json({ ok: true, id, accion });
    } catch (e) {
      console.error(e);
      const msg = e?.killed ? 'La acción tardó demasiado en responder desde OpenClaw. Reintentá en unos segundos.' : 'Error ejecutando acción de agente';
      return res.status(500).json({ error: msg });
    }
  });

  // GET /api/setup/fase3/usuarios
  router.get('/fase3/usuarios', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const rows = await query(
        `SELECT id, username, role, empresa_id
         FROM usuarios
         WHERE empresa_id=$1 OR role='super'
         ORDER BY role='super' DESC, username ASC`,
        [empresaId]
      );
      return res.json({ ok: true, items: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo usuarios fase3' });
    }
  });

  // GET /api/setup/fase3/incidencias
  router.get('/fase3/incidencias', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const estado = String(req.query?.estado || '').trim();
      const tipo = String(req.query?.tipo || '').trim();
      const severidad = String(req.query?.severidad || '').trim();
      const sla = String(req.query?.sla || '').trim().toLowerCase();
      const soloMias = ['1', 'true', 'si', 'sí'].includes(String(req.query?.mias || '').toLowerCase());

      const params = [empresaId];
      let where = 'WHERE i.empresa_id=$1';
      if (estado) { params.push(estado); where += ` AND i.estado=$${params.length}`; }
      if (tipo) { params.push(tipo); where += ` AND i.tipo=$${params.length}`; }
      if (severidad) { params.push(severidad); where += ` AND i.severidad=$${params.length}`; }
      if (sla === 'vencida') where += ` AND i.vence_at IS NOT NULL AND i.vence_at < NOW() AND i.estado IN ('abierta','en_progreso')`;
      if (sla === 'hoy') where += ` AND i.vence_at IS NOT NULL AND i.vence_at >= NOW() AND i.vence_at < NOW() + INTERVAL '24 hour' AND i.estado IN ('abierta','en_progreso')`;
      if (sla === 'en_plazo') where += ` AND i.vence_at IS NOT NULL AND i.vence_at >= NOW() + INTERVAL '24 hour' AND i.estado IN ('abierta','en_progreso')`;
      if (sla === 'sin_sla') where += ` AND i.vence_at IS NULL`;
      if (soloMias) {
        const uid = getUserIdForSetup(req);
        if (!uid) return res.status(400).json({ error: 'usuario inválido para filtro mías' });
        params.push(uid);
        where += ` AND i.responsable_usuario_id=$${params.length}`;
      }

      const rows = await query(
        `SELECT i.*, p.cliente AS cliente_nombre, u.username AS responsable_nombre
         FROM incidencias_operativas i
         LEFT JOIN puntos_entrega p ON p.id=i.cliente_id AND p.empresa_id=i.empresa_id
         LEFT JOIN usuarios u ON u.id=i.responsable_usuario_id AND u.empresa_id=i.empresa_id
         ${where}
         ORDER BY i.created_at DESC
         LIMIT 500`,
        params
      );
      return res.json({ ok: true, items: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo incidencias' });
    }
  });

  // GET /api/setup/fase3/incidencias/export.csv
  router.get('/fase3/incidencias/export.csv', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const estado = String(req.query?.estado || '').trim();
      const tipo = String(req.query?.tipo || '').trim();
      const severidad = String(req.query?.severidad || '').trim();
      const sla = String(req.query?.sla || '').trim().toLowerCase();
      const soloMias = ['1', 'true', 'si', 'sí'].includes(String(req.query?.mias || '').toLowerCase());

      const params = [empresaId];
      let where = 'WHERE i.empresa_id=$1';
      if (estado) { params.push(estado); where += ` AND i.estado=$${params.length}`; }
      if (tipo) { params.push(tipo); where += ` AND i.tipo=$${params.length}`; }
      if (severidad) { params.push(severidad); where += ` AND i.severidad=$${params.length}`; }
      if (sla === 'vencida') where += ` AND i.vence_at IS NOT NULL AND i.vence_at < NOW() AND i.estado IN ('abierta','en_progreso')`;
      if (sla === 'hoy') where += ` AND i.vence_at IS NOT NULL AND i.vence_at >= NOW() AND i.vence_at < NOW() + INTERVAL '24 hour' AND i.estado IN ('abierta','en_progreso')`;
      if (sla === 'en_plazo') where += ` AND i.vence_at IS NOT NULL AND i.vence_at >= NOW() + INTERVAL '24 hour' AND i.estado IN ('abierta','en_progreso')`;
      if (sla === 'sin_sla') where += ` AND i.vence_at IS NULL`;
      if (soloMias) {
        const uid = getUserIdForSetup(req);
        if (!uid) return res.status(400).json({ error: 'usuario inválido para filtro mías' });
        params.push(uid);
        where += ` AND i.responsable_usuario_id=$${params.length}`;
      }

      const rows = await query(
        `SELECT i.id, i.created_at, i.tipo, i.severidad, i.estado, i.titulo,
                i.accion_recomendada, i.vence_at, u.username AS responsable
         FROM incidencias_operativas i
         LEFT JOIN usuarios u ON u.id=i.responsable_usuario_id AND u.empresa_id=i.empresa_id
         ${where}
         ORDER BY i.created_at DESC
         LIMIT 2000`,
        params
      );

      const csvEsc = (v) => {
        if (v == null) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = ['id', 'fecha', 'tipo', 'severidad', 'estado', 'titulo', 'responsable', 'vence_at', 'accion_recomendada'];
      const lines = [header.join(',')].concat(rows.map((r) => [
        r.id,
        r.created_at ? new Date(r.created_at).toISOString() : '',
        r.tipo,
        r.severidad,
        r.estado,
        r.titulo,
        r.responsable || '',
        r.vence_at ? new Date(r.vence_at).toISOString() : '',
        r.accion_recomendada || '',
      ].map(csvEsc).join(',')));

      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="incidencias-${empresaId}-${stamp}.csv"`);
      return res.status(200).send(`\uFEFF${lines.join('\n')}`);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error exportando incidencias' });
    }
  });

  // POST /api/setup/fase3/incidencias
  router.post('/fase3/incidencias', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const b = req.body || {};
      const titulo = String(b.titulo || '').trim();
      if (!titulo) return res.status(400).json({ error: 'titulo requerido' });

      const actorId = getUserIdForSetup(req);

      const fkValidation = await validateIncidenciaForeignKeys({ empresaId, payload: b });
      if (!fkValidation.ok) return res.status(400).json({ error: fkValidation.error });

      const [row] = await query(
        `INSERT INTO incidencias_operativas (
          empresa_id, pedido_id, cliente_id, chofer_id, tipo, severidad, estado,
          titulo, detalle, accion_recomendada, responsable_usuario_id, vence_at, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          empresaId,
          b.pedido_id ? Number(b.pedido_id) : null,
          b.cliente_id ? Number(b.cliente_id) : null,
          b.chofer_id ? Number(b.chofer_id) : null,
          b.tipo || 'entrega',
          b.severidad || 'media',
          b.estado || 'abierta',
          titulo,
          b.detalle || null,
          b.accion_recomendada || null,
          b.responsable_usuario_id ? Number(b.responsable_usuario_id) : null,
          b.vence_at || null,
          actorId,
        ]
      );

      await query(
        `INSERT INTO incidencias_operativas_historial (incidencia_id, empresa_id, evento, payload, actor_usuario_id)
         VALUES ($1,$2,'creada',$3,$4)`,
        [row.id, empresaId, JSON.stringify({ estado: row.estado, severidad: row.severidad, responsable_usuario_id: row.responsable_usuario_id, vence_at: row.vence_at }), actorId]
      );

      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error creando incidencia' });
    }
  });

  // PUT /api/setup/fase3/incidencias/:id
  router.put('/fase3/incidencias/:id', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
      const b = req.body || {};

      const estado = b.estado ?? null;
      const isResuelta = estado === 'resuelta';
      const actorId = getUserIdForSetup(req);
      const hasField = (name) => Object.prototype.hasOwnProperty.call(b, name);
      const [before] = await query(`SELECT * FROM incidencias_operativas WHERE id=$1 AND empresa_id=$2`, [id, empresaId]);
      if (!before) return res.status(404).json({ error: 'Incidencia no encontrada' });

      const fkValidation = await validateIncidenciaForeignKeys({ empresaId, payload: b });
      if (!fkValidation.ok) return res.status(400).json({ error: fkValidation.error });

      const [row] = await query(
        `UPDATE incidencias_operativas
         SET tipo=CASE WHEN $1 THEN $2 ELSE tipo END,
             severidad=CASE WHEN $3 THEN $4 ELSE severidad END,
             estado=CASE WHEN $5 THEN $6 ELSE estado END,
             titulo=CASE WHEN $7 THEN $8 ELSE titulo END,
             detalle=CASE WHEN $9 THEN $10 ELSE detalle END,
             accion_recomendada=CASE WHEN $11 THEN $12 ELSE accion_recomendada END,
             responsable_usuario_id=CASE WHEN $13 THEN $14 ELSE responsable_usuario_id END,
             vence_at=CASE WHEN $15 THEN $16 ELSE vence_at END,
             resuelta_at=CASE WHEN $17 THEN NOW() ELSE resuelta_at END,
             resuelta_por=CASE WHEN $17 THEN $18 ELSE resuelta_por END,
             updated_at=NOW()
         WHERE id=$19 AND empresa_id=$20
         RETURNING *`,
        [
          hasField('tipo'),
          b.tipo ?? null,
          hasField('severidad'),
          b.severidad ?? null,
          hasField('estado'),
          estado,
          hasField('titulo'),
          b.titulo ?? null,
          hasField('detalle'),
          b.detalle ?? null,
          hasField('accion_recomendada'),
          b.accion_recomendada ?? null,
          hasField('responsable_usuario_id'),
          b.responsable_usuario_id ?? null,
          hasField('vence_at'),
          b.vence_at ?? null,
          isResuelta,
          actorId,
          id,
          empresaId,
        ]
      );
      if (!row) return res.status(404).json({ error: 'Incidencia no encontrada' });

      const evento = isResuelta ? 'resuelta' : (estado ? 'estado' : 'actualizada');
      await query(
        `INSERT INTO incidencias_operativas_historial (incidencia_id, empresa_id, evento, payload, actor_usuario_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          row.id,
          empresaId,
          evento,
          JSON.stringify({ before: { estado: before.estado, severidad: before.severidad, responsable_usuario_id: before.responsable_usuario_id, vence_at: before.vence_at }, after: { estado: row.estado, severidad: row.severidad, responsable_usuario_id: row.responsable_usuario_id, vence_at: row.vence_at } }),
          actorId,
        ]
      );

      return res.json({ ok: true, item: row });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error actualizando incidencia' });
    }
  });

  // GET /api/setup/fase3/incidencias/mis-pendientes
  router.get('/fase3/incidencias/mis-pendientes', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const uid = getUserIdForSetup(req);
      if (!uid) return res.status(400).json({ error: 'usuario inválido' });

      const rows = await query(
        `SELECT i.*
         FROM incidencias_operativas i
         WHERE i.empresa_id=$1
           AND i.responsable_usuario_id=$2
           AND i.estado IN ('abierta','en_progreso')
         ORDER BY (CASE WHEN i.vence_at IS NOT NULL AND i.vence_at < NOW() THEN 0 ELSE 1 END),
                  i.severidad='critica' DESC,
                  i.severidad='alta' DESC,
                  i.vence_at NULLS LAST,
                  i.created_at DESC
         LIMIT 100`,
        [empresaId, uid]
      );

      const kpis = {
        total: rows.length,
        sla_vencidas: rows.filter((r) => r.vence_at && new Date(r.vence_at).getTime() < Date.now()).length,
        criticas: rows.filter((r) => String(r.severidad) === 'critica').length,
      };

      return res.json({ ok: true, kpis, items: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo mis pendientes' });
    }
  });

  // GET /api/setup/fase3/incidencias/dashboard
  router.get('/fase3/incidencias/dashboard', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const [k] = await query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE estado='abierta')::int AS abiertas,
           COUNT(*) FILTER (WHERE estado='en_progreso')::int AS en_progreso,
           COUNT(*) FILTER (WHERE estado='resuelta')::int AS resueltas,
           COUNT(*) FILTER (WHERE severidad IN ('alta','critica') AND estado IN ('abierta','en_progreso'))::int AS criticas_activas,
           COUNT(*) FILTER (WHERE vence_at IS NOT NULL AND vence_at < NOW() AND estado IN ('abierta','en_progreso'))::int AS sla_vencidas
         FROM incidencias_operativas
         WHERE empresa_id=$1`,
        [empresaId]
      );
      return res.json({ ok: true, kpis: {
        total: Number(k?.total || 0),
        abiertas: Number(k?.abiertas || 0),
        en_progreso: Number(k?.en_progreso || 0),
        resueltas: Number(k?.resueltas || 0),
        criticas_activas: Number(k?.criticas_activas || 0),
        sla_vencidas: Number(k?.sla_vencidas || 0),
      } });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo dashboard de incidencias' });
    }
  });

  // GET /api/setup/fase3/incidencias/:id/historial
  router.get('/fase3/incidencias/:id/historial', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

      const rows = await query(
        `SELECT h.*, u.username AS actor_username
         FROM incidencias_operativas_historial h
         LEFT JOIN usuarios u ON u.id=h.actor_usuario_id
         WHERE h.empresa_id=$1 AND h.incidencia_id=$2
         ORDER BY h.created_at DESC
         LIMIT 200`,
        [empresaId, id]
      );
      return res.json({ ok: true, items: rows });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo historial de incidencia' });
    }
  });

  // GET /api/setup/fase3/incidencias/alertas
  router.get('/fase3/incidencias/alertas', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });
      const [k] = await query(
        `SELECT
           COUNT(*) FILTER (WHERE severidad='critica' AND estado IN ('abierta','en_progreso'))::int AS criticas_abiertas,
           COUNT(*) FILTER (WHERE vence_at IS NOT NULL AND vence_at < NOW() AND estado IN ('abierta','en_progreso'))::int AS sla_vencidas
         FROM incidencias_operativas
         WHERE empresa_id=$1`,
        [empresaId]
      );
      const items = [];
      const crit = Number(k?.criticas_abiertas || 0);
      const sla = Number(k?.sla_vencidas || 0);
      if (crit > 0) items.push({ nivel:'alta', titulo:'Incidencias críticas activas', detalle:`${crit} incidencias críticas sin resolver.` });
      if (sla > 0) items.push({ nivel:'alta', titulo:'SLA vencido', detalle:`${sla} incidencias vencieron su fecha objetivo.` });
      if (!items.length) items.push({ nivel:'baja', titulo:'Sin alertas críticas', detalle:'No hay incidencias críticas ni SLA vencido.' });
      return res.json({ ok:true, items });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo alertas de incidencias' });
    }
  });

  const normalizePhoneDigits = (v) => String(v || '').replace(/\D+/g, '');
  const normalizeCanalMarketing = (v) => {
    const c = String(v || 'whatsapp').trim().toLowerCase();
    return (c === 'sms' || c === 'ambos') ? c : 'whatsapp';
  };
  const canalIncluyeWhatsApp = (c) => ['whatsapp', 'ambos'].includes(normalizeCanalMarketing(c));
  const canalIncluyeSms = (c) => ['sms', 'ambos'].includes(normalizeCanalMarketing(c));
  const smsIftttEnabled = () => String(process.env.IFTTT_SMS_ENABLED || '0') === '1';

  const renderTemplateMsg = (tpl, ctx = {}) => String(tpl || '')
    .replaceAll('{cliente}', String(ctx.cliente || ''))
    .replaceAll('{rubro}', String(ctx.rubro || ''))
    .replaceAll('{zona}', String(ctx.zona || ''));

  const ensureMarketingTelemetryTable = async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS marketing_envios_telemetria (
        id BIGSERIAL PRIMARY KEY,
        empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        estrategia TEXT NOT NULL,
        canal TEXT NOT NULL,
        telefono TEXT,
        mensaje_hash TEXT,
        estado TEXT NOT NULL,
        proveedor TEXT,
        costo_estimado NUMERIC(12,2),
        detalle_error TEXT,
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_marketing_tel_empresa_fecha ON marketing_envios_telemetria (empresa_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_marketing_tel_estrategia_canal_fecha ON marketing_envios_telemetria (estrategia, canal, created_at DESC)`);
  };

  const ensureMarketingContactosTable = async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS marketing_contactos (
        id BIGSERIAL PRIMARY KEY,
        empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        telefono TEXT NOT NULL,
        telefono_normalizado TEXT NOT NULL,
        lista_nombre TEXT,
        rubro TEXT,
        zona TEXT,
        origen TEXT,
        canal_objetivo TEXT NOT NULL DEFAULT 'whatsapp',
        descripcion TEXT,
        objetivo_campana TEXT,
        context_tag TEXT,
        consent_status TEXT NOT NULL DEFAULT 'unknown',
        consent_source TEXT,
        consent_at TIMESTAMPTZ,
        optout_at TIMESTAMPTZ,
        estado TEXT NOT NULL DEFAULT 'nuevo',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await query(`ALTER TABLE marketing_contactos ADD COLUMN IF NOT EXISTS objetivo_campana TEXT`);
    await query(`ALTER TABLE marketing_contactos ADD COLUMN IF NOT EXISTS context_tag TEXT`);
    await query(`ALTER TABLE marketing_contactos ADD COLUMN IF NOT EXISTS consent_status TEXT NOT NULL DEFAULT 'unknown'`);
    await query(`ALTER TABLE marketing_contactos ADD COLUMN IF NOT EXISTS consent_source TEXT`);
    await query(`ALTER TABLE marketing_contactos ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ`);
    await query(`ALTER TABLE marketing_contactos ADD COLUMN IF NOT EXISTS optout_at TIMESTAMPTZ`);

    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_contactos_unique
      ON marketing_contactos (empresa_id, telefono_normalizado)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_marketing_contactos_filtros
      ON marketing_contactos (empresa_id, rubro, zona, estado, created_at DESC)
    `);
  };

  // GET /api/setup/marketing/config
  router.get('/marketing/config', withAuth, requireSuperMarketing, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const rows = await query(
        `SELECT COALESCE(config_estrategias, '{}'::jsonb) AS config
         FROM empresas
         WHERE id=$1
         LIMIT 1`,
        [empresaId]
      );

      return res.json(rows?.[0]?.config || {});
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo configuración de marketing' });
    }
  });

  // PUT /api/setup/marketing/config
  router.put('/marketing/config', withAuth, requireSuperMarketing, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const b = req.body || {};
      const str = (v, d = '') => {
        const s = String(v ?? d).trim();
        return s;
      };
      const bool = (v) => !!v;
      const posInt = (v, d) => {
        const n = Number.parseInt(v, 10);
        return Number.isFinite(n) && n > 0 ? n : d;
      };
      const num = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
      };
      const canal = (v) => {
        const c = str(v, 'whatsapp').toLowerCase();
        return (c === 'whatsapp' || c === 'sms' || c === 'ambos') ? c : 'whatsapp';
      };

      const referidosProductoRaw = b.referidos_producto_id;
      const referidosProductoId = (referidosProductoRaw === null || referidosProductoRaw === undefined || referidosProductoRaw === '')
        ? null
        : Number.parseInt(referidosProductoRaw, 10);

      const config = {
        vecinos_activado: bool(b.vecinos_activado),
        vecinos_canal: canal(b.vecinos_canal),
        vecinos_mensaje: str(b.vecinos_mensaje, 'Hola {cliente} 👋, el camión está en tu cuadra. Avisame si te dejo algo!'),
        vecinos_radio: posInt(b.vecinos_radio, 200),
        vecinos_dias: posInt(b.vecinos_dias, 7),

        predictivo_activado: bool(b.predictivo_activado),
        predictivo_canal: canal(b.predictivo_canal),
        predictivo_mensaje: str(b.predictivo_mensaje, 'Hola {cliente}, calculo que te queda poca agua. ¿Te llevo mañana?'),

        referidos_activado: bool(b.referidos_activado),
        referidos_canal: canal(b.referidos_canal),
        referidos_producto_id: Number.isFinite(referidosProductoId) && referidosProductoId > 0 ? referidosProductoId : null,
        referidos_cantidad: posInt(b.referidos_cantidad, 1),
        referidos_mensaje: str(b.referidos_mensaje, 'Gracias {cliente}! Link: {link}'),
        referidos_exito_mensaje: str(b.referidos_exito_mensaje, '¡Ganaste un {producto} gratis! Se agrega a tu próximo pedido.'),

        reactivacion_activado: bool(b.reactivacion_activado),
        reactivacion_canal: canal(b.reactivacion_canal),
        reactivacion_dias: posInt(b.reactivacion_dias, 21),
        reactivacion_intentos_max: posInt(b.reactivacion_intentos_max, 3),
        reactivacion_mensaje: str(b.reactivacion_mensaje, 'Hola {cliente}, hace rato no te pedimos 😊 ¿Te llevo agua hoy?'),

        postentrega_activado: bool(b.postentrega_activado),
        postentrega_canal: canal(b.postentrega_canal),
        postentrega_horas: posInt(b.postentrega_horas, 4),
        postentrega_producto: str(b.postentrega_producto, ''),
        postentrega_mensaje: str(b.postentrega_mensaje, 'Hola {cliente}, ¿todo bien con la entrega? Si querés te sumo {producto} para mañana.'),

        clima_activado: bool(b.clima_activado),
        clima_canal: canal(b.clima_canal),
        clima_temp_alta: num(b.clima_temp_alta, 30),
        clima_temp_baja: num(b.clima_temp_baja, 8),
        clima_mensaje_calor: str(b.clima_mensaje_calor, 'Se viene calor hoy 🔥 ¿Te llevo agua antes de que te quedes sin stock?'),
        clima_mensaje_frio: str(b.clima_mensaje_frio, 'Hoy está feo para salir 🌧️ Si querés te lo llevo a domicilio.'),

        vip_activado: bool(b.vip_activado),
        vip_canal: canal(b.vip_canal),
        vip_pedidos_min: posInt(b.vip_pedidos_min, 10),
        vip_beneficio: str(b.vip_beneficio, ''),
        vip_mensaje: str(b.vip_mensaje, '¡{cliente}, ya sos VIP! 🎉 Desde ahora tenés: {beneficio}.'),

        import_lista_nombre: str(b.import_lista_nombre, ''),
        import_rubro: str(b.import_rubro, ''),
        import_zona: str(b.import_zona, ''),
        import_origen: str(b.import_origen, 'callejero'),
        import_canal_objetivo: canal(b.import_canal_objetivo),
        import_objetivo_campana: str(b.import_objetivo_campana, 'nuevos_clientes'),
        import_context_tag: str(b.import_context_tag, ''),
        import_consent_status: ['granted', 'denied', 'unknown'].includes(String(b.import_consent_status || '').toLowerCase()) ? String(b.import_consent_status).toLowerCase() : 'unknown',
        import_consent_at: str(b.import_consent_at, ''),
        import_descripcion: str(b.import_descripcion, ''),

        launch_canal: canal(b.launch_canal || b.import_canal_objetivo),
        launch_max_envios: posInt(b.launch_max_envios, 100),
        launch_frecuencia_horas: posInt(b.launch_frecuencia_horas, 24),
        launch_mensaje: str(b.launch_mensaje, ''),
        auto_launch_activado: bool(b.auto_launch_activado),
        auto_launch_franjas: str(b.auto_launch_franjas, '09:00-12:00,16:00-20:00'),
        auto_launch_dias: str(b.auto_launch_dias, '1,2,3,4,5,6'),
        auto_launch_intervalo_min: posInt(b.auto_launch_intervalo_min, 15),
      };

      await query(
        `UPDATE empresas
         SET config_estrategias = $1
         WHERE id = $2`,
        [JSON.stringify(config), empresaId]
      );

      return res.json({ ok: true, config });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error guardando configuración de marketing' });
    }
  });

  // POST /api/setup/marketing/base/preview
  router.post('/marketing/base/preview', withAuth, requireSuperMarketing, async (req, res) => {
    try {
      const telefonosIn = Array.isArray(req.body?.telefonos) ? req.body.telefonos : [];
      if (!telefonosIn.length) return res.status(400).json({ error: 'No se recibieron teléfonos para previsualizar' });

      let validos = 0;
      let invalidos = 0;
      let duplicadosArchivo = 0;
      const seen = new Set();

      for (const raw of telefonosIn) {
        const d = normalizePhoneDigits(raw);
        if (d.length < 8 || d.length > 15) {
          invalidos += 1;
          continue;
        }
        validos += 1;
        if (seen.has(d)) duplicadosArchivo += 1;
        else seen.add(d);
      }

      return res.json({
        ok: true,
        resumen: {
          recibidos: telefonosIn.length,
          validos,
          invalidos,
          duplicados_archivo: duplicadosArchivo,
          unicos_archivo: seen.size
        }
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error calculando preview de base' });
    }
  });

  // POST /api/setup/marketing/base/import
  router.post('/marketing/base/import', withAuth, requireSuperMarketing, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      await ensureMarketingContactosTable();

      const b = req.body || {};
      const listaNombre = String(b.lista_nombre || '').trim();
      const rubro = String(b.rubro || '').trim();
      const zona = String(b.zona || '').trim();
      const origen = String(b.origen || 'callejero').trim();
      const descripcion = String(b.descripcion || '').trim();
      const objetivoCampana = String(b.objetivo_campana || '').trim();
      const contextTag = String(b.context_tag || '').trim();
      const consentStatusIn = String(b.consent_status || '').toLowerCase();
      const consentStatus = ['granted', 'denied', 'unknown'].includes(consentStatusIn) ? consentStatusIn : 'unknown';
      const consentSource = String(b.consent_source || '').trim();
      const consentAtRaw = b.consent_at ? new Date(b.consent_at) : null;
      const consentAt = consentAtRaw instanceof Date && !Number.isNaN(consentAtRaw.getTime()) ? consentAtRaw.toISOString() : null;
      const canalRaw = String(b.canal_objetivo || 'whatsapp').toLowerCase();
      const canalObjetivo = (canalRaw === 'sms' || canalRaw === 'ambos' || canalRaw === 'whatsapp') ? canalRaw : 'whatsapp';

      if (!listaNombre) return res.status(400).json({ error: 'lista_nombre requerido' });
      if (!rubro) return res.status(400).json({ error: 'rubro requerido' });
      if (!contextTag) return res.status(400).json({ error: 'context_tag requerido' });

      const telefonosIn = Array.isArray(b.telefonos) ? b.telefonos : [];
      if (!telefonosIn.length) return res.status(400).json({ error: 'No se recibieron teléfonos para importar' });

      let validos = 0;
      let invalidos = 0;
      let duplicadosArchivo = 0;
      let insertados = 0;
      let existentes = 0;

      const seen = new Set();
      const cleaned = [];
      for (const raw of telefonosIn) {
        const d = normalizePhoneDigits(raw);
        if (d.length < 8 || d.length > 15) {
          invalidos += 1;
          continue;
        }
        validos += 1;
        if (seen.has(d)) {
          duplicadosArchivo += 1;
          continue;
        }
        seen.add(d);
        cleaned.push(d);
      }

      for (const tel of cleaned) {
        const estadoInicial = consentStatus === 'granted' ? 'ready' : 'validated';
        const rows = await query(
          `INSERT INTO marketing_contactos
             (empresa_id, telefono, telefono_normalizado, lista_nombre, rubro, zona, origen, canal_objetivo, descripcion, objetivo_campana, context_tag, consent_status, consent_source, consent_at, estado, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
           ON CONFLICT (empresa_id, telefono_normalizado)
           DO UPDATE SET
             lista_nombre = EXCLUDED.lista_nombre,
             rubro = EXCLUDED.rubro,
             zona = EXCLUDED.zona,
             origen = EXCLUDED.origen,
             canal_objetivo = EXCLUDED.canal_objetivo,
             descripcion = EXCLUDED.descripcion,
             objetivo_campana = EXCLUDED.objetivo_campana,
             context_tag = EXCLUDED.context_tag,
             consent_status = EXCLUDED.consent_status,
             consent_source = EXCLUDED.consent_source,
             consent_at = EXCLUDED.consent_at,
             estado = CASE
               WHEN marketing_contactos.estado = 'opted_out' THEN marketing_contactos.estado
               ELSE EXCLUDED.estado
             END,
             updated_at = NOW()
           RETURNING (xmax = 0) AS inserted`,
          [
            empresaId,
            tel,
            tel,
            listaNombre,
            rubro,
            zona || null,
            origen || null,
            canalObjetivo,
            descripcion || null,
            objetivoCampana || null,
            contextTag,
            consentStatus,
            consentSource || null,
            consentAt,
            estadoInicial
          ]
        );

        if (rows[0]?.inserted) insertados += 1;
        else existentes += 1;
      }

      return res.json({
        ok: true,
        resumen: {
          recibidos: telefonosIn.length,
          validos,
          invalidos,
          duplicados_archivo: duplicadosArchivo,
          unicos_archivo: cleaned.length,
          insertados,
          existentes
        }
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error importando base de contactos' });
    }
  });

  // GET /api/setup/marketing/base/list
  router.get('/marketing/base/list', withAuth, requireSuperMarketing, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      await ensureMarketingContactosTable();

      const rows = await query(
        `SELECT
           lista_nombre,
           rubro,
           COALESCE(zona, '') AS zona,
           COALESCE(origen, '') AS origen,
           canal_objetivo,
           COUNT(*)::int AS total,
           MAX(created_at) AS ultima_carga
         FROM marketing_contactos
         WHERE empresa_id = $1
         GROUP BY lista_nombre, rubro, zona, origen, canal_objetivo
         ORDER BY ultima_carga DESC
         LIMIT 200`,
        [empresaId]
      );

      return res.json({ ok: true, items: rows || [] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error listando bases de contactos' });
    }
  });

  // GET /api/setup/marketing/base/quality-summary
  router.get('/marketing/base/quality-summary', withAuth, requireSuperMarketing, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      await ensureMarketingContactosTable();

      const [row] = await query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE estado='ready')::int AS ready,
           COUNT(*) FILTER (WHERE estado='opted_out')::int AS opted_out,
           COUNT(*) FILTER (WHERE consent_status='granted')::int AS consentidos,
           COUNT(*) FILTER (WHERE consent_status<>'granted')::int AS sin_consentimiento,
           COUNT(*) FILTER (WHERE telefono_normalizado !~ '^\\d{8,15}$')::int AS invalidos
         FROM marketing_contactos
         WHERE empresa_id = $1`,
        [empresaId]
      );

      return res.json({ ok: true, resumen: row || {} });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo resumen de calidad' });
    }
  });

  // PATCH /api/setup/marketing/base/contact/:id/status
  router.patch('/marketing/base/contact/:id/status', withAuth, requireSuperMarketing, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      await ensureMarketingContactosTable();

      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

      const estadoIn = String(req.body?.estado || '').toLowerCase();
      const allowed = new Set(['new', 'validated', 'ready', 'contacted', 'replied', 'opted_out', 'invalid']);
      if (!allowed.has(estadoIn)) return res.status(400).json({ error: 'estado inválido' });

      const rows = await query(
        `UPDATE marketing_contactos
         SET estado = $1,
             optout_at = CASE WHEN $1='opted_out' THEN NOW() ELSE optout_at END,
             updated_at = NOW()
         WHERE id = $2 AND empresa_id = $3
         RETURNING id, estado, updated_at`,
        [estadoIn, id, empresaId]
      );

      if (!rows.length) return res.status(404).json({ error: 'Contacto no encontrado' });
      return res.json({ ok: true, item: rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error actualizando estado de contacto' });
    }
  });

  // POST /api/setup/marketing/base/contact/:id/optout
  router.post('/marketing/base/contact/:id/optout', withAuth, requireSuperMarketing, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      await ensureMarketingContactosTable();

      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

      const rows = await query(
        `UPDATE marketing_contactos
         SET estado='opted_out', consent_status='denied', optout_at=NOW(), updated_at=NOW()
         WHERE id = $1 AND empresa_id = $2
         RETURNING id, estado, consent_status, optout_at`,
        [id, empresaId]
      );

      if (!rows.length) return res.status(404).json({ error: 'Contacto no encontrado' });
      return res.json({ ok: true, item: rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error aplicando opt-out' });
    }
  });

  // POST /api/setup/marketing/base/launch
  router.post('/marketing/base/launch', withAuth, requireSuperMarketing, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req, { fromBody: true });
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      await ensureMarketingContactosTable();
      await ensureMarketingTelemetryTable();

      const b = req.body || {};
      const listaNombre = String(b.lista_nombre || '').trim();
      const rubro = String(b.rubro || '').trim();
      const zona = String(b.zona || '').trim();
      const canal = normalizeCanalMarketing(b.canal || 'whatsapp');
      const estrategia = 'base_importada';
      const mensajeTpl = String(b.mensaje || '').trim();
      const maxEnvios = Math.min(Math.max(Number(b.max_envios || 100), 1), 1000);
      const frecuenciaHoras = Math.min(Math.max(Number(b.frecuencia_horas || 24), 1), 24 * 30);
      const dryRun = !!b.dry_run;

      const selectBaseImportadaCandidates = async ({ promoteToReady = true } = {}) => {
        const filtrosBase = [
          'mc.empresa_id = $1',
          "COALESCE(mc.consent_status,'unknown')='granted'",
          'mc.optout_at IS NULL',
          "COALESCE(mc.estado, 'new') NOT IN ('opted_out','invalid')"
        ];
        const paramsBase = [empresaId];
        let idxBase = 2;

        if (listaNombre) { filtrosBase.push(`mc.lista_nombre = $${idxBase++}`); paramsBase.push(listaNombre); }
        if (rubro) { filtrosBase.push(`mc.rubro = $${idxBase++}`); paramsBase.push(rubro); }
        if (zona) { filtrosBase.push(`mc.zona = $${idxBase++}`); paramsBase.push(zona); }

        paramsBase.push(frecuenciaHoras);
        const freqIdxBase = idxBase++;

        const recentClause = `NOT EXISTS (
          SELECT 1
          FROM marketing_envios_telemetria t
          WHERE t.empresa_id = mc.empresa_id
            AND t.estrategia = '${estrategia}'
            AND t.telefono = mc.telefono_normalizado
            AND t.created_at > NOW() - ($${freqIdxBase}::text || ' hours')::interval
        )`;

        if (!promoteToReady) {
          const previewParams = [...paramsBase, maxEnvios];
          const previewLimitIdx = idxBase;
          return query(
            `SELECT mc.id, mc.telefono, mc.rubro, mc.zona, mc.lista_nombre
             FROM marketing_contactos mc
             WHERE ${filtrosBase.join(' AND ')}
               AND ${recentClause}
             ORDER BY
               CASE
                 WHEN mc.estado IN ('ready','replied') THEN 0
                 WHEN mc.estado = 'validated' THEN 1
                 WHEN mc.estado IN ('new','nuevo') THEN 2
                 WHEN mc.estado = 'contacted' THEN 3
                 ELSE 9
               END,
               mc.updated_at ASC,
               mc.id ASC
             LIMIT $${previewLimitIdx}`,
            previewParams
          );
        }

        const readyCountRows = await query(
          `SELECT COUNT(*)::int AS total
           FROM marketing_contactos mc
           WHERE ${filtrosBase.join(' AND ')}
             AND mc.estado IN ('ready','replied')
             AND ${recentClause}`,
          paramsBase
        );

        const readyDisponibles = Number(readyCountRows?.[0]?.total || 0);
        const faltan = Math.max(0, maxEnvios - readyDisponibles);

        if (faltan > 0) {
          const refillParams = [...paramsBase, faltan];
          const refillLimitIdx = idxBase;
          const refillRows = await query(
            `SELECT mc.id
             FROM marketing_contactos mc
             WHERE ${filtrosBase.join(' AND ')}
               AND COALESCE(mc.estado, 'new') NOT IN ('ready','replied','opted_out','invalid')
               AND ${recentClause}
             ORDER BY
               CASE
                 WHEN mc.estado = 'validated' THEN 0
                 WHEN mc.estado IN ('new','nuevo') THEN 1
                 WHEN mc.estado = 'contacted' THEN 2
                 ELSE 9
               END,
               mc.updated_at ASC,
               mc.id ASC
             LIMIT $${refillLimitIdx}`,
            refillParams
          );

          if (refillRows.length) {
            await query(
              `UPDATE marketing_contactos
               SET estado = 'ready', updated_at = NOW()
               WHERE empresa_id = $1
                 AND id = ANY($2::bigint[])`,
              [empresaId, refillRows.map((r) => Number(r.id)).filter(Boolean)]
            );
          }
        }

        const finalParams = [...paramsBase, maxEnvios];
        const limitIdxBase = idxBase;

        return query(
          `SELECT mc.id, mc.telefono, mc.rubro, mc.zona, mc.lista_nombre
           FROM marketing_contactos mc
           WHERE ${filtrosBase.join(' AND ')}
             AND mc.estado IN ('ready','replied')
             AND ${recentClause}
           ORDER BY
             CASE WHEN mc.estado = 'replied' THEN 0 ELSE 1 END,
             mc.updated_at DESC,
             mc.id DESC
           LIMIT $${limitIdxBase}`,
          finalParams
        );
      };

      if (!dryRun && !mensajeTpl) return res.status(400).json({ error: 'mensaje requerido' });
      if (mensajeTpl.length > 280) return res.status(400).json({ error: 'mensaje supera 280 caracteres' });

      const rows = await selectBaseImportadaCandidates({ promoteToReady: !dryRun });

      if (dryRun) {
        return res.json({ ok: true, dry_run: true, candidatos: rows.length });
      }

      let enviados = 0;
      let omitidos = 0;
      let errores = 0;

      for (const c of rows) {
        const tel = normalizePhoneDigits(c.telefono);
        const msg = renderTemplateMsg(mensajeTpl, { cliente: '', rubro: c.rubro, zona: c.zona });
        let envioOk = false;
        let detalleError = null;

        try {
          if (canalIncluyeWhatsApp(canal)) {
            await enqueueWppMessage({ phone: tel, message: msg, empresa_id: empresaId });
            envioOk = true;
          }
          if (canalIncluyeSms(canal)) {
            if (!smsIftttEnabled()) {
              detalleError = 'IFTTT_SMS_ENABLED=0';
            } else {
              const sms = await sendSmsViaIfttt({ phone: tel, message: msg });
              if (sms?.ok) envioOk = true;
              else detalleError = sms?.reason || sms?.error || 'sms_error';
            }
          }
        } catch (e) {
          detalleError = e?.message || 'send_error';
        }

        await query(
          `INSERT INTO marketing_envios_telemetria
            (empresa_id, estrategia, canal, telefono, mensaje_hash, estado, proveedor, detalle_error, meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            empresaId,
            estrategia,
            canal,
            tel,
            `manual_${Date.now()}`,
            envioOk ? 'queued' : 'error',
            canalIncluyeSms(canal) ? 'ifttt_sms/wpp' : 'whatsapp-web.js',
            detalleError,
            JSON.stringify({ contacto_id: c.id, lista_nombre: c.lista_nombre, rubro: c.rubro, zona: c.zona, mensaje: msg })
          ]
        );

        if (envioOk) {
          enviados += 1;
          await query(`UPDATE marketing_contactos SET estado='contacted', updated_at=NOW() WHERE id=$1 AND empresa_id=$2`, [c.id, empresaId]);
        } else {
          errores += 1;
        }
      }

      omitidos = Math.max(0, maxEnvios - rows.length);
      return res.json({ ok: true, total_candidatos: rows.length, enviados, errores, omitidos });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error lanzando campaña de base importada' });
    }
  });

  // GET /api/setup/marketing/detalle
  router.get('/marketing/detalle', withAuth, requireSuperMarketing, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const dias = Math.min(Math.max(Number(req.query?.dias || 7), 1), 90);
      const limit = Math.min(Math.max(Number(req.query?.limit || 150), 1), 1000);
      const ventanaHoras = Math.min(Math.max(Number(req.query?.ventana_horas || 72), 1), 24 * 14);

      const rows = await query(
        `SELECT
           t.id,
           t.created_at,
           t.estrategia,
           t.canal,
           t.estado,
           t.telefono,
           t.proveedor,
           t.costo_estimado,
           t.detalle_error,
           t.meta,
           COALESCE(pe.id, NULLIF(t.meta->>'cliente_id','')::int) AS cliente_id,
           COALESCE(pe.cliente, NULLIF(t.meta->>'cliente','')) AS cliente,
           COALESCE(pe.direccion, NULLIF(t.meta->>'direccion','')) AS direccion,
           pe.ciudad,
           COALESCE(pe.latitud, NULLIF(t.meta->>'latitud','')::numeric) AS cliente_lat,
           COALESCE(pe.longitud, NULLIF(t.meta->>'longitud','')::numeric) AS cliente_lng,
           conv.pedido_id AS conversion_pedido_id,
           conv.fecha AS conversion_fecha,
           CASE WHEN conv.pedido_id IS NULL THEN FALSE ELSE TRUE END AS convirtio
         FROM marketing_envios_telemetria t
         LEFT JOIN LATERAL (
           SELECT p.id, p.cliente, p.direccion, p.ciudad, p.latitud, p.longitud
           FROM puntos_entrega p
           WHERE p.empresa_id = t.empresa_id
             AND (
               (NULLIF(t.meta->>'cliente_id','') IS NOT NULL AND p.id = NULLIF(t.meta->>'cliente_id','')::int)
               OR regexp_replace(COALESCE(p.telefono, ''), '\\D', '', 'g') = regexp_replace(COALESCE(t.telefono, ''), '\\D', '', 'g')
               OR right(regexp_replace(COALESCE(p.telefono, ''), '\\D', '', 'g'), 8) = right(regexp_replace(COALESCE(t.telefono, ''), '\\D', '', 'g'), 8)
             )
           ORDER BY
             CASE WHEN NULLIF(t.meta->>'cliente_id','') IS NOT NULL AND p.id = NULLIF(t.meta->>'cliente_id','')::int THEN 0 ELSE 1 END,
             p.id DESC
           LIMIT 1
         ) pe ON TRUE
         LEFT JOIN LATERAL (
           SELECT p2.id AS pedido_id, p2.fecha
           FROM pedidos p2
           WHERE p2.empresa_id = t.empresa_id
             AND pe.id IS NOT NULL
             AND p2.punto_entrega_id = pe.id
             AND p2.fecha >= t.created_at
             AND p2.fecha <= t.created_at + ($3::text || ' hours')::interval
           ORDER BY p2.fecha ASC
           LIMIT 1
         ) conv ON TRUE
         WHERE t.empresa_id = $1
           AND t.created_at >= NOW() - ($2::text || ' days')::interval
         ORDER BY t.created_at DESC
         LIMIT $4`,
        [empresaId, dias, ventanaHoras, limit]
      );

      return res.json({
        ok: true,
        periodo_dias: dias,
        total: Number(rows?.length || 0),
        items: (rows || []).map((r) => ({
          id: Number(r.id),
          created_at: r.created_at,
          estrategia: r.estrategia,
          canal: r.canal,
          estado: r.estado,
          telefono: r.telefono,
          proveedor: r.proveedor,
          costo_estimado: Number(r.costo_estimado || 0),
          detalle_error: r.detalle_error,
          meta: r.meta || {},
          mensaje: (r.meta && (r.meta.mensaje || r.meta.message)) ? String(r.meta.mensaje || r.meta.message) : null,
          cliente_id: r.cliente_id ? Number(r.cliente_id) : null,
          cliente: r.cliente || null,
          direccion: r.direccion || null,
          ciudad: r.ciudad || null,
          cliente_lat: r.cliente_lat == null ? null : Number(r.cliente_lat),
          cliente_lng: r.cliente_lng == null ? null : Number(r.cliente_lng),
          convirtio: !!r.convirtio,
          conversion_pedido_id: r.conversion_pedido_id ? Number(r.conversion_pedido_id) : null,
          conversion_fecha: r.conversion_fecha || null,
        })),
      });
    } catch (e) {
      if (String(e?.message || '').toLowerCase().includes('marketing_envios_telemetria')) {
        return res.json({ ok: true, periodo_dias: 0, total: 0, items: [] });
      }
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo detalle de marketing' });
    }
  });

  // GET /api/setup/marketing/telemetria
  router.get('/marketing/telemetria', withAuth, requireSuperMarketing, async (req, res) => {
    try {
      const empresaId = resolveEmpresaIdForSetup(req);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido para super admin' });

      const dias = Math.min(Math.max(Number(req.query?.dias || 7), 1), 90);

      const resumen = await query(
        `SELECT
           canal,
           estrategia,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE estado IN ('sent','queued'))::int AS exitosos,
           COUNT(*) FILTER (WHERE estado IN ('failed','error'))::int AS fallidos,
           COUNT(*) FILTER (WHERE estado = 'skipped')::int AS omitidos,
           COALESCE(SUM(costo_estimado),0)::numeric AS costo_total
         FROM marketing_envios_telemetria
         WHERE empresa_id = $1
           AND created_at >= NOW() - ($2::text || ' days')::interval
         GROUP BY canal, estrategia
         ORDER BY total DESC, estrategia ASC`,
        [empresaId, dias]
      );

      const totales = await query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE estado IN ('sent','queued'))::int AS exitosos,
           COUNT(*) FILTER (WHERE estado IN ('failed','error'))::int AS fallidos,
           COALESCE(SUM(costo_estimado),0)::numeric AS costo_total
         FROM marketing_envios_telemetria
         WHERE empresa_id = $1
           AND created_at >= NOW() - ($2::text || ' days')::interval`,
        [empresaId, dias]
      );

      return res.json({
        ok: true,
        periodo_dias: dias,
        totales: {
          total: Number(totales?.[0]?.total || 0),
          exitosos: Number(totales?.[0]?.exitosos || 0),
          fallidos: Number(totales?.[0]?.fallidos || 0),
          costo_total: Number(totales?.[0]?.costo_total || 0),
        },
        items: (resumen || []).map((r) => ({
          canal: r.canal,
          estrategia: r.estrategia,
          total: Number(r.total || 0),
          exitosos: Number(r.exitosos || 0),
          fallidos: Number(r.fallidos || 0),
          omitidos: Number(r.omitidos || 0),
          costo_total: Number(r.costo_total || 0),
        })),
      });
    } catch (e) {
      if (String(e?.message || '').toLowerCase().includes('marketing_envios_telemetria')) {
        return res.json({ ok: true, periodo_dias: 0, totales: { total: 0, exitosos: 0, fallidos: 0, costo_total: 0 }, items: [] });
      }
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo telemetría de marketing' });
    }
  });

  return router;
}
