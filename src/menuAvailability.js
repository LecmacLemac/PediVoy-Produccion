/**
 * Política pura: recibe menu_config/disponibilidad_config, nunca filas de DB.
 * El caller aplica la feature flag; sólo menuFeatureEnabled consulta el entorno.
 * No valida stock físico ni precios ni reserva cupos: usedQuantity es el total
 * comprometido compartido entre canales y provisto por la capa transaccional.
 * Configuración/tipos inválidos lanzan Error con statusCode=400 y code estable;
 * rechazos de negocio del evaluador retornan reason (MENU_*), no excepciones.
 * Capacidad/cantidad finita entre 0 y Number.MAX_SAFE_INTEGER, sin coerción.
 */
const COMPANY = {
  version: 1,
  enabled: false,
  timezone: 'America/Argentina/Buenos_Aires',
  advance_enabled: false,
  max_advance_days: 7,
  service_weekdays: [0, 1, 2, 3, 4, 5, 6],
  closed_dates: []
};
const PRODUCT = {
  version: 1,
  enabled: false,
  mode: 'weekly',
  weekdays: [1, 2, 3, 4, 5],
  dates: [],
  allow_advance: true,
  open_days_before: 0,
  open_time: '00:00',
  close_days_before: 0,
  close_time: '23:59',
  daily_capacity: null,
  exceptions: [],
  channels: {}
};
export function menuFeatureEnabled(env = process.env) { return env.SCHEDULED_MENUS_ENABLED === '1'; }
function fail(code, message, statusCode = 400) { throw Object.assign(new Error(message), {code,statusCode}); }
function configError() { fail('MENU_INVALID_CONFIG','Configuración de menú inválida.'); }
function cloneConfig(value) {
  try { return structuredClone(value); } catch { configError(); }
}
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(k => !keys.includes(k))) configError();
}
function boolean(value) { if (typeof value !== 'boolean') configError(); }
function integer(value, max) { if (!Number.isInteger(value) || value < 0 || value > max) configError(); }
function quantity(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
function list(value, valid) { if (!Array.isArray(value) || new Set(value).size !== value.length || !Array.from(value).every(valid)) configError(); }
const OVERRIDES = ['weekdays','dates','open_days_before','open_time','close_days_before','close_time'];
function recurrence(value) {
  if ('weekdays' in value) list(value.weekdays, n => Number.isInteger(n) && n >= 0 && n <= 6);
  if ('dates' in value) list(value.dates, validDate);
  for (const key of ['open_days_before','close_days_before']) if (key in value) integer(value[key],30);
  for (const key of ['open_time','close_time']) if (key in value && (typeof value[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value[key]))) configError();
}
function validWindow(value) {
  const minute = time => Number(time.slice(0,2))*60+Number(time.slice(3));
  if (-value.open_days_before*1440+minute(value.open_time) >= -value.close_days_before*1440+minute(value.close_time)) configError();
}
export function normalizeCompanyMenuConfig(value = {}) {
  object(value,Object.keys(COMPANY));
  const c = {...structuredClone(COMPANY),...cloneConfig(value)};
  if (c.version !== 1) configError();
  boolean(c.enabled); boolean(c.advance_enabled); integer(c.max_advance_days,30);
  if (typeof c.timezone !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(c.timezone) && c.timezone !== 'UTC') configError();
  try { new Intl.DateTimeFormat('en',{timeZone:c.timezone}).format(0); } catch { configError(); }
  list(c.service_weekdays, n => Number.isInteger(n) && n >= 0 && n <= 6);
  list(c.closed_dates,validDate);
  return c;
}
export function normalizeProductAvailabilityConfig(value = {}) {
  object(value,Object.keys(PRODUCT));
  const p = {...structuredClone(PRODUCT),...cloneConfig(value)};
  if (p.version !== 1 || !['weekly','dates'].includes(p.mode)) configError();
  boolean(p.enabled); boolean(p.allow_advance); recurrence(p); validWindow(p);
  if (p.daily_capacity !== null && !quantity(p.daily_capacity)) configError();
  if (!Array.isArray(p.exceptions)) configError();
  const dates = new Set();
  for (const e of p.exceptions) {
    object(e,['date','paused','capacity']);
    if (!validDate(e.date) || dates.has(e.date)) configError();
    dates.add(e.date);
    if ('paused' in e) boolean(e.paused);
    if ('capacity' in e && e.capacity !== null && !quantity(e.capacity)) configError();
  }
  object(p.channels,['catalog','landing']);
  for (const override of Object.values(p.channels)) { object(override,OVERRIDES); recurrence(override); validWindow({...p,...override}); }
  return p;
}
function checkNow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('MENU_INVALID_NOW','El reloj del menú es inválido.');
}
function dayNumber(date) { return new Date(`${date}T00:00:00Z`).getTime()/86400000; }
function weekday(date) { return new Date(`${date}T00:00:00Z`).getUTCDay(); }
function shiftDate(date, days) { return new Date((dayNumber(date)+days)*86400000).toISOString().slice(0,10); }
export function serviceDateToday(company, now = new Date()) {
  checkNow(now);
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:normalizeCompanyMenuConfig(company).timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function serviceDateReason(c, date, today) {
  const days = dayNumber(date)-dayNumber(today);
  if (days < 0) return 'MENU_DATE_PAST';
  if (days > c.max_advance_days) return 'MENU_DATE_OUT_OF_RANGE';
  if (days > 0 && !c.advance_enabled) return 'MENU_ADVANCE_DISABLED';
  if (!c.service_weekdays.includes(weekday(date)) || c.closed_dates.includes(date)) return 'MENU_COMPANY_CLOSED';
  return null;
}
const MESSAGES = {
  MENU_DATE_PAST:'La fecha de entrega ya pasó.',
  MENU_DATE_OUT_OF_RANGE:'La fecha de entrega supera el horizonte permitido.',
  MENU_ADVANCE_DISABLED:'No se permiten pedidos anticipados.',
  MENU_COMPANY_CLOSED:'La empresa no atiende en la fecha seleccionada.'
};
export function validateServiceDate({company,deliveryDate,now = new Date()}) {
  const c = normalizeCompanyMenuConfig(company);
  const today = serviceDateToday(c,now);
  const date = deliveryDate === undefined ? today : deliveryDate;
  if (!validDate(date)) fail('MENU_INVALID_DATE','La fecha de entrega es inválida.');
  const reason = serviceDateReason(c,date,today);
  if (reason) fail(reason,MESSAGES[reason]);
  return date;
}
function localInstant(date, time, timezone) {
  const target = new Date(`${date}T${time}:00Z`).getTime();
  const formatter = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const local = instant => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type,p.value]));
    return new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`).getTime();
  };
  // Resolve a civil clock time by candidate UTC offsets on either side of
  // a transition. Never guess at a DST fold (two matches) or gap (no match).
  // Such a window is unavailable with MENU_INVALID_LOCAL_TIME; callers must
  // choose an unambiguous time in configuration. No timezone dependency/IO.
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = target+hours*3600000;
    offsets.add(local(sample)-sample);
  }
  const candidates = [...offsets].map(offset => target-offset).filter(instant => local(instant) === target);
  return candidates.length === 1 ? candidates[0] : null;
}
// Quantities are decimal business values (PostgreSQL NUMERIC), not money.
// Align the decimal representations before arithmetic: 0.3 - 0.1 is 0.2.
function decimalQuantity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail('MENU_INVALID_QUANTITY','La cantidad es inválida.');
  const [coefficient, exponent = '0'] = String(value).split('e');
  const [integer, fraction = ''] = coefficient.split('.');
  let units = BigInt(integer + fraction), scale = fraction.length - Number(exponent);
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  return {units,scale};
}
function combineQuantity(a, b, subtract) {
  const left = decimalQuantity(a), right = decimalQuantity(b), scale = Math.max(left.scale,right.scale);
  const units = left.units * 10n ** BigInt(scale-left.scale) + (subtract ? -1n : 1n) * right.units * 10n ** BigInt(scale-right.scale);
  const result = Number(`${units}e-${scale}`);
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) fail('MENU_INVALID_QUANTITY','La cantidad supera el límite permitido.');
  return result;
}
export function menuAddQuantity(a,b) { return combineQuantity(a,b,false); }
export function menuSubtractQuantity(a,b) { return combineQuantity(a,b,true); }

export function evaluateProductAvailability({company,productConfig,deliveryDate,channel = 'catalog',now = new Date(),usedQuantity = 0}) {
  const c = normalizeCompanyMenuConfig(company);
  if (!['catalog','landing'].includes(channel)) fail('MENU_INVALID_CHANNEL','El canal de menú es inválido.');
  if (!quantity(usedQuantity)) fail('MENU_INVALID_QUANTITY','La cantidad comprometida es inválida.');
  const p = normalizeProductAvailabilityConfig(productConfig);
  const today = serviceDateToday(c,now);
  const date = deliveryDate === undefined ? today : deliveryDate;
  if (!validDate(date)) fail('MENU_INVALID_DATE','La fecha de entrega es inválida.');
  const result = {
    available: true,
    scheduled: c.enabled && p.enabled,
    reason: null,
    opens_at: null,
    closes_at: null,
    remaining: null,
    timezone: c.timezone,
    advance_allowed: c.enabled && p.enabled && c.advance_enabled && p.allow_advance,
    date
  };
  // Empresa o producto sin programación: disponibilidad legacy sin restricciones.
  // Si el cliente pidió una fecha, la API valida esa intención explícita usando
  // validateServiceDate aunque los productos del carrito sean legacy.
  if (!result.scheduled) return result;
  const unavailable = reason => ({...result,available:false,reason});
  const dateReason = serviceDateReason(c,date,today);
  if (dateReason) return unavailable(dateReason);
  if (date > today && !p.allow_advance) return unavailable('MENU_ADVANCE_DISABLED');
  const rule = {...p,...p.channels[channel]};
  const exception = p.exceptions.find(e => e.date === date);
  const capacity = exception && Object.hasOwn(exception,'capacity') ? exception.capacity : p.daily_capacity;
  result.remaining = capacity === null ? null : Math.max(0,menuSubtractQuantity(capacity,usedQuantity));
  if (exception?.paused) return unavailable('MENU_PAUSED');
  if (!(p.mode === 'weekly' ? rule.weekdays.includes(weekday(date)) : rule.dates.includes(date))) return unavailable('MENU_PRODUCT_NOT_SCHEDULED');
  const opens = localInstant(shiftDate(date,-rule.open_days_before),rule.open_time,c.timezone);
  const closes = localInstant(shiftDate(date,-rule.close_days_before),rule.close_time,c.timezone);
  if (opens === null || closes === null || closes <= opens) return unavailable('MENU_INVALID_LOCAL_TIME');
  result.opens_at = new Date(opens).toISOString();
  result.closes_at = new Date(closes).toISOString();
  if (now.getTime() < opens) return unavailable('MENU_NOT_OPEN');
  if (now.getTime() >= closes) return unavailable('MENU_CLOSED');
  if (result.remaining === 0) return unavailable('MENU_CAPACITY_EXHAUSTED');
  return result;
}
