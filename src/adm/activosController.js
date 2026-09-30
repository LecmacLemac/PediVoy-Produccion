import { query, withTransaction as dbWithTransaction } from '../db.js';

function transactionRunner(req) {
  return req.app?.locals?.withTransaction || dbWithTransaction;
}

function transactionFailure(res, label, error, fallback) {
  if (error?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
    return res.status(503).json({ error: 'No se pudo confirmar el resultado de la transacción.', code: 'TRANSACTION_OUTCOME_UNKNOWN' });
  }
  console.error(label, { code: error?.code || 'UNKNOWN' });
  return res.status(500).json({ error: fallback });
}


// ==================================================================
// HELPER: Resolver Empresa (Super Admin vs Usuario Normal)
// ==================================================================
function getTargetEmpresa(req) {
  // Si es SUPER ADMIN y envía un ID específico (por query o body), usamos ese.
  if (req.user.role === 'super') {
    const requestedId = Number(req.query.empresa_id || req.body.empresa_id);
    if (Number.isInteger(requestedId) && requestedId > 0) {
      return requestedId;
    }
  }
  // Si no, usamos la empresa del usuario logueado
  return req.user.empresa_id;
}

// ==================================================================
// 1. LISTAR ACTIVOS (Inventario con Filtros)
// ==================================================================
export async function listarActivos(req, res) {
  try {
    const empresaId = getTargetEmpresa(req);
    const { estado, busqueda } = req.query;

    let sql = `
      SELECT 
        a.*, 
        pe.cliente as cliente_nombre, 
        pe.direccion as cliente_direccion,
        pe.telefono as cliente_telefono
      FROM empresa_activos a
      LEFT JOIN puntos_entrega pe ON a.cliente_id = pe.id
      WHERE a.empresa_id = $1
    `;
    const params = [empresaId];
    let idx = 2;

    // Filtro por Estado (disponible, prestado, reparacion)
    if (estado && estado !== 'todos') {
      sql += ` AND a.estado = $${idx++}`;
      params.push(estado);
    }

    // Buscador General (Código, Marca, Cliente, Modelo)
    if (busqueda) {
      sql += ` AND (
        a.codigo ILIKE $${idx} OR 
        a.marca ILIKE $${idx} OR 
        a.modelo ILIKE $${idx} OR 
        pe.cliente ILIKE $${idx}
      )`;
      params.push(`%${busqueda}%`);
      idx++;
    }

    sql += ` ORDER BY a.id DESC LIMIT 500`;

    const rows = await query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('Error listarActivos:', { code: e?.code || 'UNKNOWN' });
    res.status(500).json({ error: 'Error obteniendo inventario de activos' });
  }
}

// ==================================================================
// 1.b. OBTENER ACTIVO POR ID (para ficha detalle)
// ==================================================================
export async function getActivoPorId(req, res) {
  try {
    const empresaId = getTargetEmpresa(req);
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'ID de activo inválido' });
    }

    const rows = await query(`
      SELECT 
        a.*,
        pe.cliente   AS cliente_nombre,
        pe.direccion AS cliente_direccion,
        pe.telefono  AS cliente_telefono
      FROM empresa_activos a
      LEFT JOIN puntos_entrega pe ON a.cliente_id = pe.id
      WHERE a.empresa_id = $1
        AND a.id = $2
      LIMIT 1
    `, [empresaId, id]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Activo no encontrado' });
    }

    // Devolvemos un solo registro (la ficha del activo)
    return res.json(rows[0]);
  } catch (e) {
    console.error('Error getActivoPorId:', { code: e?.code || 'UNKNOWN' });
    return res.status(500).json({ error: 'Error obteniendo activo' });
  }
}

