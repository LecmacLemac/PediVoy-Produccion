// --- AUTH & GLOBALS (modo seguro: cookie httpOnly) ---
const authFetch = (url, opts = {}) => {
  const { headers = {}, ...rest } = opts;
  return fetch(url, { ...rest, headers, credentials: 'include' });
};

// ====== UTILS & HELPERS ======
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function debounce(fn, wait = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// Función de escape HTML (seguridad)
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

// Formateo de dinero ARS
const money = n => '$ ' + Number(n||0).toLocaleString('es-AR');

// Obtiene la fecha local de HOY (YYYY-MM-DD)
const getOyString = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0,10);
};

// Convierte fecha de DB a YYYY-MM-DD en zona Argentina para comparar sin desfases
const isoToLocalYMD = (iso) => {
    if(!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
};

// Fecha (DD/MM/YYYY) en AR
const formatFechaAR = (iso) => {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
};

// Fecha + hora en AR (para movimientos de activos)
const formatFechaHoraAR = (iso) => {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
};

// ====== STATE ======
let me = null, pedidos = [], zonas = [], misZonas = [], verificadas = new Set();
let depositos = [];
let gastoEditRow = null;
let map, mapMarkers, myCosts = {};
let routePlan = { orderedIds: [], currentIndex: 0, updatedAt: null };
let slaEtaThresholdMin = 30;
let lastSlaToastAt = 0;
let activosModalState = { pedidoId: null, data: null };
let qrPagoState = { pedidoId: null, link: null };
let pedidoEnProcesoId = null;
let pedidosLastSyncAt = null;
const gpsSyncState = {
  disabled: true,
  denied: false,
  nextInMs: 60_000,
  maxMs: 10 * 60_000,
  lastOkAt: null,
};

const GEO_OPTS_ACTIVATE = {
  enableHighAccuracy: true,
  timeout: 15_000,
  maximumAge: 10_000,
};

const GEO_OPTS_TRACK = {
  enableHighAccuracy: true,
  timeout: 15_000,
  maximumAge: 10_000,
};

const FILTROS_LS_KEY = 'repartidor:filtros:v1';

function saveFiltrosUI() {
  try {
    const payload = {
      estado: $('#fEstado')?.value || '',
      zona: $('#fZona')?.value || '',
      soloHoy: !!$('#fHoy')?.checked,
      search: $('#fSearch')?.value || ''
    };
    safeStorage.local.set(FILTROS_LS_KEY, JSON.stringify(payload));
  } catch {}
}

function restoreFiltrosUI() {
  try {
    const raw = safeStorage.local.get(FILTROS_LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);

    if ($('#fEstado') && typeof data.estado === 'string') $('#fEstado').value = data.estado;
    if ($('#fSearch') && typeof data.search === 'string') $('#fSearch').value = data.search;
    if ($('#fHoy') && typeof data.soloHoy === 'boolean') $('#fHoy').checked = data.soloHoy;

    // fZona se re-aplica en loadZonas() cuando existan options
    if ($('#fZona') && typeof data.zona === 'string') $('#fZona').dataset.pendingValue = data.zona;
  } catch {}
}

function updatePedidosSyncInfo() {
  const el = $('#pedidosSyncInfo');
  if (!el) return;

  if (!pedidosLastSyncAt) {
    el.textContent = 'Sin sincronizar';
    return;
  }

  const diffSec = Math.max(0, Math.floor((Date.now() - pedidosLastSyncAt) / 1000));
  if (diffSec < 5) {
    el.textContent = 'Actualizado recién';
  } else if (diffSec < 60) {
    el.textContent = `Actualizado hace ${diffSec}s`;
  } else {
    const mins = Math.floor(diffSec / 60);
    el.textContent = `Actualizado hace ${mins}m`;
  }
}

// Locks simples para evitar doble envío (doble tap / mala señal)
const __locks = new Map();
async function withLock(key, fn) {
  if (__locks.get(key)) {
    toast('⏳ Ya estoy procesando...');
    return null;
  }
  __locks.set(key, true);
  try {
    return await fn();
  } finally {
    __locks.delete(key);
  }
}

// Config de pagos de la empresa (canales habilitados)
let pagosCanales = {
  efectivo: true,
  transferencia: true,
  cuenta_corriente: true,
  qr_dinamico: false,
};
let preferidoPago = null;


// --- API HELPER ---
function isAuthRedirectError(err) {
  return !!(err && (err.redirectedToLogin || err.code === 'AUTH_REDIRECT' || err.status === 401));
}

async function api(path, opts = {}) {
  const { body, headers: customHeaders = {}, ...fetchOpts } = opts;
  const isFD = body instanceof FormData;

  let r;
  try {
    r = await authFetch(path, {
      ...fetchOpts,
      method: opts.method || 'GET',
      headers: {
        ...customHeaders,
        ...(isFD ? {} : { 'Content-Type': 'application/json' })
      },
      body: isFD ? body : (body ? JSON.stringify(body) : undefined)
    });
  } catch (err) {
    // Errores de red (offline, timeout, DNS, etc.)
    const e = new Error('Sin conexión. Reintentá.');
    e.cause = err;
    e.status = 0;
    e.url = path;
    throw e;
  }

  if (r.status === 401) {
    const e = new Error('Sesión vencida');
    e.status = 401;
    e.url = path;
    e.code = 'AUTH_REDIRECT';
    e.redirectedToLogin = true;
    location.href = 'login.html';
    throw e;
  }

  if (r.status === 204) return null;

  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const txt = await r.text();

  // Intentar extraer mensaje de error útil
  const buildErr = (fallback) => {
    const msg = fallback || `HTTP ${r.status}`;
    const e = new Error(msg);
    e.status = r.status;
    e.url = path;
    return e;
  };

  // Si no hay body
  if (!txt) {
    if (!r.ok) throw buildErr();
    return {};
  }

  // Si viene JSON
  if (ct.includes('application/json')) {
    let data;
    try {
      data = JSON.parse(txt);
    } catch {
      // JSON inválido
      if (!r.ok) throw buildErr(`Error ${r.status}: JSON inválido`);
      throw buildErr(`Respuesta JSON inválida (${r.status})`);
    }

    if (!r.ok) {
      const msg = (data && (data.error || data.message)) || `Error ${r.status}`;
      throw buildErr(msg);
    }

    return data;
  }

  // No JSON
  if (!r.ok) {
    console.error('Respuesta NO JSON de', path, 'status', r.status, 'body:', txt.slice(0, 200));
    throw buildErr(`Error ${r.status}: respuesta no JSON`);
  }

  // OK pero no JSON (no debería pasar en esta app); devolvemos texto para no romper
  return { ok: true, text: txt };
}

function notifyError(userMsg, err) {
  if (isAuthRedirectError(err)) return;
  // Mensaje corto para el repartidor + log técnico en consola
  if (err) console.warn(userMsg, err);
  try { toast('❌ ' + userMsg); } catch {}
}

// --- INITIALIZATION ---
async function bootRepartidorPanel() {
  try {
    // 1. Cargar Usuario
    const j = await api('/api/me');
    if (!j || !j.user) {
      location.href = 'login.html';
      return;
    }

    me = j.user;
    $('#brandTitle').textContent = `Hola, ${me.username}`;
    restoreRoutePlan();
    loadRouteSlaThreshold();

    // Botón GPS visible + activación manual
    restoreGpsPreference();
    updateGpsButtonUI();
    const gpsBtn = document.getElementById('btnGpsHelp');
    if (gpsBtn) {
      gpsBtn.onclick = async (e) => {
        e.preventDefault();
        await requestGpsActivation();
      };
    }

    // 2. Config de pagos de la empresa (canales habilitados)
    try {
      const cfg = await api('/api/empresa/config');
      const pagos = cfg.pagos || {};
      const canales = pagos.canales || {};

      pagosCanales = {
        efectivo: canales.efectivo !== false,
        transferencia: canales.transferencia !== false,
        cuenta_corriente: canales.cuenta_corriente !== false,
        qr_dinamico: !!canales.qr_dinamico,
      };
      preferidoPago = pagos.preferido || null;
    } catch (e) {
      console.warn('Sin config de pagos, usando defaults', e);
      // dejamos pagosCanales con los defaults definidos arriba
    }

    // 3. Cargar Costos del Chofer
    try {
      const costosRes = await api(`/api/choferes/${me.chofer_id}/costos`);
      if (Array.isArray(costosRes)) {
        costosRes.forEach(c => {
          myCosts[c.producto_id] = c.costo_unitario;
        });
      }
    } catch (e) {
      console.warn('Sin costos asignados');
    }

    // 4. Inicializar Fechas
    const today = getOyString();
    const last30 = new Date();
    last30.setDate(last30.getDate() - 29);
    const last30Ymd = last30.toISOString().slice(0, 10);

    $('#resDate').value = today;
    $('#resDate').max = today;
    $('#resDate').min = last30Ymd;
    $('#stDate').value = today;
    $('#gFecha').value = today;
    $('#tfDate').value = today;
    if ($('#evDateFrom')) $('#evDateFrom').value = today;
    if ($('#evDateTo')) $('#evDateTo').value = today;

    // 5. Restaurar filtros de Pedidos persistidos
    restoreFiltrosUI();

    // 6. Cargar Datos Principales
    await Promise.all([
      loadZonas(),
      loadMisZonas(),
      loadPedidos(),
      gLoadProductos(),
      gLoadDepositos()
    ]);

    // Auto refresh suave de pedidos para operación en tiempo real
    startPedidosAutoRefresh();

  } catch (e) {
    if (isAuthRedirectError(e)) return;
    console.error('Boot repartidor falló', e);
    notifyError('No se pudo iniciar el panel', e);
  }
}
