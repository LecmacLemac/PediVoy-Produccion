import { createHash } from 'node:crypto';
import {
  menuFeatureEnabled, normalizeCompanyMenuConfig, normalizeProductAvailabilityConfig,
  serviceDateToday, validateServiceDate, evaluateProductAvailability, menuAddQuantity, menuSubtractQuantity,
} from '../menuAvailability.js';

export function menuError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function menuBusinessFailure(error) {
  if (String(error?.code || '').startsWith('MENU_')) return {
    status: Number(error.statusCode) || 409, error: error.message, code: error.code,
  };
  if (['23514','23503','P0001'].includes(error?.code)
      && /menu/i.test(`${error.constraint || ''} ${error.message || ''}`)) {
    return { status:409, error:'El menú cambió o no tiene cupo disponible', code:'MENU_CONFLICT' };
  }
  return null;
}

export function menuIntentHash({ deliveryDate, channel = 'catalog', items }) {
  const quantities = new Map();
  for (const item of items || []) {
    const key = item.producto_id != null ? `id:${item.producto_id}` : `name:${String(item.producto || '').trim().toLowerCase()}`;
    const quantity = Number(item.cantidad);
    if (!Number.isFinite(quantity) || quantity <= 0) throw menuError('MENU_INVALID_QUANTITY','Cantidad inválida',400);
    const [coefficient, exponent = '0'] = String(quantity).split('e');
    const [integer, fraction = ''] = coefficient.split('.');
    let scale = fraction.length - Number(exponent);
    let units = BigInt(integer + fraction);
    if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
    const previous = quantities.get(key) || {units:0n,scale:0};
    const commonScale = Math.max(previous.scale,scale);
    quantities.set(key,{scale:commonScale,units:previous.units * 10n ** BigInt(commonScale-previous.scale) + units * 10n ** BigInt(commonScale-scale)});
  }
  const canonical = [...quantities].map(([key,value]) => {
    while (value.scale > 0 && value.units % 10n === 0n) { value.units /= 10n; value.scale--; }
    return [key,`${value.units}e-${value.scale}`];
  }).sort(([a],[b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify({date:deliveryDate || null,channel,items:canonical})).digest('hex');
}

// Acquire before application row locks to match the SQL statement-trigger order.
export async function lockMenuWriteBarrier(query) {
  if (!menuFeatureEnabled()) return;
  await query('SELECT id FROM public.menu_write_barrier WHERE id=1 FOR UPDATE');
}

export async function loadMenuCompany(query, empresaId, { lock = false } = {}) {
  const rows = await query(`SELECT menu_config FROM empresas WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [empresaId]);
  if (rows.length !== 1) throw menuError('MENU_TENANT_NOT_FOUND','Empresa no encontrada',404);
  return normalizeCompanyMenuConfig(rows[0].menu_config || {});
}

async function loadProducts(query, empresaId, ids, lock = false, includeVisibility = false) {
  if (!ids.length) return [];
  return query(`SELECT id, disponibilidad_config${includeVisibility ? ', mostrar_en_catalogo, mostrar_en_landing' : ''} FROM productos
    WHERE empresa_id=$1 AND id=ANY($2::int[]) AND deleted_at IS NULL AND COALESCE(activo, true) IS TRUE
    ORDER BY id${lock ? ' FOR SHARE' : ''}`, [empresaId, ids]);
}

async function usedByProduct(query, empresaId, date) {
  const rows = await query(`SELECT producto_id, reservado FROM public.menu_cupos_diarios
    WHERE empresa_id=$1 AND fecha=$2::date`, [empresaId,date]);
  return new Map(rows.map(row => [Number(row.producto_id),Number(row.reservado)]));
}

export async function filterMenuCatalog(query, { empresaId, products, deliveryDate, channel = 'catalog', now = new Date() }) {
  if (!menuFeatureEnabled()) {
    if (deliveryDate !== undefined) throw menuError('MENU_DISABLED','Menús programados deshabilitados');
    return products;
  }
  const company = await loadMenuCompany(query,empresaId);
  if (!company.enabled && deliveryDate === undefined) return products;
  const date = deliveryDate === undefined ? serviceDateToday(company,now) : validateServiceDate({company,deliveryDate,now});
  const configs = await loadProducts(query,empresaId,products.map(p => Number(p.id)),false,true);
  const byId = new Map(configs.map(p => [Number(p.id),p]));
  const used = await usedByProduct(query,empresaId,date);
  return products.flatMap(product => {
    if (!byId.has(Number(product.id))) return [];
    const saved = byId.get(Number(product.id));
    const config = normalizeProductAvailabilityConfig(saved.disponibilidad_config || {});
    if (config.enabled && saved[channel === 'landing' ? 'mostrar_en_landing' : 'mostrar_en_catalogo'] !== true) return [];
    const menu = evaluateProductAvailability({company,productConfig:config,
      deliveryDate:date,channel,now,usedQuantity:used.get(Number(product.id)) || 0});
    return menu.available ? [{...product,menu}] : [];
  });
}

export async function rejectUndatedScheduledItems(query, {empresaId,items}) {
  if (!menuFeatureEnabled()) return;
  const company = await loadMenuCompany(query,empresaId,{lock:true});
  if (!company.enabled) return;
  const ids = [...new Set(items.map(i => Number(i.producto_id ?? i.productoId ?? i.producto_resuelto_id)).filter(Number.isSafeInteger))].sort((a,b)=>a-b);
  const products = await loadProducts(query,empresaId,ids,true);
  if (products.some(p => normalizeProductAvailabilityConfig(p.disponibilidad_config || {}).enabled)) {
    throw menuError('MENU_DATE_REQUIRED','Este producto requiere elegir una fecha desde el catálogo');
  }
}

// Read-only evaluator: PostgreSQL triggers alone own reservation writes.
export async function validateMenuOrder(query, {empresaId,items,deliveryDate,channel='catalog',now=new Date(),pedidoId=null,requireExplicitDate=false,defaultToToday=false,publicProductIds=null,logistics=null}) {
  if (!menuFeatureEnabled()) {
    if (deliveryDate !== undefined) throw menuError('MENU_DISABLED','Menús programados deshabilitados');
    return null;
  }
  const company = await loadMenuCompany(query,empresaId,{lock:true});
  if (!company.enabled && deliveryDate !== undefined) throw menuError('MENU_DISABLED','Menús programados deshabilitados');
  const quantities = new Map();
  for (const item of items || []) {
    const id = Number(item.producto_id ?? item.productoId ?? item.producto_resuelto_id);
    if (Number.isSafeInteger(id) && id > 0) quantities.set(id,menuAddQuantity(quantities.get(id)||0,Number(item.cantidad)));
  }
  const products = await loadProducts(query,empresaId,[...quantities.keys()].sort((a,b)=>a-b),true,publicProductIds !== null);
  if (products.length !== quantities.size) throw menuError('MENU_PRODUCT_UNAVAILABLE','Producto no disponible');
  if (company.enabled && publicProductIds !== null) {
    const manual = new Set(publicProductIds.map(Number));
    const flag = channel === 'landing' ? 'mostrar_en_landing' : 'mostrar_en_catalogo';
    if (products.some(p => manual.has(Number(p.id)) && normalizeProductAvailabilityConfig(p.disponibilidad_config || {}).enabled && p[flag] !== true)) {
      throw menuError('MENU_PRODUCT_UNAVAILABLE','Producto no disponible en este canal');
    }
  }
  const scheduled = company.enabled && products.some(p => normalizeProductAvailabilityConfig(p.disponibilidad_config || {}).enabled);
  if (!deliveryDate && !company.enabled && !scheduled) return null;
  const initialNow = typeof now === 'function' ? now() : now;
  if (deliveryDate === undefined && defaultToToday && company.enabled) deliveryDate = serviceDateToday(company,initialNow);
  if (!deliveryDate && (scheduled || requireExplicitDate)) throw menuError('MENU_DATE_REQUIRED','Debe elegir una fecha de entrega',400);
  const date = validateServiceDate({company,deliveryDate,now:initialNow});
  const used = await usedByProduct(query,empresaId,date);
  if (pedidoId) {
    const own = await query(`SELECT i.producto_id, SUM(i.cantidad) AS cantidad
      FROM items_pedido i JOIN pedidos p ON p.id=i.pedido_id
      WHERE p.id=$1 AND p.empresa_id=$2 AND p.estado <> 'cancelado'
        AND p.fecha_entrega_programada=$3::date GROUP BY i.producto_id`,[pedidoId,empresaId,date]);
    for (const row of own) used.set(Number(row.producto_id),Math.max(0,menuSubtractQuantity(used.get(Number(row.producto_id))||0,Number(row.cantidad))));
  }
  // Capture the clock only after the potentially blocking company/product reads.
  const evaluatedNow = typeof now === 'function' ? now() : now;
  validateServiceDate({company,deliveryDate:date,now:evaluatedNow});
  if (logistics) {
    const days = logistics.dias_habiles ?? [1,2,3,4,5];
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const today = serviceDateToday(company,evaluatedNow);
    const delay = Math.max(0,Number(logistics.tiempo_entrega_dias) || 0);
    const leadDays = (new Date(`${date}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000;
    const holiday = `${date.slice(8,10)}/${date.slice(5,7)}`;
    const isHoliday = Array.isArray(logistics.feriados) && logistics.feriados.some(day => day?.fecha === holiday);
    if ((Array.isArray(days) && !days.map(Number).includes(weekday)) || leadDays < delay || isHoliday) {
      throw menuError('MENU_LOGISTICS_CLOSED','No hay reparto en la fecha elegida');
    }
  }
  for (const product of products) {
    const menu = evaluateProductAvailability({company,productConfig:product.disponibilidad_config || {},deliveryDate:date,
      channel,now:evaluatedNow,usedQuantity:used.get(Number(product.id))||0});
    if (!menu.available || (menu.remaining != null && quantities.get(Number(product.id)) > menu.remaining)) {
      throw menuError('MENU_UNAVAILABLE','El producto no está disponible en la fecha elegida');
    }
  }
  return {date,company,scheduled};
}

export async function validatePersistedMenuOrder(query, {pedidoId,empresaId,baselineItems=null}) {
  if (!menuFeatureEnabled()) return null;
  const rows = await query(`SELECT estado, menu_channel, to_char(fecha_entrega_programada, 'YYYY-MM-DD') AS fecha_entrega_programada FROM pedidos WHERE id=$1 AND empresa_id=$2`, [pedidoId,empresaId]);
  if (rows.length !== 1) throw menuError('MENU_ORDER_NOT_FOUND','Pedido no encontrado',404);
  if (rows[0].estado === 'cancelado' || rows[0].estado === 'entregado') return null;
  let items = await query('SELECT producto_id, cantidad FROM items_pedido WHERE pedido_id=$1 ORDER BY id', [pedidoId]);
  if (baselineItems?.length && rows[0].fecha_entrega_programada) {
    const before = new Map();
    const after = new Map();
    for (const item of baselineItems) before.set(Number(item.producto_id),menuAddQuantity(before.get(Number(item.producto_id))||0,Number(item.cantidad)));
    for (const item of items) after.set(Number(item.producto_id),menuAddQuantity(after.get(Number(item.producto_id))||0,Number(item.cantidad)));
    items = [...after].filter(([id,quantity])=>quantity>(before.get(id)||0)).map(([producto_id,cantidad])=>({producto_id,cantidad}));
    if (!items.length) return null; // reductions never revoke existing commitments
  }
  return validateMenuOrder(query, {empresaId,pedidoId,items,deliveryDate:rows[0].fecha_entrega_programada || undefined,channel:rows[0].menu_channel ?? 'catalog',now:()=>new Date()});
}

export async function publicMenuDates(query,{empresaId,deliveryDate,now=new Date()}) {
  if (!menuFeatureEnabled()) return {enabled:false};
  const company = await loadMenuCompany(query,empresaId);
  const today = serviceDateToday(company,now);
  if (!company.enabled) return {enabled:false};
  const selected_date = deliveryDate === undefined ? today : validateServiceDate({company,deliveryDate,now});
  const dates = [];
  const limit = company.advance_enabled ? company.max_advance_days : 0;
  for (let offset=0; offset<=limit; offset++) {
    const day = new Date(`${today}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate()+offset);
    const date = day.toISOString().slice(0,10);
    try { validateServiceDate({company,deliveryDate:date,now}); dates.push(date); } catch (error) {
      if (!error.statusCode) throw error;
    }
  }
  return {enabled:true,timezone:company.timezone,today,selected_date,advance_enabled:company.advance_enabled,max_advance_days:company.max_advance_days,dates};
}
