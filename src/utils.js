// src/utils.js (ESM)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ray casting para saber si un punto [x, y] está dentro de un polígono [[x,y], ...]
 */
export function pointInPolygon(point, vs) {
  if (!point || !Array.isArray(vs) || vs.length < 3) return false;

  const x = Number(point[0]); // lng
  const y = Number(point[1]); // lat

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [vx, vy] of vs) {
    const X = Number(vx);
    const Y = Number(vy);
    if (X < minX) minX = X;
    if (X > maxX) maxX = X;
    if (Y < minY) minY = Y;
    if (Y > maxY) maxY = Y;
  }
  if (x < minX || x > maxX || y < minY || y > maxY) return false;

  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = Number(vs[i][0]), yi = Number(vs[i][1]);
    const xj = Number(vs[j][0]), yj = Number(vs[j][1]);

    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);

    if (intersect) inside = !inside;
  }
  return inside;
}

/** Fecha/hora actual en ISO 8601 (UTC). */
export function nowIso() {
  return new Date().toISOString();
}

/* ======================== */
/* Utilidades para WhatsApp */
/* ======================== */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

export function guardarEnHistorial(numero, texto) {
  try {
    const ts = new Date();
    const day = ts.toISOString().slice(0, 10).replace(/-/g, '');
    const line = `[${ts.toISOString()}] ${String(numero)} | ${String(texto).replace(/\s+/g, ' ').trim()}\n`;
    fs.appendFileSync(path.join(LOG_DIR, `whatsapp-${day}.log`), line, 'utf8');
  } catch { /* noop */ }
}

