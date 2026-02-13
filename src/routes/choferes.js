// src/routes/choferes.js
// Choferes (CRUD) + costos + escalas + tramos (extraído desde server.js)

import express from 'express';

export function createChoferesRouter(deps) {
  const { query, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createChoferesRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createChoferesRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createChoferesRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createChoferesRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

  // --------------------------------------------------
  // CHOFERES (CRUD)
  // --------------------------------------------------

  router.get('/choferes', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const empresaTarget = esSuperAdmin ? (Number(req.query?.empresa_id) || null) : getEmpresaIdFromToken(req);
      if (!empresaTarget && !esSuperAdmin) return res.status(400).json({ error: 'Empresa requerida' });

      let sql = `SELECT id, nombre, telefono, email, tipo, sla_horas FROM choferes`;
      const params = [];
      if (empresaTarget) {
        sql += ` WHERE empresa_id=$1`;
        params.push(empresaTarget);
      }
      sql += ` ORDER BY nombre ASC`;

      const rows = await query(sql, params);
      return res.json(rows);
    } catch {
      return res.status(500).json({ error: 'Error obteniendo choferes' });
    }
  });

  router.post('/choferes', withAuth, async (req, res) => {
    try {
      const { nombre, telefono, email, tipo, sla_horas, empresa_id } = req.body || {};
      const esSuperAdmin = isSuper(req);
      const finalEmpresaId = esSuperAdmin && empresa_id ? Number(empresa_id) : getEmpresaIdFromToken(req);

      const rows = await query(
        `INSERT INTO choferes (empresa_id, nombre, telefono, email, tipo, sla_horas)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [finalEmpresaId, nombre, telefono, email, tipo || 'propio', sla_horas]
      );

      return res.json(rows[0]);
    } catch {
      return res.status(500).json({ error: 'Error creando chofer' });
    }
  });

  router.put('/choferes/:id', withAuth, async (req, res) => {
    try {
      const { nombre, telefono, email, tipo, sla_horas } = req.body || {};
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        `UPDATE choferes
            SET nombre=$1, telefono=$2, email=$3, tipo=$4, sla_horas=$5
          WHERE id=$6
            AND ($7::int IS NULL OR empresa_id=$7)
        RETURNING id`,
        [nombre, telefono, email, tipo, sla_horas, req.params.id, esSuperAdmin ? null : Number(myEmpresa)]
      );

      if (!rows.length) return res.status(404).json({ error: 'Chofer no encontrado o sin permiso' });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error actualizando chofer' });
    }
  });

  router.delete('/choferes/:id', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        `DELETE FROM choferes
          WHERE id=$1
            AND ($2::int IS NULL OR empresa_id=$2)
        RETURNING id`,
        [req.params.id, esSuperAdmin ? null : Number(myEmpresa)]
      );

      if (!rows.length) return res.status(404).json({ error: 'Chofer no encontrado o sin permiso' });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error eliminando chofer' });
    }
  });

  // --------------------------------------------------
  // COSTOS (Tabla: chofer_costos)
  // --------------------------------------------------

  router.get('/choferes/:id/costos', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        `SELECT cc.*, p.nombre as producto_nombre
         FROM chofer_costos cc
         JOIN productos p ON p.id = cc.producto_id
         WHERE cc.chofer_id = $1
           AND ($2::int IS NULL OR cc.empresa_id = $2)
         ORDER BY cc.producto_id ASC`,
        [req.params.id, esSuperAdmin ? null : Number(myEmpresa)]
      );

      return res.json(rows);
    } catch {
      return res.status(500).json({ error: 'Error costos' });
    }
  });

  router.post('/choferes/:id/costos', withAuth, async (req, res) => {
    try {
      const { producto_id, costo_unitario } = req.body || {};
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rowsChofer = await query(
        'SELECT empresa_id FROM choferes WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2) LIMIT 1',
        [req.params.id, esSuperAdmin ? null : Number(myEmpresa)]
      );
      if (!rowsChofer.length) return res.status(404).json({ error: 'Chofer no encontrado o sin permiso' });

      const empresaId = Number(rowsChofer[0].empresa_id);

      await query(
        `INSERT INTO chofer_costos (empresa_id, chofer_id, producto_id, costo_unitario)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (empresa_id, chofer_id, producto_id)
         DO UPDATE SET costo_unitario = EXCLUDED.costo_unitario`,
        [empresaId, req.params.id, producto_id, costo_unitario]
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR COSTOS:', e);
      return res.status(500).json({ error: 'Error guardando costo: ' + (e.message || e) });
    }
  });

  router.put('/choferes/:id/costos/:pid', withAuth, async (req, res) => {
    try {
      const { costo_unitario } = req.body || {};
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        `UPDATE chofer_costos
            SET costo_unitario=$1
          WHERE chofer_id=$2 AND producto_id=$3
            AND ($4::int IS NULL OR empresa_id=$4)
        RETURNING chofer_id`,
        [costo_unitario, req.params.id, req.params.pid, esSuperAdmin ? null : Number(myEmpresa)]
      );

      if (!rows.length) return res.status(404).json({ error: 'Costo no encontrado o sin permiso' });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error actualizando costo' });
    }
  });

  router.delete('/choferes/:id/costos/:pid', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        `DELETE FROM chofer_costos
          WHERE chofer_id=$1 AND producto_id=$2
            AND ($3::int IS NULL OR empresa_id=$3)
        RETURNING chofer_id`,
        [req.params.id, req.params.pid, esSuperAdmin ? null : Number(myEmpresa)]
      );

      if (!rows.length) return res.status(404).json({ error: 'Costo no encontrado o sin permiso' });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error borrando costo' });
    }
  });

  // --------------------------------------------------
  // ESCALAS + TRAMOS
  // --------------------------------------------------

  router.get('/choferes/:id/escalas', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const escalas = await query(
        `SELECT *
         FROM chofer_escalas
         WHERE chofer_id=$1
           AND ($2::int IS NULL OR empresa_id=$2)
         ORDER BY id DESC`,
        [req.params.id, esSuperAdmin ? null : Number(myEmpresa)]
      );

      for (const e of escalas) {
        e.tramos = await query(
          `SELECT *
           FROM chofer_escala_tramos
           WHERE escala_id=$1
           ORDER BY rango_min`,
          [e.id]
        );
      }

      return res.json(escalas);
    } catch {
      return res.status(500).json({ error: 'Error escalas' });
    }
  });

  router.post('/choferes/:id/escalas', withAuth, async (req, res) => {
    try {
      const { nombre, vigente_desde, vigente_hasta, notas } = req.body || {};
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rowsChofer = await query(
        'SELECT empresa_id FROM choferes WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2) LIMIT 1',
        [req.params.id, esSuperAdmin ? null : Number(myEmpresa)]
      );
      if (!rowsChofer.length) return res.status(404).json({ error: 'Chofer no encontrado o sin permiso' });

      const empresaId = Number(rowsChofer[0].empresa_id);

      await query(
        `INSERT INTO chofer_escalas (empresa_id, chofer_id, nombre, vigente_desde, vigente_hasta, notas)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [empresaId, req.params.id, nombre, vigente_desde, vigente_hasta || null, notas]
      );

      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error creando escala' });
    }
  });

  router.put('/escalas/:id', withAuth, async (req, res) => {
    try {
      const { nombre, vigente_desde, vigente_hasta, notas } = req.body || {};
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        `UPDATE chofer_escalas
            SET nombre=$1, vigente_desde=$2, vigente_hasta=$3, notas=$4
          WHERE id=$5
            AND ($6::int IS NULL OR empresa_id=$6)
        RETURNING id`,
        [nombre, vigente_desde, vigente_hasta, notas, req.params.id, esSuperAdmin ? null : Number(myEmpresa)]
      );

      if (!rows.length) return res.status(404).json({ error: 'Escala no encontrada o sin permiso' });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error editando escala' });
    }
  });

  router.delete('/escalas/:id', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        `DELETE FROM chofer_escalas
          WHERE id=$1
            AND ($2::int IS NULL OR empresa_id=$2)
        RETURNING id`,
        [req.params.id, esSuperAdmin ? null : Number(myEmpresa)]
      );

      if (!rows.length) return res.status(404).json({ error: 'Escala no encontrada o sin permiso' });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error borrando escala' });
    }
  });

  router.post('/escalas/:id/tramos', withAuth, async (req, res) => {
    try {
      const { rango_min, rango_max, monto } = req.body || {};
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const esc = await query(
        `SELECT id
         FROM chofer_escalas
         WHERE id=$1
           AND ($2::int IS NULL OR empresa_id=$2)
         LIMIT 1`,
        [req.params.id, esSuperAdmin ? null : Number(myEmpresa)]
      );
      if (!esc.length) return res.status(404).json({ error: 'Escala no encontrada o sin permiso' });

      await query(
        `INSERT INTO chofer_escala_tramos (escala_id, rango_min, rango_max, monto)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, rango_min, rango_max || null, monto]
      );

      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error creando tramo' });
    }
  });

  router.put('/tramos/:id', withAuth, async (req, res) => {
    try {
      const { rango_min, rango_max, monto } = req.body || {};
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        `UPDATE chofer_escala_tramos t
            SET rango_min=$1, rango_max=$2, monto=$3
          WHERE t.id=$4
            AND EXISTS (
              SELECT 1
              FROM chofer_escalas e
              WHERE e.id = t.escala_id
                AND ($5::int IS NULL OR e.empresa_id=$5)
            )
        RETURNING t.id`,
        [rango_min, rango_max || null, monto, req.params.id, esSuperAdmin ? null : Number(myEmpresa)]
      );

      if (!rows.length) return res.status(404).json({ error: 'Tramo no encontrado o sin permiso' });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error editando tramo' });
    }
  });

  router.delete('/tramos/:id', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        `DELETE FROM chofer_escala_tramos t
          WHERE t.id=$1
            AND EXISTS (
              SELECT 1
              FROM chofer_escalas e
              WHERE e.id = t.escala_id
                AND ($2::int IS NULL OR e.empresa_id=$2)
            )
        RETURNING t.id`,
        [req.params.id, esSuperAdmin ? null : Number(myEmpresa)]
      );

      if (!rows.length) return res.status(404).json({ error: 'Tramo no encontrado o sin permiso' });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error borrando tramo' });
    }
  });

  return router;
}
