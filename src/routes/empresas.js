// src/routes/empresas.js
// CRUD de empresas + cuentas bancarias (extraído desde server.js)

import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';

export function createEmpresasRouter(deps) {
  const {
    query,
    pool,
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

  const EMPRESAS_LOGO_DIR = path.resolve(process.cwd(), 'pedidos', 'img', 'empresas');
  fs.mkdirSync(EMPRESAS_LOGO_DIR, { recursive: true });

  const empresasLogoUploader = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, EMPRESAS_LOGO_DIR),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
        const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
        cb(null, `empresa_logo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${safeExt}`);
      }
    }),
    fileFilter: (_req, file, cb) => {
      const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(String(file.mimetype || '').toLowerCase());
      cb(ok ? null : new Error('Formato no permitido'), ok);
    },
    limits: { fileSize: 2 * 1024 * 1024 }
  });

  const quoteIdent = (v) => `"${String(v || '').replace(/"/g, '""')}"`;

  async function getEmpresaScopedTables() {
    return query(
      `
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND c.column_name = 'empresa_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name
      `
    );
  }

  async function getTableColumns(tableName) {
    return query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
      `,
      [tableName]
    );
  }

  function toObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  }

  router.post('/upload-logo', withAuth, (req, res) => {
    empresasLogoUploader.single('logo')(req, res, (err) => {
      if (err) {
        const msg = String(err?.message || 'Error subiendo logo');
        if (msg.includes('File too large')) return res.status(400).json({ error: 'La imagen supera 2MB' });
        if (msg.includes('Formato no permitido')) return res.status(400).json({ error: 'Formato inválido. Usá JPG/PNG/WEBP' });
        return res.status(400).json({ error: 'No se pudo subir el logo' });
      }

      const filename = req.file?.filename;
      if (!filename) return res.status(400).json({ error: 'Archivo requerido' });
      return res.json({ ok: true, logo_url: `/pedidos/img/empresas/${filename}` });
    });
  });

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
      logo_url,
      cuentas_bancarias,
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
          plan_precio,
          logo_url
        )
        VALUES (
          $1,  $2,  $3,
          $4,  $5,  $6,  $7,  $8,  $9,  $10,
          $11, $12,
          $13, $14,
          $15, $16,
          $17, $18, $19, $20, $21, $22,
          $23, $24, $25, $26,
          $27
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
          logo_url || null,
        ]
      );

      const nuevaEmpresa = rows[0];

      if (nuevaEmpresa?.id && Array.isArray(cuentas_bancarias) && cuentas_bancarias.length) {
        for (const cta of cuentas_bancarias) {
          const banco = String(cta?.banco || '').trim() || null;
          const alias = String(cta?.alias || '').trim() || null;
          const cbu = String(cta?.cbu || '').trim() || null;
          const titular = String(cta?.titular || '').trim() || null;
          const prioridad = Number(cta?.prioridad) > 0 ? Number(cta.prioridad) : 1;
          const activa = cta?.activa !== false;

          if (!banco && !alias && !cbu) continue;

          await query(
            `INSERT INTO empresa_cuentas_bancarias
              (empresa_id, banco, alias, cbu, titular, activa, prioridad)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [nuevaEmpresa.id, banco, alias, cbu, titular, activa, prioridad]
          );
        }
      }

      return res.json(nuevaEmpresa);
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
      logo_url,
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
          plan_precio      = COALESCE($26, plan_precio),
          logo_url         = COALESCE($27, logo_url)
        WHERE id = $28
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
          logo_url || null,
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

  // GET /api/empresas/:id/backup
  // Exporta en JSON todos los registros de tablas que tengan columna empresa_id
  router.get('/:id/backup', withAuth, async (req, res) => {
    try {
      const empresaId = Number(req.params.id);
      if (!Number.isFinite(empresaId) || empresaId <= 0) {
        return res.status(400).json({ error: 'ID de empresa inválido' });
      }

      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);
      if (!esSuperAdmin && empresaId !== myEmpresa) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const empresaRows = await query('SELECT * FROM empresas WHERE id = $1 LIMIT 1', [empresaId]);
      if (!empresaRows.length) {
        return res.status(404).json({ error: 'Empresa no encontrada' });
      }

      const tables = await query(
        `
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema
         AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'empresa_id'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name
        `
      );

      const dataset = {};
      for (const t of tables) {
        const tableName = String(t.table_name || '').trim();
        if (!tableName) continue;

        const safeTable = tableName.replace(/"/g, '""');
        const rows = await query(`SELECT * FROM "${safeTable}" WHERE empresa_id = $1`, [empresaId]);
        dataset[tableName] = rows || [];
      }

      const stamp = new Date().toISOString().replace(/[.:]/g, '-');
      const empresaNombre = String(empresaRows[0]?.nombre || 'empresa').replace(/[^a-zA-Z0-9_-]+/g, '_');
      const filename = `backup_empresa_${empresaId}_${empresaNombre}_${stamp}.json`;

      const payload = {
        meta: {
          generated_at: new Date().toISOString(),
          empresa_id: empresaId,
          empresa_nombre: empresaRows[0]?.nombre || null,
          source: 'api/empresas/:id/backup',
          tables: Object.fromEntries(
            Object.entries(dataset).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
          ),
        },
        empresa: empresaRows[0],
        data: dataset,
      };

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(JSON.stringify(payload, null, 2));
    } catch (e) {
      console.error('ERROR BACKUP EMPRESA:', e);
      return res.status(500).json({ error: 'Error generando backup' });
    }
  });

  // POST /api/empresas/:id/backup/validate
  // Dry-run: valida estructura del backup y qué se podría restaurar
  router.post('/:id/backup/validate', withAuth, async (req, res) => {
    try {
      if (!isSuper(req)) return res.status(403).json({ error: 'Solo superadmin' });

      const empresaId = Number(req.params.id);
      if (!Number.isFinite(empresaId) || empresaId <= 0) {
        return res.status(400).json({ error: 'ID de empresa inválido' });
      }

      const backup = toObject(req.body);
      if (!backup) return res.status(400).json({ error: 'Body JSON inválido' });

      const data = toObject(backup.data);
      if (!data) {
        return res.status(400).json({ error: 'Formato inválido: falta objeto data' });
      }

      const empresaRows = await query('SELECT id, nombre FROM empresas WHERE id = $1 LIMIT 1', [empresaId]);
      if (!empresaRows.length) {
        return res.status(404).json({ error: 'Empresa no encontrada' });
      }

      const tablesRows = await getEmpresaScopedTables();
      const allowedTables = new Set((tablesRows || []).map((r) => String(r.table_name || '')));

      const summary = {
        empresa_id: empresaId,
        allowed_tables: allowedTables.size,
        tables: {},
        warnings: [],
      };

      for (const [tableNameRaw, rowsRaw] of Object.entries(data)) {
        const tableName = String(tableNameRaw || '').trim();
        if (!tableName) continue;

        if (!allowedTables.has(tableName)) {
          summary.warnings.push(`Tabla no permitida: ${tableName}`);
          continue;
        }

        if (!Array.isArray(rowsRaw)) {
          summary.warnings.push(`Tabla ${tableName}: se esperaba array`);
          continue;
        }

        const cols = await getTableColumns(tableName);
        const allowedCols = new Set((cols || []).map((c) => String(c.column_name || '')));

        let validRows = 0;
        const skippedRows = [];

        rowsRaw.forEach((row, idx) => {
          const obj = toObject(row);
          if (!obj) {
            skippedRows.push({ index: idx, reason: 'fila no es objeto' });
            return;
          }

          if ('empresa_id' in obj && Number(obj.empresa_id) !== empresaId) {
            skippedRows.push({ index: idx, reason: `empresa_id distinto (${obj.empresa_id})` });
            return;
          }

          const unknownCols = Object.keys(obj).filter((k) => !allowedCols.has(k));
          if (unknownCols.length) {
            skippedRows.push({ index: idx, reason: `columnas desconocidas: ${unknownCols.join(', ')}` });
            return;
          }

          validRows += 1;
        });

        summary.tables[tableName] = {
          total: rowsRaw.length,
          valid: validRows,
          skipped: skippedRows.length,
          sample_skipped: skippedRows.slice(0, 10),
        };
      }

      return res.json({ ok: true, dry_run: true, summary });
    } catch (e) {
      console.error('ERROR VALIDATE BACKUP EMPRESA:', e);
      return res.status(500).json({ error: 'Error validando backup' });
    }
  });

  // POST /api/empresas/:id/backup/restore
  // Restore no destructivo (upsert por id cuando exista, insert en caso contrario)
  router.post('/:id/backup/restore', withAuth, async (req, res) => {
    try {
      if (!isSuper(req)) return res.status(403).json({ error: 'Solo superadmin' });
      if (!pool?.connect) return res.status(500).json({ error: 'Pool DB no disponible para restore' });

      const empresaId = Number(req.params.id);
      if (!Number.isFinite(empresaId) || empresaId <= 0) {
        return res.status(400).json({ error: 'ID de empresa inválido' });
      }

      const backup = toObject(req.body);
      if (!backup) return res.status(400).json({ error: 'Body JSON inválido' });

      const data = toObject(backup.data);
      if (!data) {
        return res.status(400).json({ error: 'Formato inválido: falta objeto data' });
      }

      const empresaRows = await query('SELECT id, nombre FROM empresas WHERE id = $1 LIMIT 1', [empresaId]);
      if (!empresaRows.length) {
        return res.status(404).json({ error: 'Empresa no encontrada' });
      }

      const tablesRows = await getEmpresaScopedTables();
      const allowedTables = (tablesRows || []).map((r) => String(r.table_name || '')).filter(Boolean);

      const report = {
        empresa_id: empresaId,
        restored_by: req.user?.username || req.user?.id || 'unknown',
        tables: {},
      };

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        for (const tableName of allowedTables) {
          const rowsRaw = data[tableName];
          if (!Array.isArray(rowsRaw) || !rowsRaw.length) continue;

          const colsMeta = await getTableColumns(tableName);
          const allowedCols = (colsMeta || []).map((c) => String(c.column_name || '')).filter(Boolean);
          const hasId = allowedCols.includes('id');

          let inserted = 0;
          let updated = 0;
          let skipped = 0;

          for (const rowRaw of rowsRaw) {
            const row = toObject(rowRaw);
            if (!row) {
              skipped += 1;
              continue;
            }

            if ('empresa_id' in row && Number(row.empresa_id) !== empresaId) {
              skipped += 1;
              continue;
            }

            const filteredEntries = Object.entries(row).filter(([k]) => allowedCols.includes(k));
            const clean = Object.fromEntries(filteredEntries);
            clean.empresa_id = empresaId;

            const columns = Object.keys(clean);
            if (!columns.length) {
              skipped += 1;
              continue;
            }

            const values = columns.map((k) => clean[k]);

            if (hasId && clean.id != null) {
              const exists = await client.query(
                `SELECT 1 FROM ${quoteIdent(tableName)} WHERE id = $1 AND empresa_id = $2 LIMIT 1`,
                [clean.id, empresaId]
              );

              if (exists.rowCount > 0) {
                const updatableCols = columns.filter((c) => c !== 'id');
                if (!updatableCols.length) {
                  skipped += 1;
                  continue;
                }

                const setSql = updatableCols
                  .map((c, idx) => `${quoteIdent(c)} = $${idx + 1}`)
                  .join(', ');
                const setValues = updatableCols.map((c) => clean[c]);

                await client.query(
                  `UPDATE ${quoteIdent(tableName)} SET ${setSql} WHERE id = $${updatableCols.length + 1} AND empresa_id = $${updatableCols.length + 2}`,
                  [...setValues, clean.id, empresaId]
                );
                updated += 1;
                continue;
              }
            }

            const colSql = columns.map((c) => quoteIdent(c)).join(', ');
            const valSql = columns.map((_, idx) => `$${idx + 1}`).join(', ');
            await client.query(
              `INSERT INTO ${quoteIdent(tableName)} (${colSql}) VALUES (${valSql})`,
              values
            );
            inserted += 1;
          }

          report.tables[tableName] = { inserted, updated, skipped, total: rowsRaw.length };
        }

        await client.query('COMMIT');
      } catch (txError) {
        await client.query('ROLLBACK');
        throw txError;
      } finally {
        client.release();
      }

      return res.json({ ok: true, mode: 'upsert_non_destructive', report });
    } catch (e) {
      console.error('ERROR RESTORE BACKUP EMPRESA:', e);
      return res.status(500).json({ error: 'Error restaurando backup', detail: e.message });
    }
  });

  router.post('/:id/cuentas', withAuth, async (req, res) => {    try {
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
