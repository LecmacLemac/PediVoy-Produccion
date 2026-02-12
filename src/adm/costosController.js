// src/adm/costosController.js
import { query } from '../db.js';
import { resolveEmpresaId } from '../services.js';

// Configuración de tipos / niveles para variables de costo
const TIPOS_VARIABLES = ['unitario', '%_sobre_precio', '%_sobre_costo'];
const NIVELES_VARIABLES = ['empresa', 'categoria', 'etiqueta', 'producto'];

function normalizarTipoVariable(tipoRaw) {
  const t = String(tipoRaw || '').toLowerCase();
  if (TIPOS_VARIABLES.includes(t)) return t;
  return 'unitario';
}

function normalizarNivel(nivelRaw) {
  const n = String(nivelRaw || '').toLowerCase();
  if (NIVELES_VARIABLES.includes(n)) return n;
  return 'producto';
}

// ==================================================================
// 1. SIMULAR PRECIO (Cálculo de Rentabilidad en Tiempo Real)
// ==================================================================
export async function simularPrecio(req, res) {
  try {
    const { productoId } = req.params;
    const empresaId = resolveEmpresaId(req);

    // Si no envían estimación, calculamos el promedio real de ventas del último mes
    let ventasEstimadas = Number(req.query.ventas_mes);

    if (!ventasEstimadas || ventasEstimadas <= 0) {
      const ventasReales = await query(
        `
        SELECT COALESCE(COUNT(*), 1) AS total
        FROM pedidos
        WHERE empresa_id = $1 AND created_at >= (NOW() - INTERVAL '30 days')
        `,
        [empresaId]
      );
      ventasEstimadas = Number(ventasReales?.[0]?.total) || 1; // Evitar división por 0
    }

    // A. Costos Fijos de la Empresa (Prorrateados a mensual equivalente)
    const fijosRows = await query(
      `SELECT COALESCE(SUM(
        CASE
          WHEN lower(frecuencia) = 'anual'   THEN monto / 12.0
          WHEN lower(frecuencia) = 'mensual' THEN monto
          WHEN lower(frecuencia) = 'semanal' THEN monto * 4.345
          ELSE 0
        END
      ), 0) AS total
      FROM empresa_costos_fijos
      WHERE empresa_id = $1`,
      [empresaId]
    );
    const costoFijoTotal = Number(fijosRows?.[0]?.total) || 0;
    const costoFijoUnitario = costoFijoTotal / ventasEstimadas;

    // B. Costos Directos del Producto (Base + Packaging)
    const prodRows = await query(
      `
      SELECT p.nombre,
             p.margen_meta,
             p.categoria,
             p.etiqueta,
             p.precio,
             COALESCE(epc.costo_base, 0)      AS costo_base,
             COALESCE(epc.costo_packaging, 0) AS packaging
      FROM productos p
      LEFT JOIN empresa_productos_costos epc
             ON epc.producto_id = p.id AND epc.empresa_id = p.empresa_id
      WHERE p.id = $1 AND p.empresa_id = $2
      `,
      [productoId, empresaId]
    );

    if (!prodRows.length) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // C. Logística promedio por producto (si existe)
    const logRows = await query(
      `
      SELECT COALESCE(AVG(costo_unitario), 0) AS logistica_promedio
      FROM chofer_costos
      WHERE empresa_id = $1 AND producto_id = $2
      `,
      [empresaId, productoId]
    );
    const logisticaPromedio = Number(logRows?.[0]?.logistica_promedio) || 0;

    // D. Normalizamos datos del producto
    const prod = prodRows[0];
    const costoBase = Number(prod.costo_base) || 0;
    const packaging = Number(prod.packaging) || 0;
    const precioVenta = Number(prod.precio) || 0;
    const categoria = prod.categoria || null;
    const etiqueta = prod.etiqueta || null;

    // E. Variables extra de costo (empresa / categoría / etiqueta / producto)
    const variablesRows = await query(
      `
      SELECT v.id,
             v.nombre,
             v.codigo,
             v.tipo_calculo,
             a.nivel,
             a.valor,
             a.producto_id,
             a.categoria,
             a.etiqueta
      FROM empresa_costos_variables_aplicacion a
      JOIN empresa_costos_variables_def v
        ON v.id = a.variable_id AND v.empresa_id = a.empresa_id
      WHERE a.empresa_id = $1
        AND a.activo = TRUE
        AND v.activo = TRUE
        AND (
          (a.nivel = 'empresa')
          OR (a.nivel = 'producto'  AND a.producto_id = $2)
          OR (a.nivel = 'categoria' AND a.categoria IS NOT NULL AND a.categoria = $3)
          OR (a.nivel = 'etiqueta'  AND a.etiqueta  IS NOT NULL AND a.etiqueta  = $4)
        )
      ORDER BY v.orden ASC, v.id ASC
      `,
      [empresaId, productoId, categoria, etiqueta]
    );

    let costoVariablesExtra = 0;
    const variablesExtra = (variablesRows || []).map((v) => {
      const tipo = normalizarTipoVariable(v.tipo_calculo);
      const valor = Number(v.valor) || 0;
      let monto_unitario = 0;

      if (tipo === 'unitario') {
        monto_unitario = valor;
      } else if (tipo === '%_sobre_precio') {
        monto_unitario = precioVenta * (valor / 100);
      } else if (tipo === '%_sobre_costo') {
        // Base: costos directos sin fijos
        const base = costoBase + packaging + logisticaPromedio;
        monto_unitario = base * (valor / 100);
      }

      costoVariablesExtra += monto_unitario;

      return {
        id: Number(v.id),
        nombre: v.nombre,
        codigo: v.codigo,
        tipo_calculo: tipo,
        nivel: v.nivel,
        valor,
        monto_unitario: Number(monto_unitario.toFixed(2)),
      };
    });

    const costoDirectoUnitario =
      costoBase + packaging + logisticaPromedio + costoVariablesExtra;

    const costoTotalUnitario = costoDirectoUnitario + costoFijoUnitario;

    res.json({
      producto: {
        id: Number(productoId),
        nombre: prod.nombre,
        margen_meta: Number(prod.margen_meta || 0),
        categoria,
        etiqueta,
        precio: precioVenta,
      },
      analisis: {
        absorcion_fijos: {
          total_empresa_mes: Number(costoFijoTotal),
          ventas_estimadas_mes: Number(ventasEstimadas),
          costo_fijo_unitario: Number(costoFijoUnitario),
        },
        costos_directos: {
          mercaderia: costoBase,
          packaging,
          logistica_promedio: logisticaPromedio,
        },
        variables_extra: {
          total_unitario: Number(costoVariablesExtra.toFixed(2)),
          items: variablesExtra,
        },
        resumen: {
          costo_directo_unitario: Number(costoDirectoUnitario.toFixed(2)),
          costo_fijo_unitario: Number(costoFijoUnitario.toFixed(2)),
          costo_total_unitario: Number(costoTotalUnitario.toFixed(2)),
        },
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error simulando' });
  }
}



// ==================================================================
// 2. ACTUALIZAR COSTO (Guardar y Auditar)
// ==================================================================
export async function actualizarCosto(req, res) {
  try {
    const empresa_id = resolveEmpresaId(req);
    const {
      producto_id,
      costo_base,
      costo_packaging,
      precio_venta,
      stock_actual,
      cotizacion_usd,
      motivo,
      variables_extra 
    } = req.body;

    const usuario = req.user?.username || 'desconocido';

    await query('BEGIN');

    // 1) Upsert costos del producto (base + packaging) por empresa/producto
    await query(
      `
      INSERT INTO empresa_productos_costos (empresa_id, producto_id, costo_base, costo_packaging)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (empresa_id, producto_id)
      DO UPDATE SET
        costo_base = EXCLUDED.costo_base,
        costo_packaging = EXCLUDED.costo_packaging
      `,
      [empresa_id, producto_id, costo_base, costo_packaging]
    );

    // 2) Actualizar precio si vino
    if (precio_venta !== undefined && precio_venta !== null) {
      await query(
        `UPDATE productos SET precio = $1 WHERE id = $2 AND empresa_id = $3`,
        [precio_venta, producto_id, empresa_id]
      );
    }

     // 3) Upsert de variables de costo EXTRA a nivel producto (si vienen)
    const varsExtra = Array.isArray(variables_extra) ? variables_extra : [];
    for (const item of varsExtra) {
      const variableId = Number(item.variable_id || item.id);
      const valor = Number(item.valor);

      if (!Number.isFinite(variableId) || !Number.isFinite(valor) || valor < 0) continue;

      const nivel = 'producto';
      const productoIdNum = Number(producto_id);

      // Buscamos si ya existe una fila para este (empresa, variable, nivel, producto)
      const existing = await query(
        `
        SELECT id
        FROM empresa_costos_variables_aplicacion
        WHERE empresa_id = $1
          AND variable_id = $2
          AND nivel = $3
          AND COALESCE(producto_id, 0) = COALESCE($4, 0)
        LIMIT 1
        `,
        [empresa_id, variableId, nivel, productoIdNum]
      );

      if (existing.length) {
        await query(
          `
          UPDATE empresa_costos_variables_aplicacion
             SET valor = $4,
                 activo = TRUE
           WHERE id = $5
          `,
          [empresa_id, variableId, nivel, valor, existing[0].id]
        );
      } else {
        await query(
          `
          INSERT INTO empresa_costos_variables_aplicacion
            (empresa_id, variable_id, nivel, producto_id, valor, activo)
          VALUES ($1,$2,$3,$4,$5,TRUE)
          `,
          [empresa_id, variableId, nivel, productoIdNum, valor]
        );
      }
    }

    // 4) Calcular costo fijo mensual total equivalente (mismo criterio que simulación)
    const fijosRows = await query(
      `SELECT COALESCE(SUM(
        CASE
          WHEN lower(frecuencia) = 'anual' THEN monto / 12.0
          WHEN lower(frecuencia) = 'mensual' THEN monto
          WHEN lower(frecuencia) = 'semanal' THEN monto * 4.345
          ELSE 0
        END
      ), 0) AS total
      FROM empresa_costos_fijos
      WHERE empresa_id = $1`,
      [empresa_id]
    );
    const totalFijos = Number(fijosRows?.[0]?.total) || 0;

    // 5) Ventas del último mes (para prorrateo unitario)
    const ventasReales = await query(
      `
      SELECT COALESCE(COUNT(*), 1) AS total
      FROM pedidos
      WHERE empresa_id = $1 AND created_at >= (NOW() - INTERVAL '30 days')
      `,
      [empresa_id]
    );
    const ventasMes = Number(ventasReales?.[0]?.total) || 1;
    const costoFijoUnitarioReal = totalFijos / ventasMes;

    // 6) Registrar historia/auditoría (CORREGIDO: usa historial_costos_precios)
    await query(
      `
      INSERT INTO historial_costos_precios
        (empresa_id, producto_id, costo_base, costo_packaging, costo_fijo_asignado,
         precio_venta, stock_al_momento, cotizacion_dolar, motivo_cambio, usuario_editor, fecha_registro)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
      `,
      [
        empresa_id,
        producto_id,
        costo_base,
        costo_packaging,
        Number(costoFijoUnitarioReal.toFixed(2)),
        precio_venta,
        stock_actual,     // Mapeado a stock_al_momento
        cotizacion_usd,   // Mapeado a cotizacion_dolar
        motivo,
        usuario
      ]
    );

    await query('COMMIT');
    res.json({ ok: true, message: 'Costos actualizados y auditados correctamente.' });

  } catch (e) {
    await query('ROLLBACK');
    console.error('Error actualizarCosto:', e);
    res.status(500).json({ error: 'Error actualizando costos. Se revirtieron los cambios.' });
  }
}

// ==================================================================
// 3. OBTENER EVOLUCIÓN (Historial)
// ==================================================================
export async function obtenerEvolucion(req, res) {
  try {
    const { productoId } = req.params;
    const empresaId = resolveEmpresaId(req);

    // CORREGIDO: Consulta a historial_costos_precios y calculo dinámico de ganancia
    const history = await query(
      `
      SELECT
        to_char(fecha_registro, 'YYYY-MM-DD') as fecha_fmt,
        usuario_editor,
        motivo_cambio,
        costo_base,
        costo_packaging,
        costo_fijo_asignado,
        precio_venta,
        (precio_venta - (costo_base + COALESCE(costo_packaging,0) + COALESCE(costo_fijo_asignado,0))) as ganancia_calculada
      FROM historial_costos_precios
      WHERE empresa_id = $1 AND producto_id = $2
      ORDER BY fecha_registro ASC
      `,
      [empresaId, productoId]
    );

    res.json({
      labels: history.map(h => h.fecha_fmt),
      meta: history.map(h => ({ user: h.usuario_editor, motivo: h.motivo_cambio })),
      series: [
        { name: 'Precio Venta', data: history.map(h => Number(h.precio_venta)) },
        {
          name: 'Costo Total',
          data: history.map(h =>
            Number(h.costo_base) + Number(h.costo_packaging) + Number(h.costo_fijo_asignado)
          )
        },
        { name: 'Ganancia Neta', data: history.map(h => Number(h.ganancia_calculada)) }
      ]
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error obteniendo evolución' });
  }
}

// ==================================================================
// 4. COSTOS FIJOS (LISTAR / CREAR / BORRAR) — Multi-tenancy
// ==================================================================

export async function listarCostosFijos(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);

    const items = await query(
      `SELECT id, nombre, monto, frecuencia, created_at
       FROM empresa_costos_fijos
       WHERE empresa_id = $1
       ORDER BY created_at DESC, id DESC`,
      [empresaId]
    );

    const totalRows = await query(
      `SELECT COALESCE(SUM(
        CASE
          WHEN lower(frecuencia) = 'anual' THEN monto / 12.0
          WHEN lower(frecuencia) = 'mensual' THEN monto
          WHEN lower(frecuencia) = 'semanal' THEN monto * 4.345
          ELSE 0
        END
      ), 0) AS total_mensual
      FROM empresa_costos_fijos
      WHERE empresa_id = $1`,
      [empresaId]
    );

    const total_mensual = Number(totalRows?.[0]?.total_mensual || 0);

    res.json({ items, total_mensual, count: items.length });
  } catch (e) {
    console.error('listarCostosFijos:', e);
    res.status(500).json({ error: 'Error listando costos fijos' });
  }
}

export async function crearCostoFijo(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);
    const nombreRaw = String(req.body?.nombre || '').trim();
    const monto = Number(req.body?.monto);
    const frecuencia = String(req.body?.frecuencia || 'mensual').trim().toLowerCase();

    if (!nombreRaw) return res.status(400).json({ error: 'nombre es requerido' });
    if (!Number.isFinite(monto) || monto < 0) return res.status(400).json({ error: 'monto inválido' });

    const freqOk = ['mensual', 'semanal', 'anual', 'unico'];
    const freq = freqOk.includes(frecuencia) ? frecuencia : 'mensual';

    const rows = await query(
      `INSERT INTO empresa_costos_fijos (empresa_id, nombre, monto, frecuencia, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, nombre, monto, frecuencia, created_at`,
      [empresaId, nombreRaw, monto, freq]
    );

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('crearCostoFijo:', e);
    res.status(500).json({ error: 'Error creando costo fijo' });
  }
}

export async function borrarCostoFijo(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);
    const id = Number(req.params.id);

    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

    const rows = await query(
      `DELETE FROM empresa_costos_fijos
       WHERE id = $1 AND empresa_id = $2
       RETURNING id`,
      [id, empresaId]
    );

    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });

    res.json({ ok: true });
  } catch (e) {
    console.error('borrarCostoFijo:', e);
    res.status(500).json({ error: 'Error borrando costo fijo' });
  }
}

