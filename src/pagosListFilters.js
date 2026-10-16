// Shared, parameterized predicates for the three Pagos list sources.
function invalid(field) {
  const error = new Error(`${field} inválido`);
  error.statusCode = 400;
  return error;
}

function dateOnly(value, field) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) throw invalid(field);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
}

function cursorDate(value) {
  if (value === undefined) return null;
  if (value === '-infinity') return value; // Only the explicit NULL-date cursor sentinel is allowed.
  if (typeof value !== 'string' || value.length > 32
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)) throw invalid('before_fecha');
  dateOnly(value.slice(0,10), 'before_fecha');
  if (!Number.isFinite(Date.parse(value))) throw invalid('before_fecha');
  return value;
}

export function parsePagosListQuery(query = {}) {
  for (const field of ['estado', 'estado_revision', 'empresa_id', 'chofer_id', 'cuenta_bancaria_id', 'limit', 'offset']) {
    const value = query[field];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string') throw invalid(field);
    if (['empresa_id', 'chofer_id', 'cuenta_bancaria_id', 'limit', 'offset'].includes(field)) {
      if (field === 'cuenta_bancaria_id' && value === 'no_detectada') continue;
      const numeric = Number(value);
      const minimum = ['limit', 'offset'].includes(field) ? 0 : 1;
      if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(numeric) || numeric < minimum
        || (!['limit', 'offset'].includes(field) && numeric > 2147483647)) throw invalid(field);
    }
  }
  if (query.q !== undefined && typeof query.q !== 'string') throw invalid('q');
  if ((query.q || '').length > 120) throw invalid('q');
  const fecha = dateOnly(query.fecha, 'fecha');
  const desde = dateOnly(query.desde, 'desde');
  const hasta = dateOnly(query.hasta, 'hasta');
  if (desde && hasta && desde > hasta) throw invalid('rango de fechas');
  let beforeId = null;
  if (query.before_id !== undefined) {
    if (typeof query.before_id !== 'string' || !/^\d{1,16}$/.test(query.before_id)
      || !Number.isSafeInteger(Number(query.before_id)) || Number(query.before_id) <= 0) throw invalid('before_id');
    beforeId = query.before_id;
  }
  const beforeFecha = cursorDate(query.before_fecha);
  if (beforeFecha && !beforeId) throw invalid('before_id');
  return { q: (query.q || '').trim(), fecha, desde, hasta, beforeId, beforeFecha };
}

// Preserve PostgreSQL microseconds; pg's Date parser truncates to milliseconds.
export const pagosCursorFechaSql = date => `CASE WHEN (${date}) IS NULL THEN '-infinity' ELSE to_char((${date}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS cursor_fecha`;

export function appendPagosCursor({ sql, params, idx, filters, date, id }) {
  if (filters.beforeId) {
    if (filters.beforeFecha) {
      sql += ` AND (COALESCE(${date}, '-infinity'::timestamptz), ${id}) < ($${idx++}::timestamptz, $${idx++}::bigint)`;
      params.push(filters.beforeFecha, filters.beforeId);
    } else {
      sql += ` AND ${id} < $${idx++}::bigint`;
      params.push(filters.beforeId);
    }
  }
  return { sql, params, idx };
}

export function appendPagosDates({ sql, params, idx, filters, date }) {
  // Legacy fecha remains a single-day constraint; explicit ranges intersect it.
  for (const [value, upper] of [[filters.fecha, false], [filters.fecha, true], [filters.desde, false], [filters.hasta, true]]) {
    if (!value) continue;
    const localMidnight = upper ? `($${idx}::date + INTERVAL '1 day')` : `$${idx}::date::timestamp`;
    sql += ` AND ${date} ${upper ? '<' : '>='} (${localMidnight} AT TIME ZONE 'America/Argentina/Buenos_Aires')`;
    params.push(value);
    idx++;
  }
  return { sql, params, idx };
}

const foldSql = expression => `lower(translate(COALESCE(${expression}, ''), 'áàäâãåéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ', 'aaaaaaeeeeiiiiooooouuuuncAAAAAAEEEEIIIIOOOOOUUUUNC'))`;
const foldText = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const literalLike = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;

export function appendPagosSearch({ sql, params, idx, q, cliente = 'pe.cliente', phones = ['pe.telefono'], pedido, references = [] }) {
  if (!q) return { sql, params, idx };
  const bind = value => { params.push(value); return `$${idx++}`; };
  const text = bind(literalLike(foldText(q)));
  const alternatives = [`${foldSql(cliente)} LIKE ${text} ESCAPE E'\\\\'`];
  for (const reference of references) alternatives.push(`${foldSql(`${reference}::text`)} LIKE ${text} ESCAPE E'\\\\'`);
  const digits = q.replace(/\D/g, '');
  if (digits && /^[+\d\s().-]+$/.test(q)) {
    const phone = bind(literalLike(digits));
    for (const expression of phones) alternatives.push(`regexp_replace(COALESCE(${expression}, ''), '[^0-9]', '', 'g') LIKE ${phone} ESCAPE E'\\\\'`);
  }
  if (/^#?\d+$/.test(q)) {
    // Text equality avoids unsafe Number conversion and overflowing PostgreSQL IDs.
    const id = q.replace(/^#/, '').replace(/^0+(?=\d)/, '');
    alternatives.push(`${pedido}::text = ${bind(id)}`);
  }
  sql += ` AND (${alternatives.join(' OR ')})`;
  return { sql, params, idx };
}
