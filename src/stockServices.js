// src/stockServices.js — ESM

import db from './db.js';
import { nowIso as _nowIso } from './utils.js';
import { _upsertPuntoEntregaFromPedido, digitsOnly as _digitsOnly } from './sqliteServices.js';

// ---------- Helpers de introspección ----------
function getTableCols(table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
  catch { return []; }
}
function hasTable(table) {
  try {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    return !!row;
  } catch { return false; }
}
function hasCol(table, col) {
  return getTableCols(table).includes(col);
}
function q(s){ return String(s || '').trim(); }
function toNum(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function toInt(v){ const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
function lowerIn(expr, vals){ return `${expr} IN (${vals.map(v => `'${String(v).toLowerCase()}'`).join(',')})`; }

function parseOpts(input = {}) {
  // Permite firma simple: procesarTotalVenta(empresaId) o procesarTotalVenta({ ... })
  if (typeof input === 'number') return { empresaId: input, desde: null, hasta: null };
  if (input && typeof input === 'object') {
    return {
      empresaId: toInt(input.empresaId) || 1,
      desde: input.desde ? String(input.desde) : null,
      hasta: input.hasta ? String(input.hasta) : null,
    };
  }
  return { empresaId: 1, desde: null, hasta: null };
}

function buildDateClause({ tableAlias, cols = ['fecha', 'created_at'], desde, hasta }) {
  // Elige la primera columna que exista y arma filtros entre/desde/hasta
  const col = cols.find(c => true) && cols[0]; // devolvemos la primera; la validación real la hacemos al armar el SQL
  const parts = [];
  if (desde) parts.push(`${tableAlias}.${cols[0] || 'fecha'} >= @desde`);
  if (hasta) parts.push(`${tableAlias}.${cols[0] || 'fecha'} <= @hasta`);
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

// ---------- Lectura de productos ----------
function getProductosByEmpresa(empresaId) {
  if (!hasTable('productos')) return [];
  const cols = getTableCols('productos');
  const hasMin = cols.includes('stock_minimo');
  const hasMax = cols.includes('stock_maximo');
  const hasIni = cols.includes('stock_inicial') || cols.includes('stock');

  const stockIniCol = cols.includes('stock_inicial') ? 'stock_inicial'
                    : cols.includes('stock') ? 'stock'
                    : null;

  const sql = `
    SELECT id, nombre, empresa_id
           ${hasMin ? ', stock_minimo AS min' : ', 0 AS min'}
           ${hasMax ? ', stock_maximo AS max' : ', 0 AS max'}
           ${stockIniCol ? `, ${stockIniCol} AS stock_inicial` : ', 0 AS stock_inicial'}
    FROM productos
    WHERE empresa_id = @empresaId
    ORDER BY nombre COLLATE NOCASE
  `;
  return db.prepare(sql).all({ empresaId });
}

// ---------- Ventas (monto) ----------
export function procesarTotalVenta(opts = {}) {
  const { empresaId, desde, hasta } = parseOpts(opts);

  if (!hasTable('pedidos')) return 0;

  const hasPE = hasTable('puntos_entrega');
  const estadoExpr = `LOWER(p.estado)`;
  const estadosOk = ['entregado', 'confirmado']; // tolerante
  const fechaCol = hasCol('pedidos', 'fecha') ? 'p.fecha'
                 : hasCol('pedidos', 'created_at') ? 'p.created_at'
                 : null;

  const dateClause = (desde || hasta) && fechaCol
    ? ` AND ${fechaCol} BETWEEN @desde AND @hasta`
    : '';

  const joinEmp = hasPE ? `
    JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
  ` : '';

  const whereEmp = hasPE ? ` AND pe.empresa_id = @empresaId` : '';

  // monto puede ser NULL → COALESCE
  const sql = `
    SELECT COALESCE(SUM(COALESCE(p.monto, 0)), 0) AS total
    FROM pedidos p
    ${joinEmp}
    WHERE ${lowerIn(estadoExpr, estadosOk)}
    ${whereEmp}
    ${dateClause}
  `;

  const params = {
    empresaId,
    ...(desde ? { desde } : {}),
    ...(hasta ? { hasta } : {}),
  };

  try {
    const row = db.prepare(sql).get(params) || { total: 0 };
    return toNum(row.total);
  } catch (e) {
    console.error('[stockServices] procesarTotalVenta error:', e?.message || e);
    return 0;
  }
}

// ---------- Unidades vendidas (por producto) ----------
function getUnidadesVendidasPorProducto({ empresaId, desde, hasta }) {
  if (!hasTable('items_pedido') || !hasTable('pedidos')) return new Map();

  const peOk = hasTable('puntos_entrega');
  const colsIP = getTableCols('items_pedido');
  const hasProdId = colsIP.includes('producto_id');
  const hasProdName = colsIP.includes('producto');

  const prodSel = hasProdId ? 'ip.producto_id AS producto_id'
                  : hasProdName ? 'ip.producto  AS producto_nombre'
                  : 'ip.producto  AS producto_nombre';

  const estadoExpr = `LOWER(p.estado)`;
  const estadosOk = ['entregado', 'confirmado'];

  // columna de fecha en pedidos
  const fechaCol = hasCol('pedidos', 'fecha') ? 'p.fecha'
                 : hasCol('pedidos', 'created_at') ? 'p.created_at'
                 : null;
  const dateClause = (desde || hasta) && fechaCol
    ? ` AND ${fechaCol} BETWEEN @desde AND @hasta`
    : '';

  const joinEmp = peOk ? `JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id` : '';
  const whereEmp = peOk ? ` AND pe.empresa_id = @empresaId` : '';

  const sql = `
    SELECT ${prodSel}, COALESCE(SUM(COALESCE(ip.cantidad, 0)), 0) AS unidades
    FROM items_pedido ip
    JOIN pedidos p ON p.id = ip.pedido_id
    ${joinEmp}
    WHERE ${lowerIn(estadoExpr, estadosOk)}
    ${whereEmp}
    ${dateClause}
    GROUP BY 1
  `;
  const params = { empresaId, ...(desde ? { desde } : {}), ...(hasta ? { hasta } : {}) };

  const map = new Map();
  try {
    const rows = db.prepare(sql).all(params);
    for (const r of rows) {
      if ('producto_id' in r && r.producto_id != null) {
        map.set(toInt(r.producto_id), toNum(r.unidades));
      } else {
        // si viene por nombre, resolvemos al id por nombre exacto (mejorable)
        if (!hasTable('productos')) continue;
        const prod = db.prepare(`
          SELECT id FROM productos
          WHERE empresa_id = @empresaId AND LOWER(nombre) = LOWER(@nombre)
          LIMIT 1
        `).get({ empresaId, nombre: r.producto_nombre });
        if (prod?.id) map.set(toInt(prod.id), toNum(r.unidades));
      }
    }
  } catch (e) {
    console.error('[stockServices] getUnidadesVendidasPorProducto error:', e?.message || e);
  }
  return map;
}

// ---------- Entradas/Ajustes (por producto) ----------
function getMovimientosPorProducto({ empresaId, desde, hasta }) {
  // Soporta varios nombres de tabla:
  const candidates = ['chofer_stock_mov', 'stock_movimientos', 'stock_movs', 'movimientos_stock'];
  const table = candidates.find(t => hasTable(t));
  if (!table) return new Map();

  const cols = getTableCols(table);
  const hasProdId = cols.includes('producto_id');
  const hasProdName = cols.includes('producto');
  const hasEmpCol = cols.includes('empresa_id');
  const hasCant = cols.includes('cantidad') || cols.includes('unidades') || cols.includes('delta');
  const cantCol = cols.includes('cantidad') ? 'cantidad' : cols.includes('unidades') ? 'unidades' : 'delta';
  const tipoCol = cols.includes('tipo') ? 'tipo' : null;
  const choferCol = cols.includes('chofer_id') ? 'chofer_id' : null;

  // fecha en movimientos
  const fechaCol =
    cols.includes('fecha') ? 'm.fecha'
    : cols.includes('created_at') ? 'm.created_at'
    : null;

  let joinEmp = '';
  let whereEmp = '';
  if (hasEmpCol) {
    whereEmp = ` AND m.empresa_id = @empresaId`;
  } else if (choferCol && hasTable('choferes')) {
    joinEmp = `LEFT JOIN choferes c ON c.id = m.${choferCol}`;
    whereEmp = ` AND c.empresa_id = @empresaId`;
  }

  const dateClause = (desde || hasta) && fechaCol
    ? ` AND ${fechaCol} BETWEEN @desde AND @hasta`
    : '';

  const prodSel = hasProdId ? `m.producto_id AS producto_id`
                  : hasProdName ? `m.producto   AS producto_nombre`
                  : `NULL AS producto_id`;

  const sql = `
    SELECT ${prodSel},
           SUM(CASE
                 ${tipoCol ? `WHEN LOWER(m.${tipoCol}) IN ('entrada','ingreso','ajuste_pos') THEN COALESCE(m.${cantCol},0)` : `WHEN COALESCE(m.${cantCol},0) >= 0 THEN COALESCE(m.${cantCol},0)`}
                 ELSE 0
               END) AS entradas,
           SUM(CASE
                 ${tipoCol ? `WHEN LOWER(m.${tipoCol}) IN ('salida','consumo','ajuste_neg') THEN ABS(COALESCE(m.${cantCol},0))` : `WHEN COALESCE(m.${cantCol},0) < 0 THEN ABS(COALESCE(m.${cantCol},0))`}
                 ELSE 0
               END) AS salidas
    FROM ${table} m
    ${joinEmp}
    WHERE 1=1
      ${whereEmp}
      ${dateClause}
    GROUP BY 1
  `;
  const params = { empresaId, ...(desde ? { desde } : {}), ...(hasta ? { hasta } : {}) };

  const map = new Map();
  try {
    const rows = db.prepare(sql).all(params);
    for (const r of rows) {
      let keyId = null;
      if ('producto_id' in r && r.producto_id != null) {
        keyId = toInt(r.producto_id);
      } else if ('producto_nombre' in r && r.producto_nombre && hasTable('productos')) {
        const prod = db.prepare(`
          SELECT id FROM productos
          WHERE empresa_id = @empresaId AND LOWER(nombre) = LOWER(@nombre)
          LIMIT 1
        `).get({ empresaId, nombre: r.producto_nombre });
        keyId = prod?.id ? toInt(prod.id) : null;
      }
      if (keyId != null) {
        map.set(keyId, { entradas: toNum(r.entradas), salidas: toNum(r.salidas) });
      }
    }
  } catch (e) {
    console.error('[stockServices] getMovimientosPorProducto error:', e?.message || e);
  }
  return map;
}

// ---------- Stock inicial por producto ----------
function getStockInicialPorProducto(empresaId) {
  const prods = getProductosByEmpresa(empresaId);
  const out = new Map();
  for (const p of prods) {
    out.set(toInt(p.id), {
      nombre: q(p.nombre),
      min: toNum(p.min),
      max: toNum(p.max),
      stock_inicial: toNum(p.stock_inicial),
    });
  }
  return out;
}

// ---------- Cálculo por producto ----------
export function calcularStockActual(opts = {}) {
  const { empresaId, desde, hasta } = parseOpts(opts);

  const base = getStockInicialPorProducto(empresaId);    // nombre, min, max, stock_inicial
  const movs = getMovimientosPorProducto({ empresaId, desde, hasta }); // entradas/salidas ajenas a ventas
  const ventas = getUnidadesVendidasPorProducto({ empresaId, desde, hasta }); // unidades salidas por pedidos

  const result = [];
  for (const [prodId, meta] of base.entries()) {
    const mov = movs.get(prodId) || { entradas: 0, salidas: 0 };
    const vendidas = ventas.get(prodId) || 0;

    const entradas = toNum(mov.entradas);
    const salidas = toNum(mov.salidas) + toNum(vendidas);

    const stock_inicial = toNum(meta.stock_inicial);
    const stock_actual = stock_inicial + entradas - salidas;

    result.push({
      producto_id: prodId,
      nombre: meta.nombre,
      min: toNum(meta.min),
      max: toNum(meta.max),
      stock_inicial,
      entradas,
      salidas,
      stock_actual
    });
  }

  // Si hay ventas de productos que no existen en productos (p.ej. históricos)
  for (const [prodId, vendidas] of ventas.entries()) {
    if (!base.has(prodId)) {
      result.push({
        producto_id: prodId,
        nombre: `(ID ${prodId})`,
        min: 0, max: 0,
        stock_inicial: 0,
        entradas: 0,
        salidas: toNum(vendidas),
        stock_actual: 0 - toNum(vendidas)
      });
    }
  }

  // Orden por nombre
  result.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
  return result;
}

// ---------- Resumen global ----------
export function procesarStockGlobal(opts = {}) {
  const { empresaId, desde, hasta } = parseOpts(opts);
  const perProd = calcularStockActual({ empresaId, desde, hasta });

  let stockInicial = 0;
  let totalEntradas = 0;
  let totalSalidas = 0;

  for (const r of perProd) {
    stockInicial += toNum(r.stock_inicial);
    totalEntradas += toNum(r.entradas);
    totalSalidas += toNum(r.salidas);
  }
  const stockFinal = stockInicial + totalEntradas - totalSalidas;

  return { stockInicial, totalEntradas, totalSalidas, stockFinal };
}

// ---------- Alias semántico ----------
export function calcularStockFinal(opts = {}) {
  // mismo contrato que calcularStockActual, mantenemos alias por compatibilidad
  return calcularStockActual(opts);
}

export default {
  procesarTotalVenta,
  procesarStockGlobal,
  calcularStockActual,
  calcularStockFinal
}

// ==== TRANSFERENCIAS ====

function _toDateYYYYMMDD(s) {
  const d = new Date(s || _nowIso());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function registrarTransferenciaDesdeArchivo({
  telefono,
  nombre = 'Cliente',
  ruta,                 // path del archivo guardado en Transferencia/
  fecha = _nowIso(),    // fecha de recepción
  monto = 0,
  chofer_id = null,
  empresa_id = null,
  pedido_id = null
}) {
  const tel = _digitsOnly(telefono);
  if (!tel) throw new Error('telefono requerido en transferencia');
  const fechaDia = _toDateYYYYMMDD(fecha);

  // Si no viene pedido_id, buscamos el último pedido por teléfono
  let pedido = null;
  if (pedido_id) {
    pedido = db.prepare(`SELECT * FROM pedidos WHERE id = ?`).get(pedido_id);
  } else {
    pedido = db.prepare(`
      SELECT p.*
      FROM pedidos p
      JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      WHERE REPLACE(pe.telefono, ?, '') = '' OR REPLACE(?, pe.telefono, '') = ''
      ORDER BY datetime(p.fecha) DESC, p.id DESC
      LIMIT 1
    `).get(tel, tel);
  }

  // Si no hay, creamos PE+Pedido placeholder con empresa resuelta
  if (!pedido) {
    const pe = _upsertPuntoEntregaFromPedido({
      cliente: nombre,
      telefono: tel,
      empresa_id // si viene, se respeta; si no, _resolveEmpresaId lo deduce
    });
    const info = db.prepare(`
      INSERT INTO pedidos (punto_entrega_id, fecha, estado, cantidad, cantidad_entregada, monto, metodo_pago, aviso_recibido, sats)
      VALUES (?, ?, 'Pendiente', 0, 0, 0, 'transferencia', 0, 0)
    `).run(pe.id, _nowIso());
    pedido = db.prepare(`SELECT * FROM pedidos WHERE id = ?`).get(info.lastInsertRowid);
  }

  const infoT = db.prepare(`
    INSERT INTO transferencias
      (pedido_id, chofer_id, fecha, cliente, telefono, monto, estado, comprobante_path, created_at, verified_at)
    VALUES
      (?,        ?,        ?,     ?,       ?,        ?,     'pendiente', ?,               ?,          NULL)
  `).run(
    pedido.id,
    chofer_id || null,
    fechaDia,
    nombre,
    tel,
    Number(monto || 0),
    String(ruta || ''),
    _nowIso()
  );

  return infoT.lastInsertRowid;
}
export function obtenerTransferenciasPorTelefono(telefono, limit = 5) {
  const tel = _digitsOnly(telefono);
  return db.prepare(`
    SELECT id, pedido_id, chofer_id, fecha, cliente, telefono, monto, estado, comprobante_path, created_at, verified_at
    FROM transferencias
    WHERE REPLACE(telefono, ?, '') = '' OR REPLACE(?, telefono, '') = ''
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(tel, tel, limit);
}
export function marcarTransferenciaVerificada(id, { monto = null } = {}) {
  const patchMonto = (monto !== null && monto !== undefined && String(monto) !== '');
  const sql = patchMonto
    ? `UPDATE transferencias SET estado='verificado', verified_at = ?, monto = ? WHERE id = ?`
    : `UPDATE transferencias SET estado='verificado', verified_at = ? WHERE id = ?`;
  const info = patchMonto
    ? db.prepare(sql).run(_nowIso(), Number(monto), Number(id))
    : db.prepare(sql).run(_nowIso(), Number(id));
  return info.changes || 0;
};