export async function editarCostoFijo(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);
    const id = Number(req.params.id);

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }

    const nombre = req.body?.nombre !== undefined ? String(req.body.nombre).trim() : undefined;
    const monto  = req.body?.monto  !== undefined ? Number(req.body.monto) : undefined;
    const frecuenciaRaw = req.body?.frecuencia !== undefined ? String(req.body.frecuencia).trim().toLowerCase() : undefined;

    // Permitir edición parcial, pero al menos 1 campo debe venir
    const updates = [];
    const values = [];
    let idx = 1;

    if (nombre !== undefined) {
      if (!nombre) return res.status(400).json({ error: 'nombre inválido' });
      updates.push(`nombre = $${idx++}`);
      values.push(nombre);
    }

    if (monto !== undefined) {
      if (!Number.isFinite(monto) || monto < 0) return res.status(400).json({ error: 'monto inválido' });
      updates.push(`monto = $${idx++}`);
      values.push(monto);
    }

    if (frecuenciaRaw !== undefined) {
      const freqOk = ['mensual', 'semanal', 'anual', 'unico'];
      const frecuencia = freqOk.includes(frecuenciaRaw) ? frecuenciaRaw : 'mensual';
      updates.push(`frecuencia = $${idx++}`);
      values.push(frecuencia);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    values.push(id);
    values.push(empresaId);

    const rows = await query(
      `
      UPDATE empresa_costos_fijos
      SET ${updates.join(', ')}
      WHERE id = $${idx++} AND empresa_id = $${idx}
      RETURNING id, nombre, monto, frecuencia, created_at
      `,
      values
    );

    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });

    res.json(rows[0]);
  } catch (e) {
    console.error('editarCostoFijo:', e);
    res.status(500).json({ error: 'Error editando costo fijo' });
  }
}