// ==================================================================
// 2. CREAR ACTIVO (Soporte Multi-Industria con JSONB)
// ==================================================================
export async function crearActivo(req, res) {
  try {
    const { 
      codigo, tipo, marca, modelo, valor, 
      frecuencia_mantenimiento, detalles,
      fecha_compra, notas
    } = req.body;
    
    const empresaId = getTargetEmpresa(req);

    // Validación básica
    if (!codigo || !tipo) {
      return res.status(400).json({ error: 'Código y Tipo son obligatorios.' });
    }

    // Insertamos incluyendo fecha_compra y notas (CORREGIDO)
    await query(`
      INSERT INTO empresa_activos (
        empresa_id, codigo, tipo, marca, modelo, 
        valor_compra, frecuencia_mantenimiento, detalles_tecnicos,
        fecha_compra, notas
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      empresaId, 
      codigo, 
      tipo, 
      marca || null, 
      modelo || null, 
      valor || 0,
      frecuencia_mantenimiento || 6,
      detalles ? JSON.stringify(detalles) : '{}',
      fecha_compra || null,
      notas || null
    ]);

    res.json({ ok: true, message: 'Activo creado correctamente.' });

  } catch (e) {
    console.error('Error crearActivo:', { code: e?.code || 'UNKNOWN' });
    if (e.message.includes('unique')) {
      return res.status(400).json({ error: 'Ya existe un activo con ese código en esta empresa.' });
    }
    res.status(500).json({ error: 'Error creando activo' });
  }
}

// ==================================================================
// 3. ASIGNAR A CLIENTE (Comodato / Préstamo)
// ==================================================================

export async function asignarActivo(req, res) {
  const { activo_id, cliente_id, notas, firma_base64 } = req.body;
  const empresaId = getTargetEmpresa(req);
  const usuario = req.user.username;
  try {
    const result = await transactionRunner(req)(async q => {
      const check = await q('SELECT estado FROM empresa_activos WHERE id = $1 AND empresa_id = $2 FOR UPDATE', [activo_id, empresaId]);
      if (!check.length) return { status: 404, payload: { error: 'Activo no encontrado' } };
      if (check[0].estado !== 'disponible') return { status: 400, payload: { error: 'Activo no disponible.' } };
      const clients = await q('SELECT id FROM puntos_entrega WHERE id = $1 AND empresa_id = $2 LIMIT 1', [cliente_id, empresaId]);
      if (!clients.length) return { status: 400, payload: { error: 'Cliente no encontrado para esta empresa' } };
      const updated = await q(`UPDATE empresa_activos SET estado = 'prestado', cliente_id = $1, updated_at = NOW()
        WHERE empresa_id = $2 AND id = $3 AND estado = 'disponible' RETURNING id`, [cliente_id, empresaId, activo_id]);
      if (updated.length !== 1) throw new Error('ASSET_EXACT_ROW_FAILED');
      await q(`INSERT INTO historial_activos
        (empresa_id, activo_id, cliente_id, accion, usuario, observacion, firma_digital, fecha)
        VALUES ($1, $2, $3, 'asignacion', $4, $5, $6, NOW())`,
        [empresaId, activo_id, cliente_id, usuario, notas || 'Entrega bajo firma', firma_base64 || null]);
      return { status: 200, payload: { ok: true } };
    });
    return res.status(result.status).json(result.payload);
  } catch (error) {
    return transactionFailure(res, 'ACTIVOS.ASIGNAR.ERROR', error, 'Error asignando activo');
  }
}

// ==================================================================
// 4. DEVOLVER A DEPÓSITO (Fin de Comodato)
// ==================================================================
export async function devolverActivo(req, res) {
  const { activo_id, motivo, estado_final } = req.body;
  const empresaId = getTargetEmpresa(req);
  const usuario = req.user.username;
  try {
    const result = await transactionRunner(req)(async q => {
      const actual = await q('SELECT cliente_id FROM empresa_activos WHERE id = $1 AND empresa_id = $2 FOR UPDATE', [activo_id, empresaId]);
      if (!actual.length) return { status: 404, payload: { error: 'Activo no encontrado' } };
      const clientePrevio = actual[0]?.cliente_id || null;
      const updated = await q(`UPDATE empresa_activos SET estado = $1, cliente_id = NULL, updated_at = NOW()
        WHERE empresa_id = $2 AND id = $3 RETURNING id`, [estado_final || 'disponible', empresaId, activo_id]);
      if (updated.length !== 1) throw new Error('ASSET_EXACT_ROW_FAILED');
      await q(`INSERT INTO historial_activos
        (empresa_id, activo_id, cliente_id, accion, usuario, observacion, fecha)
        VALUES ($1, $2, $3, 'devolucion', $4, $5, NOW())`,
        [empresaId, activo_id, clientePrevio, usuario, motivo || 'Devolución al depósito']);
      return { status: 200, payload: { ok: true } };
    });
    return res.status(result.status).json(result.payload);
  } catch (error) {
    return transactionFailure(res, 'ACTIVOS.DEVOLVER.ERROR', error, 'Error procesando devolución');
  }
}

// ==================================================================
// 5. REGISTRAR MANTENIMIENTO (Sanitización / Service)
// ==================================================================

export async function registrarSanitizacion(req, res) {
  const { activo_id, notas } = req.body;
  const empresaId = getTargetEmpresa(req);
  const usuario = req.user.username;
  try {
    const result = await transactionRunner(req)(async q => {
      const updated = await q(`UPDATE empresa_activos SET ultima_sanitizacion = NOW(), updated_at = NOW()
        WHERE id = $1 AND empresa_id = $2 RETURNING id`, [activo_id, empresaId]);
      if (updated.length !== 1) return { status: 404, payload: { error: 'Activo no encontrado o sin permisos' } };
      await q(`INSERT INTO historial_activos
        (empresa_id, activo_id, accion, usuario, observacion, fecha)
        VALUES ($1, $2, 'mantenimiento', $3, $4, NOW())`,
        [empresaId, activo_id, usuario, notas || 'Limpieza y Sanitización Realizada']);
      return { status: 200, payload: { ok: true, message: 'Mantenimiento registrado exitosamente.' } };
    });
    return res.status(result.status).json(result.payload);
  } catch (error) {
    return transactionFailure(res, 'ACTIVOS.SANITIZAR.ERROR', error, 'Error registrando mantenimiento');
  }
}

// ==================================================================
// NUEVAS FUNCIONES: módulo de Activos FSM avanzado
// ==================================================================

export async function actualizarActivo(req, res) {
  const empresaId = getTargetEmpresa(req);
  const id = Number(req.params.id || req.body.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de activo inválido.' });
  }

  // 1. AQUI AGREGAMOS LOS CAMPOS NUEVOS A LA DESTRUCTURACIÓN
  const {
    codigo, tipo, marca, modelo, valor_compra, fecha_compra,
    detalles_tecnicos, notas, frecuencia_mantenimiento,
    alquiler_mensual,      // <--- NUEVO
    fecha_inicio_alquiler  // <--- NUEVO
  } = req.body || {};

  const sets = [];
  const values = [];
  let i = 1;

  function push(field, value, transformJson = false) {
    if (typeof value !== 'undefined') {
      sets.push(`${field} = $${i}`);
      if (transformJson && value && typeof value === 'object') {
        values.push(JSON.stringify(value));
      } else {
        values.push(value);
      }
      i++;
    }
  }

  // 2. Y AQUÍ LOS AGREGAMOS A LA LISTA DE ACTUALIZACIÓN
  push('codigo', codigo);
  push('tipo', tipo);
  push('marca', marca);
  push('modelo', modelo);
  push('valor_compra', valor_compra);
  push('fecha_compra', fecha_compra);
  push('detalles_tecnicos', detalles_tecnicos, true);
  push('notas', notas);
  push('frecuencia_mantenimiento', frecuencia_mantenimiento);
  
  // --- NUEVOS CAMPOS ---
  push('alquiler_mensual', alquiler_mensual);
  push('fecha_inicio_alquiler', fecha_inicio_alquiler);
  // ---------------------

  if (!sets.length) {
    return res.status(400).json({ error: 'No hay campos para actualizar.' });
  }

  sets.push('updated_at = NOW()');

  const empresaIdx = i;
  values.push(empresaId);
  i++;

  const idIdx = i;
  values.push(id);

  const sql = `
    UPDATE empresa_activos
       SET ${sets.join(', ')}
     WHERE empresa_id = $${empresaIdx}
       AND id = $${idIdx}
     RETURNING *
  `;

  try {
    const rows = await query(sql, values);
    if (!rows.length) {
      return res.status(404).json({ error: 'Activo no encontrado para esta empresa.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error('Error actualizarActivo:', { code: e?.code || 'UNKNOWN' });
    return res.status(500).json({ error: 'Error actualizando activo' });
  }
}

export async function marcarBajaActivo(req, res) {
  const empresaId = getTargetEmpresa(req);
  const id = Number(req.params.id || req.body.id);
  const { notas } = req.body || {};
  const usuario = req.user?.username || null;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID de activo inválido.' });
  try {
    const result = await transactionRunner(req)(async q => {
      const activos = await q('SELECT id, estado, cliente_id FROM empresa_activos WHERE empresa_id = $1 AND id = $2 FOR UPDATE', [empresaId, id]);
      if (!activos.length) return { status: 404, payload: { error: 'Activo no encontrado para esta empresa.' } };
      const activo = activos[0];
      if (activo.estado === 'baja') return { status: 200, payload: { ok: true, message: 'El activo ya estaba dado de baja.' } };
      const updated = await q(`UPDATE empresa_activos SET estado = 'baja', cliente_id = NULL, updated_at = NOW()
        WHERE empresa_id = $1 AND id = $2 RETURNING id`, [empresaId, id]);
      if (updated.length !== 1) throw new Error('ASSET_EXACT_ROW_FAILED');
      await q(`INSERT INTO historial_activos (empresa_id, activo_id, cliente_id, accion, usuario, observacion)
        VALUES ($1, $2, $3, $4, $5, $6)`, [empresaId, id, activo.cliente_id || null, 'baja', usuario, notas || 'Baja definitiva del activo']);
      return { status: 200, payload: { ok: true, message: 'Activo dado de baja correctamente.' } };
    });
    return res.status(result.status).json(result.payload);
  } catch (error) {
    return transactionFailure(res, 'ACTIVOS.BAJA.ERROR', error, 'Error marcando baja de activo');
  }
}

export async function getHistorialActivo(req, res) {
  const empresaId = getTargetEmpresa(req);
  const id = Number(req.params.id || req.query.id);

  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID de activo inválido.' });

  try {
    const activos = await query(`SELECT id FROM empresa_activos WHERE empresa_id = $1 AND id = $2 LIMIT 1`, [empresaId, id]);
    if (!activos.length) return res.status(404).json({ error: 'Activo no encontrado para esta empresa.' });

    const rows = await query(
      `SELECT h.*, p.cliente AS cliente_nombre
         FROM historial_activos h
         LEFT JOIN puntos_entrega p
           ON p.id = h.cliente_id
          AND p.empresa_id = h.empresa_id
        WHERE h.empresa_id = $1 AND h.activo_id = $2
        ORDER BY h.fecha DESC, h.id DESC`,
      [empresaId, id]
    );

    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('Error getHistorialActivo:', { code: e?.code || 'UNKNOWN' });
    return res.status(500).json({ error: 'Error obteniendo historial de activo' });
  }
}

export async function enviarAReparacion(req, res) {
  const empresaId = getTargetEmpresa(req);
  const { activo_id, notas, lat, lng, firma_base64 } = req.body || {};
  const usuario = req.user?.username || null;
  const activoId = Number(activo_id);
  if (!Number.isInteger(activoId) || activoId <= 0) return res.status(400).json({ error: 'activo_id inválido.' });
  try {
    const result = await transactionRunner(req)(async q => {
      const activos = await q('SELECT id, estado, cliente_id FROM empresa_activos WHERE empresa_id = $1 AND id = $2 FOR UPDATE', [empresaId, activoId]);
      if (!activos.length) return { status: 404, payload: { error: 'Activo no encontrado para esta empresa.' } };
      const activo = activos[0];
      if (!['disponible', 'prestado', 'reparacion'].includes(activo.estado)) return { status: 400, payload: { error: 'No se puede enviar a reparación desde el estado actual.' } };
      if (activo.estado === 'reparacion') return { status: 200, payload: { ok: true, message: 'El activo ya está marcado en reparación.' } };
      const updated = await q(`UPDATE empresa_activos SET estado = 'reparacion', cliente_id = NULL, updated_at = NOW()
        WHERE empresa_id = $1 AND id = $2 RETURNING id`, [empresaId, activoId]);
      if (updated.length !== 1) throw new Error('ASSET_EXACT_ROW_FAILED');
      await q(`INSERT INTO historial_activos (empresa_id, activo_id, cliente_id, accion, usuario, observacion, latitud, longitud, firma_digital)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [empresaId, activoId, activo.cliente_id || null, 'reparacion', usuario, notas || 'Enviado a reparación', typeof lat === 'number' ? lat : null, typeof lng === 'number' ? lng : null, firma_base64 || null]);
      return { status: 200, payload: { ok: true, message: 'Activo marcado como en reparación.' } };
    });
    return res.status(result.status).json(result.payload);
  } catch (error) {
    return transactionFailure(res, 'ACTIVOS.REPARACION.ERROR', error, 'Error enviando activo a reparación');
  }
}

