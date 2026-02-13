// src/routes/empresas.js
// CRUD de empresas + cuentas bancarias (extraído desde server.js)

import express from 'express';

export function createEmpresasRouter(deps) {
  const {
    query,
    withAuth,
    isSuper,
    getEmpresaIdFromToken,
    resolveEmpresaId,
    getEmpresaById,
  } = deps || {};

  if (typeof query !== 'function') throw new Error('createEmpresasRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createEmpresasRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createEmpresasRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createEmpresasRouter: falta getEmpresaIdFromToken(fn)');
  if (typeof resolveEmpresaId !== 'function') throw new Error('createEmpresasRouter: falta resolveEmpresaId(fn)');
  if (typeof getEmpresaById !== 'function') throw new Error('createEmpresasRouter: falta getEmpresaById(fn)');

  const router = express.Router();

  // GET /api/empresas
  router.get('/', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const filtroEmpresaId = Number(req.query?.empresa_id) || null;
      let rows;

      if (esSuperAdmin) {
        if (filtroEmpresaId) rows = await query(`SELECT * FROM empresas WHERE id=$1 ORDER BY id`, [filtroEmpresaId]);
        else rows = await query(`SELECT * FROM empresas ORDER BY id`);
      } else {
        rows = await query(`SELECT * FROM empresas WHERE id=$1 ORDER BY id`, [getEmpresaIdFromToken(req)]);
      }

      return res.json(rows || []);
    } catch (e) {
      console.error('EMPRESAS ERROR:', e);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // POST /api/empresas (solo superadmin)
  router.post('/', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Solo superadmin' });

    const {
      nombre,
      telefono,
      email,
      rubro,
      etiquetas,
      razon_social,
      cuit,
      condicion_iva,
      direccion,
      ciudad,
      provincia,
      pais,
      landing_domain,
      landing_slug,
      prompt_ia_vendedor,
      prompt_ia_general,
      config_entrega,
      modulos,
      config_operativa,
      config_logistica,
      config_activos,
      config_integraciones,
      plan_estado,
      plan_tipo,
      plan_vencimiento,
      plan_precio,
    } = req.body || {};

    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });

    try {
      const rows = await query(
        `
        INSERT INTO empresas (
          nombre,
          telefono,
          email,
          razon_social,
          cuit,
          condicion_iva,
          direccion,
          ciudad,
          provincia,
          pais,
          rubro,
          etiquetas,
          landing_domain,
          landing_slug,
          prompt_ia_vendedor,
          prompt_ia_general,
          config_entrega,
          modulos,
          config_operativa,
          config_logistica,
          config_activos,
          config_integraciones,
          plan_estado,
          plan_tipo,
          plan_vencimiento,
          plan_precio
        )
        VALUES (
          $1,  $2,  $3,
          $4,  $5,  $6,  $7,  $8,  $9,  $10,
          $11, $12,
          $13, $14,
          $15, $16,
          $17, $18, $19, $20, $21, $22,
          $23, $24, $25, $26
        )
        RETURNING *
        `,
        [
          nombre,
          telefono || null,
          email || null,
          razon_social || null,
          cuit || null,
          condicion_iva || null,
          direccion || null,
          ciudad || null,
          provincia || null,
          pais || 'Argentina',
          rubro || null,
          etiquetas || null,
          landing_domain || null,
          landing_slug || null,
          prompt_ia_vendedor || null,
          prompt_ia_general || null,
          config_entrega ? JSON.stringify(config_entrega) : JSON.stringify({}),
          modulos ? JSON.stringify(modulos) : JSON.stringify({}),
          config_operativa ? JSON.stringify(config_operativa) : JSON.stringify({}),
          config_logistica ? JSON.stringify(config_logistica) : JSON.stringify({}),
          config_activos ? JSON.stringify(config_activos) : JSON.stringify({}),
          config_integraciones ? JSON.stringify(config_integraciones) : JSON.stringify({}),
          plan_estado || null,
          plan_tipo || null,
          plan_vencimiento || null,
          plan_precio || null,
        ]
      );

      return res.json(rows[0]);
    } catch (e) {
      console.error('❌ [ERROR POST EMPRESA]:', e);
      if (e.code === '23505') {
        return res.status(400).json({ error: 'El dominio o slug ya está en uso por otra empresa.' });
      }
      return res.status(500).json({ error: 'Error interno al crear la empresa.' });
    }
  });

  // PUT /api/empresas/:id (solo superadmin)
  router.put('/:id', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Solo superadmin' });

    const { id } = req.params;

    const {
      nombre,
      telefono,
      email,
      rubro,
      etiquetas,
      razon_social,
      cuit,
      condicion_iva,
      direccion,
      ciudad,
      provincia,
      pais,
      landing_domain,
      landing_slug,
      prompt_ia_vendedor,
      prompt_ia_general,
      config_entrega,
      modulos,
      config_operativa,
      config_logistica,
      config_activos,
      config_integraciones,
      plan_estado,
      plan_tipo,
      plan_vencimiento,
      plan_precio,
    } = req.body || {};

    try {
      const rows = await query(
        `
        UPDATE empresas
        SET
          nombre      = COALESCE($1,  nombre),
          telefono    = COALESCE($2,  telefono),
          email       = COALESCE($3,  email),

          razon_social = COALESCE($4,  razon_social),
          cuit         = COALESCE($5,  cuit),
          condicion_iva= COALESCE($6,  condicion_iva),
          direccion    = COALESCE($7,  direccion),
          ciudad       = COALESCE($8,  ciudad),
          provincia    = COALESCE($9,  provincia),
          pais         = COALESCE($10, pais),

          rubro        = COALESCE($11, rubro),
          etiquetas    = COALESCE($12, etiquetas),

          landing_domain = COALESCE($13, landing_domain),
          landing_slug   = COALESCE($14, landing_slug),

          prompt_ia_vendedor = COALESCE($15, prompt_ia_vendedor),
          prompt_ia_general  = COALESCE($16, prompt_ia_general),

          config_entrega       = COALESCE($17, config_entrega),
          modulos              = COALESCE($18, modulos),
          config_operativa     = COALESCE($19, config_operativa),
          config_logistica     = COALESCE($20, config_logistica),
          config_activos       = COALESCE($21, config_activos),
          config_integraciones = COALESCE($22, config_integraciones),

          plan_estado      = COALESCE($23, plan_estado),
          plan_tipo        = COALESCE($24, plan_tipo),
          plan_vencimiento = COALESCE($25, plan_vencimiento),
          plan_precio      = COALESCE($26, plan_precio)
        WHERE id = $27
        RETURNING *
        `,
        [
          nombre || null,
          telefono || null,
          email || null,
          razon_social || null,
          cuit || null,
          condicion_iva || null,
          direccion || null,
          ciudad || null,
          provincia || null,
          pais || null,
          rubro || null,
          etiquetas || null,
          landing_domain || null,
          landing_slug || null,
          prompt_ia_vendedor || null,
          prompt_ia_general || null,
          config_entrega ? JSON.stringify(config_entrega) : null,
          modulos ? JSON.stringify(modulos) : null,
          config_operativa ? JSON.stringify(config_operativa) : null,
          config_logistica ? JSON.stringify(config_logistica) : null,
          config_activos ? JSON.stringify(config_activos) : null,
          config_integraciones ? JSON.stringify(config_integraciones) : null,
          plan_estado || null,
          plan_tipo || null,
          plan_vencimiento || null,
          plan_precio || null,
          id,
        ]
      );

      if (!rows.length) return res.status(404).json({ error: 'Empresa no encontrada' });
      return res.json(rows[0]);
    } catch (e) {
      console.error('❌ [ERROR PUT EMPRESA]:', e);
      if (e.code === '23505') {
        return res.status(400).json({ error: 'El dominio o slug ya está en uso por otra empresa.' });
      }
      return res.status(500).json({ error: 'Error interno al actualizar la empresa.' });
    }
  });

  // DELETE /api/empresas/:id (solo superadmin)
  router.delete('/:id', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Solo superadmin' });
    try {
      await query(`DELETE FROM empresas WHERE id=$1`, [req.params.id]);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error eliminando (tiene datos asociados)' });
    }
  });

  // GET /api/empresas/:id
  router.get('/:id', withAuth, getEmpresaById);

  // --------------------------------------------------
  // CUENTAS BANCARIAS DE EMPRESA (Multi-cuentas)
  // --------------------------------------------------

  router.get('/:id/cuentas', withAuth, async (req, res) => {
    try {
      const empresaId = Number(req.params.id);
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      if (!esSuperAdmin && empresaId !== myEmpresa) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const rows = await query(
        `SELECT * FROM empresa_cuentas_bancarias WHERE empresa_id = $1 ORDER BY id DESC`,
        [empresaId]
      );
      return res.json(rows);
    } catch (e) {
      console.error('ERROR GET CUENTAS:', e);
      return res.status(500).json({ error: 'Error obteniendo cuentas' });
    }
  });

  router.get('/:id/pagos', withAuth, async (req, res) => {
    try {
      const { id } = req.params;

      if (req.user.role !== 'super' && req.user.empresa_id != id) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const rows = await query(
        'SELECT * FROM historial_pagos WHERE empresa_id = $1 ORDER BY fecha DESC LIMIT 50',
        [id]
      );
      return res.json(rows);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error al obtener pagos' });
    }
  });

  router.post('/:id/cuentas', withAuth, async (req, res) => {
    try {
      const empresaId = Number(req.params.id);
      const { banco, alias, cbu, titular } = req.body || {};
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      if (!esSuperAdmin && empresaId !== myEmpresa) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      if (!banco && !alias && !cbu) return res.status(400).json({ error: 'Faltan datos de la cuenta' });

      await query(
        `INSERT INTO empresa_cuentas_bancarias
          (empresa_id, banco, alias, cbu, titular)
         VALUES ($1, $2, $3, $4, $5)`,
        [empresaId, banco, alias || null, cbu || null, titular || null]
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR ADD CUENTA:', e);
      if (e?.message?.includes('unique')) {
        return res.status(400).json({ error: 'Ya existe una cuenta con ese Alias o CBU' });
      }
      return res.status(500).json({ error: 'Error agregando cuenta' });
    }
  });

  // DELETE /api/empresas/cuentas/:id
  router.delete('/cuentas/:id', withAuth, async (req, res) => {
    try {
      const cuentaId = Number(req.params.id);
      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const check = await query('SELECT empresa_id FROM empresa_cuentas_bancarias WHERE id=$1', [cuentaId]);
      if (!check.length) return res.status(404).json({ error: 'Cuenta no encontrada' });

      if (!esSuperAdmin && check[0].empresa_id !== myEmpresa) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      await query('DELETE FROM empresa_cuentas_bancarias WHERE id = $1', [cuentaId]);
      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR DEL CUENTA:', e);
      return res.status(500).json({ error: 'Error eliminando cuenta' });
    }
  });

  // Nota: /api/empresas/:id/landing-page se maneja en landingRoutes.js

  return router;
}