// ==================================================================
// 5. VARIABLES DE COSTO (Definiciones por empresa)
// ==================================================================

export async function listarVariablesCostoDef(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);

    const rows = await query(
      `
      SELECT id, nombre, codigo, tipo_calculo, orden, activo, created_at, updated_at
      FROM empresa_costos_variables_def
      WHERE empresa_id = $1
      ORDER BY activo DESC, orden ASC, id ASC
      `,
      [empresaId]
    );

    res.json({ items: rows });
  } catch (e) {
    console.error('listarVariablesCostoDef:', e);
    res.status(500).json({ error: 'Error listando variables de costo' });
  }
}

export async function crearVariableCostoDef(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);
    const nombreRaw = String(req.body?.nombre || '').trim();
    const codigoRaw = String(req.body?.codigo || '').trim() || null;
    const tipoRaw = req.body?.tipo_calculo;
    const ordenRaw = Number(req.body?.orden);

    if (!nombreRaw) return res.status(400).json({ error: 'nombre es requerido' });
    const tipo = normalizarTipoVariable(tipoRaw);
    const orden = Number.isFinite(ordenRaw) ? ordenRaw : 0;

    const rows = await query(
      `
      INSERT INTO empresa_costos_variables_def
        (empresa_id, nombre, codigo, tipo_calculo, orden, activo, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())
      RETURNING id, nombre, codigo, tipo_calculo, orden, activo, created_at, updated_at
      `,
      [empresaId, nombreRaw, codigoRaw, tipo, orden]
    );

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('crearVariableCostoDef:', e);
    res.status(500).json({ error: 'Error creando variable de costo' });
  }
}