export async function finReparacion(req, res) {
  const empresaId = getTargetEmpresa(req);
  const { activo_id, notas } = req.body || {};
  const usuario = req.user?.username || null;
  const activoId = Number(activo_id);
  if (!Number.isInteger(activoId) || activoId <= 0) return res.status(400).json({ error: 'activo_id inválido.' });
  try {
    const result = await transactionRunner(req)(async q => {
      const activos = await q('SELECT id, estado, cliente_id FROM empresa_activos WHERE empresa_id = $1 AND id = $2 FOR UPDATE', [empresaId, activoId]);
      if (!activos.length) return { status: 404, payload: { error: 'Activo no encontrado para esta empresa.' } };
      if (activos[0].estado !== 'reparacion') return { status: 400, payload: { error: "Solo se puede finalizar una reparación activa." } };
      const updated = await q(`UPDATE empresa_activos SET estado = 'disponible', updated_at = NOW()
        WHERE empresa_id = $1 AND id = $2 AND estado = 'reparacion' RETURNING id`, [empresaId, activoId]);
      if (updated.length !== 1) throw new Error('ASSET_EXACT_ROW_FAILED');
      await q(`INSERT INTO historial_activos (empresa_id, activo_id, cliente_id, accion, usuario, observacion)
        VALUES ($1, $2, $3, $4, $5, $6)`, [empresaId, activoId, null, 'fin_reparacion', usuario, notas || 'Reparación finalizada; activo disponible']);
      return { status: 200, payload: { ok: true, message: 'Reparación finalizada; activo disponible.' } };
    });
    return res.status(result.status).json(result.payload);
  } catch (error) {
    return transactionFailure(res, 'ACTIVOS.FIN_REPARACION.ERROR', error, 'Error finalizando reparación de activo');
  }
}

