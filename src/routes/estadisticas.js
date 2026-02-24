// src/routes/estadisticas.js
import express from 'express';
import { withAuth, checkLicencia, isSuper, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';

export function createEstadisticasRouter() {
  const router = express.Router();

  // GET /api/estadisticas/dashboard
  router.get('/dashboard', withAuth, checkLicencia, async (req, res) => {
    try {
      const { from, to, empresa_id, chofer_id } = req.query;
      const esSuperUser = isSuper(req);
      const targetEmpresa = (esSuperUser && empresa_id) ? Number(empresa_id) : getEmpresaIdFromToken(req);

      if (!targetEmpresa) {
        return res.status(400).json({ error: 'Empresa no detectada' });
      }

      const choferIdParam = chofer_id ? Number(chofer_id) : null;

      function daysBetweenInclusive(fromISO, toISO) {
        const a = new Date(fromISO + 'T00:00:00');
        const b = new Date(toISO + 'T00:00:00');
        const ms = b - a;
        const days = Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
        return Math.max(days, 1);
      }

      function addDaysISO(iso, deltaDays) {
        const d = new Date(iso + 'T00:00:00');
        d.setDate(d.getDate() + deltaDays);
        // YYYY-MM-DD
        return d.toISOString().slice(0, 10);
      }

      async function computeDashboard(dateFromISO, dateToISO) {
        const dateFrom = dateFromISO || '2000-01-01';
        const dateTo = (dateToISO || '2100-12-31') + ' 23:59:59';

        const sqlDaily = `
          WITH daily_data AS (
            SELECT
              p.chofer_id,
              (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS fecha_dia,
              COUNT(DISTINCT p.id) as pedidos,
              COALESCE(SUM(p.monto), 0) as ventas,
              COALESCE(
                SUM((SELECT SUM(cantidad) FROM items_pedido it WHERE it.pedido_id = p.id)),
                0
              ) as unidades
            FROM pedidos p
            JOIN puntos_entrega pe
              ON pe.id = p.punto_entrega_id
             AND pe.empresa_id = $1
            WHERE p.estado = 'entregado'
              AND p.empresa_id = $1
              AND COALESCE(p.fecha_entrega, p.fecha) >= $2 AND COALESCE(p.fecha_entrega, p.fecha) <= $3
              AND ($4::int IS NULL OR p.chofer_id = $4)
            GROUP BY 1, 2
          )
          SELECT
            dd.*,
            COALESCE((
              SELECT cet.monto
              FROM chofer_escalas ce
              JOIN chofer_escala_tramos cet ON ce.id = cet.escala_id
              WHERE (ce.chofer_id = dd.chofer_id OR ce.chofer_id IS NULL)
                AND ce.empresa_id = $1
                AND ce.vigente_desde <= dd.fecha_dia
                AND (ce.vigente_hasta IS NULL OR ce.vigente_hasta >= dd.fecha_dia)
                AND dd.unidades >= cet.rango_min
                AND (cet.rango_max IS NULL OR dd.unidades <= cet.rango_max)
              ORDER BY (ce.chofer_id IS NOT NULL) DESC, ce.vigente_desde DESC, cet.rango_min DESC
              LIMIT 1
            ), 0) as costo_var_dia
          FROM daily_data dd
        `;

        const sqlProdCosts = `
          SELECT chofer_id, SUM(monto) as costo_prod
          FROM gastos_repartidor
          WHERE empresa_id = $1
            AND fecha >= $2 AND fecha <= $3
            AND tipo IN ('carga_llenos', 'compra_mercaderia')
            AND ($4::int IS NULL OR chofer_id = $4)
          GROUP BY 1
        `;

        const sqlFixedCosts = `
          SELECT chofer_id, SUM(monto) as gastos
          FROM gastos_repartidor
          WHERE empresa_id = $1
            AND fecha >= $2 AND fecha <= $3
            AND tipo NOT IN ('carga_llenos', 'compra_mercaderia', 'descarga_vacios', 'stock')
            AND ($4::int IS NULL OR chofer_id = $4)
          GROUP BY 1
        `;

        const sqlTopProducts = `
          SELECT
            it.producto AS producto,
            SUM(it.cantidad) AS cantidad,
            SUM(it.cantidad * it.precio_unitario) AS ventas
          FROM items_pedido it
          JOIN pedidos p
            ON p.id = it.pedido_id
           AND p.empresa_id = $1
          JOIN puntos_entrega pe
            ON pe.id = p.punto_entrega_id
           AND pe.empresa_id = $1
          WHERE p.estado = 'entregado'
            AND COALESCE(p.fecha_entrega, p.fecha) >= $2 AND COALESCE(p.fecha_entrega, p.fecha) <= $3
            AND ($4::int IS NULL OR p.chofer_id = $4)
          GROUP BY it.producto
        `;

        const [dailyRes, prodRes, fixedRes, choferesRes, topProdRes] = await Promise.all([
          query(sqlDaily,      [targetEmpresa, dateFrom, dateTo, choferIdParam]),
          query(sqlProdCosts,  [targetEmpresa, dateFrom, dateTo, choferIdParam]),
          query(sqlFixedCosts, [targetEmpresa, dateFrom, dateTo, choferIdParam]),
          query('SELECT id, nombre, tipo FROM choferes WHERE empresa_id=$1', [targetEmpresa]),
          query(sqlTopProducts,[targetEmpresa, dateFrom, dateTo, choferIdParam]),
        ]);

        const choferCostMap = new Map();

        const report = (choferesRes || []).map(c => {
          const id = Number(c.id);
          const dayRows  = (dailyRes || []).filter(d => Number(d.chofer_id) === id);
          const prodRow  = (prodRes  || []).find(r => Number(r.chofer_id) === id);
          const fixedRow = (fixedRes || []).find(r => Number(r.chofer_id) === id);

          const ventas = dayRows.reduce((a, b) => a + Number(b.ventas || 0), 0);
          const cv     = dayRows.reduce((a, b) => a + Number(b.costo_var_dia || 0), 0);
          const cp     = Number(prodRow?.costo_prod || 0);
          const cf     = Number(fixedRow?.gastos || 0);
          const rent   = ventas - cv - cp - cf;

          choferCostMap.set(id, { ventasTotal: ventas, cp, cf });

          return {
            id,
            chofer: c.nombre,
            tipo: c.tipo,
            pedidos:  dayRows.reduce((a, b) => a + Number(b.pedidos  || 0), 0),
            unidades: dayRows.reduce((a, b) => a + Number(b.unidades || 0), 0),
            ventas, cv, cp, cf, rent,
            margen: ventas ? (rent / ventas * 100) : 0
          };
        }).filter(r => r.pedidos > 0 || r.cp > 0 || r.cf > 0);

        const products = (topProdRes || []).map(r => ({
          producto: r.producto,
          cantidad: Number(r.cantidad) || 0,
          ventas:   Number(r.ventas)   || 0
        }));

        const evoMap = new Map();
        (dailyRes || []).forEach(row => {
          const choferId = Number(row.chofer_id);
          const fechaKey = String(row.fecha_dia);
          const ventasDia = Number(row.ventas || 0);
          const cvDia = Number(row.costo_var_dia || 0);

          const costosChofer = choferCostMap.get(choferId) || { ventasTotal: 0, cp: 0, cf: 0 };

          let cpAlloc = 0, cfAlloc = 0;
          if (ventasDia > 0 && costosChofer.ventasTotal > 0) {
            const ratio = ventasDia / costosChofer.ventasTotal;
            cpAlloc = costosChofer.cp * ratio;
            cfAlloc = costosChofer.cf * ratio;
          }

          const rentDia = ventasDia - cvDia - cpAlloc - cfAlloc;

          const prev = evoMap.get(fechaKey) || { fecha: fechaKey, ventas: 0, rent: 0 };
          prev.ventas += ventasDia;
          prev.rent += rentDia;
          evoMap.set(fechaKey, prev);
        });

        const evolution = Array.from(evoMap.values())
          .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

        // summary para comparativas
        const sum = k => report.reduce((a, b) => a + Number(b[k] || 0), 0);
        const ventas = sum('ventas');
        const cv = sum('cv');
        const cf = sum('cf');
        const cp = sum('cp');
        const pedidos = sum('pedidos');
        const rent = ventas - cv - cf - cp;
        const ticket = pedidos ? ventas / pedidos : 0;

        return { report, products, evolution, summary: { from: dateFromISO, to: dateToISO, ventas, rent, ticket } };
      }

      const cur = await computeDashboard(from || '2000-01-01', to || '2100-12-31');

      // Prev período: mismo largo
      const len = daysBetweenInclusive(from || '2000-01-01', to || '2100-12-31');
      const prevTo = addDaysISO(from || '2000-01-01', -1);
      const prevFrom = addDaysISO(prevTo, -(len - 1));
      const prev = await computeDashboard(prevFrom, prevTo);

      return res.json({
        report: cur.report,
        products: cur.products,
        evolution: cur.evolution,
        prev: prev.summary
      });

    } catch (e) {
      console.error('DASHBOARD ERROR:', e);
      return res.status(500).json({ error: 'Error en el cálculo de estadísticas' });
    }
  });

  return router;
}