export async function editarVariableCostoDef(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

    const nombreRaw  = req.body?.nombre;
    const codigoRaw  = req.body?.codigo;
    const tipoRaw    = req.body?.tipo_calculo;
    const ordenRaw   = req.body?.orden;
    const activoRaw  = req.body?.activo;

    const sets = [];
    const values = [empresaId, id];
    let idx = 3;

    if (typeof nombreRaw === 'string') {
      sets.push(`nombre = $${idx}`); values.push(nombreRaw.trim()); idx++;
    }
    if (codigoRaw !== undefined) {
      sets.push(`codigo = $${idx}`); values.push(codigoRaw ? String(codigoRaw).trim() : null); idx++;
    }
    if (tipoRaw !== undefined) {
      sets.push(`tipo_calculo = $${idx}`); values.push(normalizarTipoVariable(tipoRaw)); idx++;
    }
    if (ordenRaw !== undefined) {
      sets.push(`orden = $${idx}`); values.push(Number(ordenRaw) || 0); idx++;
    }
    if (activoRaw !== undefined) {
      sets.push(`activo = $${idx}`); values.push(Boolean(activoRaw)); idx++;
    }

    sets.push(`updated_at = NOW()`);

    if (sets.length === 1) {
      return res.status(400).json({ error: 'Nada para actualizar' });
    }

    const rows = await query(
      `
      UPDATE empresa_costos_variables_def
         SET ${sets.join(', ')}
       WHERE empresa_id = $1 AND id = $2
       RETURNING id, nombre, codigo, tipo_calculo, orden, activo, created_at, updated_at
      `,
      values
    );

    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (e) {
    console.error('editarVariableCostoDef:', e);
    res.status(500).json({ error: 'Error editando variable de costo' });
  }
}