export async function resumenActivos(req, res) {
  const empresaId = getTargetEmpresa(req);
  try {
    const rowsEstados = await query(`SELECT estado, COUNT(*) AS cantidad FROM empresa_activos WHERE empresa_id = $1 GROUP BY estado`, [empresaId]);
    const counts = rowsEstados.reduce((acc, row) => {
      acc[row.estado || 'desconocido'] = Number(row.cantidad) || 0;
      return acc;
    }, {});
    const total = Object.values(counts).reduce((sum, v) => sum + v, 0);

    const [m] = await query(
      `SELECT
         COUNT(*) FILTER (
           WHERE frecuencia_mantenimiento IS NOT NULL AND frecuencia_mantenimiento > 0 AND ultima_sanitizacion IS NOT NULL
             AND (ultima_sanitizacion + (frecuencia_mantenimiento || ' months')::interval) < NOW()
         ) AS vencidos,
         COUNT(*) FILTER (
           WHERE frecuencia_mantenimiento IS NOT NULL AND frecuencia_mantenimiento > 0 AND ultima_sanitizacion IS NOT NULL
             AND (ultima_sanitizacion + (frecuencia_mantenimiento || ' months')::interval) BETWEEN NOW() AND NOW() + INTERVAL '30 days'
         ) AS por_vencer_30_dias
       FROM empresa_activos WHERE empresa_id = $1`,
      [empresaId]
    );

    return res.json({
      ok: true,
      data: {
        totales: {
          total,
          disponible: counts.disponible || 0,
          prestado: counts.prestado || 0,
          reparacion: counts.reparacion || 0,
          baja: counts.baja || 0
        },
        mantenimiento: {
          vencidos: Number(m?.vencidos) || 0,
          por_vencer_30_dias: Number(m?.por_vencer_30_dias) || 0
        }
      }
    });
  } catch (e) {
    console.error('Error resumenActivos:', { code: e?.code || 'UNKNOWN' });
    return res.status(500).json({ error: 'Error obteniendo resumen de activos' });
  }
}