export function formatARS(n) {
  const num = Number(n || 0);
  return '$ ' + num.toLocaleString('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
}

function capitalize(s = '') {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ----------------------------------------------------------------------
// 🧠 LÓGICA INTELIGENTE DE FECHAS (NUEVO)
// ----------------------------------------------------------------------

/**
 * Calcula la fecha real de entrega basándose en la configuración de la empresa.
 * @param {Object} config - Configuración { dias_habiles: [1..5], delay: 0, feriados: [{fecha:'25/12', motivo:'Navidad'}] }
 * @param {Date} fechaBase - Fecha de solicitud (hoy)
 */
export function calcularFechaEntregaReal(config, fechaBase = new Date()) {
  const d = new Date(fechaBase);
  // Por defecto Lunes a Viernes si no hay config
  const diasHabilitados = config?.dias_habiles || [1, 2, 3, 4, 5]; 
  const delay = Number(config?.tiempo_entrega_dias || 0);
  const feriados = config?.feriados || []; // Array de { fecha: 'DD/MM', motivo: '...' }

  // 1. Aplicar delay inicial (días de preparación)
  d.setDate(d.getDate() + delay);

  // 2. Buscar el siguiente día válido (que esté en diasHabilitados y NO sea feriado)
  let intentos = 0;
  let motivoFeriado = null;

  // Límite de seguridad de 30 días para evitar loops infinitos
  while (intentos < 30) { 
    const diaSemana = d.getDay(); // 0=Dom, 6=Sab
    const diaMes = d.getDate();
    const mes = d.getMonth() + 1; // 0-based
    
    // Formato DD/MM para comparar con la lista de feriados
    const fechaStr = `${String(diaMes).padStart(2, '0')}/${String(mes).padStart(2, '0')}`;
    
    // Chequear si es feriado
    const esFeriado = feriados.find(f => f.fecha === fechaStr);

    if (esFeriado) {
      // Si cae en feriado, guardamos el motivo y saltamos al día siguiente
      motivoFeriado = esFeriado.motivo; 
      d.setDate(d.getDate() + 1);
      intentos++;
      continue; // Volvemos a evaluar el nuevo día
    }

    // Chequear si es día laborable permitido
    if (diasHabilitados.includes(diaSemana)) {
      // Es día válido y no es feriado. Terminamos.
      break; 
    }

    // Si no es válido (ej: Domingo), avanzamos
    d.setDate(d.getDate() + 1);
    intentos++;
  }

  return { fecha: d, motivoFeriado };
}

export function normalizarDiasEntrega(dias) {
  if (!Array.isArray(dias)) return [];
  return [...new Set(
    dias
      .filter((d) => d !== null && d !== undefined && d !== '')
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  )].sort((a, b) => a - b);
}

export function resolverConfigEntregaPorZona(configEntrega = {}, zona = {}) {
  const diasZona = normalizarDiasEntrega(zona?.dias_entrega);
  if (!diasZona.length) return configEntrega || {};
  return {
    ...(configEntrega || {}),
    dias_habiles: diasZona,
    zona_nombre: zona?.nombre || zona?.zona_nombre || undefined,
  };
}

/**
 * Arma el mensaje de confirmación usando la configuración de entrega de la empresa.
 * Acepta el objeto `configEntrega` que viene de la base de datos.
 */
export function armarMensajeConfirmado({ cliente, items = [], direccion, fecha, fechaEntrega, repartidor, configEntrega, retornablesPendientes = [] }) {
  // 1) Agrupar ítems
  const grupos = new Map();
  for (const it of items) {
    const nombre = String(it.producto || '').trim();
    if (!nombre) continue;
    const key = nombre.toLowerCase();
    const cant = Math.max(0, Number(it.cantidad || 0));
    const pu   = Math.max(0, Number(it.precio_unitario || 0));
    const prev = grupos.get(key) || { producto: nombre, cantidad: 0, subtotal: 0 };
    prev.cantidad += cant;
    prev.subtotal += cant * pu;
    grupos.set(key, prev);
  }

  const agrupados = [...grupos.values()];
  const totalMonto = agrupados.reduce((a, b) => a + b.subtotal, 0);

  // 2) CALCULO DE FECHA INTELIGENTE
  // Usamos la nueva función con la config que viene de la DB
  const calculo = fechaEntrega
    ? { fecha: new Date(fechaEntrega), motivoFeriado: null }
    : calcularFechaEntregaReal(configEntrega, fecha || new Date());
  const fechaReal = calculo.fecha;
  
  const diaNombre = new Intl.DateTimeFormat('es-AR', { weekday: 'long' }).format(fechaReal);
  const diaNumero = fechaReal.getDate();
  const fechaTexto = `${capitalize(diaNombre)} ${diaNumero}`;

  // 3) Cuerpo del mensaje
  const L = [];
  L.push(`¡Hola ${cliente || 'Cliente'}!`);
  L.push(`✅ Tu pedido está "Confirmado".`);
  L.push('');

  for (const it of agrupados) {
    L.push(`      ${it.cantidad} ${it.producto} - ${formatARS(it.subtotal)}`);
  }
  
  L.push(`Total: ${formatARS(totalMonto)}`);
  L.push('');
  
  if (direccion) L.push(`🏡 Entrega: ${direccion}`);
  L.push(`📆 Fecha: ${fechaTexto}`);

  // Si hubo salto por feriado, avisamos sutilmente
  if (calculo.motivoFeriado) {
    L.push(`(Reprogramado por ${calculo.motivoFeriado} )`);
  }

  // Horarios personalizados de la empresa (Texto libre, ej: "9 a 18hs")
  if (configEntrega?.horarios) {
    L.push(`⏰ Horario: ${configEntrega.horarios}`);
  }

  const retornables = (Array.isArray(retornablesPendientes) ? retornablesPendientes : [])
    .map((r) => ({
      producto: String(r?.producto || r?.nombre || r?.producto_nombre || 'Retornable').trim(),
      saldo: Number(r?.saldo || 0),
    }))
    .filter((r) => r.producto && Number.isFinite(r.saldo) && r.saldo > 0);

  if (retornables.length) {
    L.push('');
    L.push('♻️ Retornables pendientes:');
    for (const r of retornables) {
      L.push(`Recordá entregar ${r.saldo.toLocaleString('es-AR')} ${r.producto} al repartidor.`);
    }
  }

  L.push('');
  
  // CORRECCIÓN AQUÍ: Solo mostrar teléfono si el chofer existe
  L.push(`Repartidor: ${repartidor?.nombre || 'A asignar'}`);
  
  if (repartidor?.telefono) {
    L.push(`📞 ${repartidor.telefono}`);
  }
  
  L.push('');
  L.push(`¡Gracias por elegirnos!`);

  return L.join('\n');
}

// Mantener compatibilidad con imports viejos si es necesario
export const esHorarioComercial = (d) => true; 
export const obtenerProximoDiaHabil = (d) => calcularFechaEntregaReal({}, d).fecha;
export const crearMensaje = () => ""; // Deprecated en favor de armarMensajeConfirmado
export const detectarZonaDesdeDireccion = () => "Sin asignar";

export default {
  pointInPolygon,
  nowIso,
  guardarEnHistorial,
  calcularFechaEntregaReal,
  normalizarDiasEntrega,
  resolverConfigEntregaPorZona,
  armarMensajeConfirmado,
  formatARS
};