export async function borrarVariableCostoDef(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

    const rows = await query(
      `
      UPDATE empresa_costos_variables_def
         SET activo = FALSE,
             updated_at = NOW()
       WHERE empresa_id = $1 AND id = $2
       RETURNING id
      `,
      [empresaId, id]
    );

    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error('borrarVariableCostoDef:', e);
    res.status(500).json({ error: 'Error eliminando variable de costo' });
  }
}
// ==================================================================
// 6. APLICACIÓN DE VARIABLES DE COSTO (empresa / grupo / producto)
// ==================================================================

export async function listarVariablesCostoAplicacion(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);

    const productoId = req.query.producto_id ? Number(req.query.producto_id) : null;
    const nivel = req.query.nivel ? normalizarNivel(req.query.nivel) : null;
    const categoria = req.query.categoria ? String(req.query.categoria) : null;
    const etiqueta = req.query.etiqueta ? String(req.query.etiqueta) : null;

    const params = [empresaId];
    let idx = 2;
    let where = 'a.empresa_id = $1';

    if (productoId) {
      where += ` AND a.producto_id = $${idx}`; params.push(productoId); idx++;
    }
    if (nivel) {
      where += ` AND a.nivel = $${idx}`; params.push(nivel); idx++;
    }
    if (categoria) {
      where += ` AND a.categoria = $${idx}`; params.push(categoria); idx++;
    }
    if (etiqueta) {
      where += ` AND a.etiqueta = $${idx}`; params.push(etiqueta); idx++;
    }

    const rows = await query(
      `
      SELECT
        a.id,
        a.variable_id,
        a.nivel,
        a.producto_id,
        a.categoria,
        a.etiqueta,
        a.valor,
        a.activo,
        v.nombre,
        v.codigo,
        v.tipo_calculo
      FROM empresa_costos_variables_aplicacion a
      JOIN empresa_costos_variables_def v
        ON v.id = a.variable_id AND v.empresa_id = a.empresa_id
      WHERE ${where}
      ORDER BY v.orden ASC, v.id ASC
      `,
      params
    );

    res.json({ items: rows });
  } catch (e) {
    console.error('listarVariablesCostoAplicacion:', e);
    res.status(500).json({ error: 'Error listando variables aplicadas' });
  }
}