export async function activosMantenimientoPendiente(req, res) {
  const empresaId = getTargetEmpresa(req);
  try {
    const rows = await query(
      `SELECT
         a.id, a.codigo, a.tipo, a.marca, a.modelo, a.estado, a.ultima_sanitizacion, a.frecuencia_mantenimiento,
         p.cliente AS cliente_nombre,
         (a.ultima_sanitizacion + (a.frecuencia_mantenimiento || ' months')::interval) AS proxima_fecha,
         FLOOR(EXTRACT(EPOCH FROM ((a.ultima_sanitizacion + (a.frecuencia_mantenimiento || ' months')::interval) - NOW())) / 86400)::int AS dias_restantes
       FROM empresa_activos a
       LEFT JOIN puntos_entrega p
         ON p.id = a.cliente_id
        AND p.empresa_id = a.empresa_id
      WHERE a.empresa_id = $1
        AND a.frecuencia_mantenimiento IS NOT NULL AND a.frecuencia_mantenimiento > 0 AND a.ultima_sanitizacion IS NOT NULL
        AND (a.ultima_sanitizacion + (a.frecuencia_mantenimiento || ' months')::interval) <= NOW() + INTERVAL '60 days'
      ORDER BY proxima_fecha ASC, a.id ASC LIMIT 200`,
      [empresaId]
    );
    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('Error activosMantenimientoPendiente:', { code: e?.code || 'UNKNOWN' });
    return res.status(500).json({ error: 'Error obteniendo activos con mantenimiento pendiente' });
  }
}

