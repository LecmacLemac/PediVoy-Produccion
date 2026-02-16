// src/routes/setup.js
// Onboarding / configuración inicial (extraído desde server.js)

import express from 'express';

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

  return router;
}