export async function upsertVariableCostoAplicacion(req, res) {
  try {
    const empresaId = resolveEmpresaId(req);
    let {
      variable_id,
      nivel,
      producto_id,
      categoria,
      etiqueta,
      valor,
      activo
    } = req.body || {};

    variable_id = Number(variable_id);
    if (!Number.isFinite(variable_id) || variable_id <= 0) {
      return res.status(400).json({ error: 'variable_id inválido' });
    }

    nivel = normalizarNivel(nivel);
    const v = Number(valor);
    if (!Number.isFinite(v)) {
      return res.status(400).json({ error: 'valor inválido' });
    }

    const productoIdNum = producto_id != null ? Number(producto_id) : null;
    const categoriaStr = categoria != null ? String(categoria).trim() : null;
    const etiquetaStr = etiqueta != null ? String(etiqueta).trim() : null;
    const activoBool = activo === undefined ? true : Boolean(activo);

    // Reglas simples según nivel
    if (nivel === 'producto' && !productoIdNum) {
      return res.status(400).json({ error: 'producto_id requerido para nivel=producto' });
    }
    if (nivel === 'categoria' && !categoriaStr) {
      return res.status(400).json({ error: 'categoria requerida para nivel=categoria' });
    }
    if (nivel === 'etiqueta' && !etiquetaStr) {
      return res.status(400).json({ error: 'etiqueta requerida para nivel=etiqueta' });
    }

    const whereParams = [
      empresaId,
      variable_id,
      nivel,
      productoIdNum,
      categoriaStr,
      etiquetaStr
    ];

    const existing = await query(
      `
      SELECT id
      FROM empresa_costos_variables_aplicacion
      WHERE empresa_id = $1
        AND variable_id = $2
        AND nivel = $3
        AND COALESCE(producto_id, 0) = COALESCE($4, 0)
        AND COALESCE(categoria, '') = COALESCE($5, '')
        AND COALESCE(etiqueta, '') = COALESCE($6, '')
      LIMIT 1
      `,
      whereParams
    );

    let rows;
    if (existing.length) {
      rows = await query(
        `
        UPDATE empresa_costos_variables_aplicacion
           SET valor = $7,
               activo = $8
         WHERE id = $9
         RETURNING *
        `,
        [...whereParams, v, activoBool, existing[0].id]
      );
    } else {
      rows = await query(
        `
        INSERT INTO empresa_costos_variables_aplicacion
          (empresa_id, variable_id, nivel, producto_id, categoria, etiqueta, valor, activo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
        `,
        [empresaId, variable_id, nivel, productoIdNum, categoriaStr, etiquetaStr, v, activoBool]
      );
    }

    res.json(rows[0]);
  } catch (e) {
    console.error('upsertVariableCostoAplicacion:', e);
    res.status(500).json({ error: 'Error guardando variable aplicada' });
  }
}