// ==================================================================
// 6. REPORTE DE ACTIVOS OCIOSOS (Clientes con máquina sin consumo)
// ==================================================================
export async function reporteActivosOciosos(req, res) {
  const empresaId = getTargetEmpresa(req);
  // Por defecto busca 60 días, pero permite filtrar por query param ?dias=30
  const diasSinCompra = req.query.dias ? parseInt(req.query.dias) : 60;

  try {
    const sql = `
      SELECT 
        a.id AS activo_id, 
        a.codigo, 
        a.marca, 
        a.modelo, 
        a.fecha_inicio_alquiler,
        pe.id AS cliente_id, 
        pe.cliente AS cliente_nombre, 
        pe.telefono AS cliente_telefono,
        pe.direccion AS cliente_direccion,
        MAX(p.fecha) as ultima_compra,
        COALESCE(
          EXTRACT(DAY FROM NOW() - MAX(p.fecha))::int, 
          9999 -- Si nunca compró, ponemos un número alto
        ) as dias_sin_compra
      FROM empresa_activos a
      JOIN puntos_entrega pe ON a.cliente_id = pe.id
      -- Left join para traer pedidos, incluso si no existen
      LEFT JOIN pedidos p
        ON p.punto_entrega_id = pe.id
       AND p.empresa_id = $1
       AND p.estado != 'cancelado'
      WHERE a.empresa_id = $1
        AND a.estado = 'prestado'
      GROUP BY a.id, pe.id
      HAVING MAX(p.fecha) < NOW() - make_interval(days => $2) 
          OR MAX(p.fecha) IS NULL
      ORDER BY dias_sin_compra DESC
    `;

    const rows = await query(sql, [empresaId, diasSinCompra]);

    return res.json({ 
      ok: true, 
      dias_criterio: diasSinCompra,
      cantidad: rows.length,
      data: rows 
    });

  } catch (e) {
    console.error('Error reporteActivosOciosos:', { code: e?.code || 'UNKNOWN' });
    return res.status(500).json({ error: 'Error generando reporte de ociosos' });
  }
}

// ==================================================================
// 7. STOCK DE ACTIVOS DEL CHOFER (Para selección en App Reparto)
// ==================================================================
export async function getMisActivosDisponibles(req, res) {
  const empresaId = getTargetEmpresa(req);
  // Asumimos que el chofer ve todos los 'disponibles' de la empresa 
  // O si tienes asignación por chofer, filtra por 'responsable_id'.
  // Por ahora, mostraremos todos los DISPONIBLES de la empresa para simplificar.
  
  try {
    const rows = await query(`
      SELECT id, codigo, modelo, marca, tipo
      FROM empresa_activos
      WHERE empresa_id = $1
        AND estado = 'disponible'
      ORDER BY codigo ASC
    `, [empresaId]);

    res.json(rows);
  } catch (e) {
    console.error('REQUEST.ERROR', { code: e?.code || 'UNKNOWN' });
    res.status(500).json({ error: 'Error cargando stock de activos' });
  }
}








