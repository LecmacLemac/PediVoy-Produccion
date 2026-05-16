const $ = (s) => document.querySelector(s);
const money = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(Number(n || 0));

let empresaId = 1;
let selectedEmpresaId = null;
let telefono = '';
let lastCompaniesLookup = '';
const cart = [];
let ordersTimer = null;
const lastOrderState = new Map();

async function j(url, options = {}) {
  const r = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body?.error || `HTTP ${r.status}`);
    err.data = body;
    err.status = r.status;
    throw err;
  }
  return body;
}

function getSlug() {
  return new URLSearchParams(location.search).get('slug') || '';
}

function onlyDigits(v) {
  return String(v || '').replace(/\D+/g, '');
}

function resolveImageUrl(src) {
  const raw = String(src || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw;
  return `/${raw.replace(/^\/+/, '')}`;
}

function normalizePhoneForInput(v) {
  let d = onlyDigits(v);
  if (d.startsWith('549') && d.length >= 12) d = d.slice(3);
  else if (d.startsWith('54') && d.length >= 11) d = d.slice(2);
  if (d.startsWith('0') && d.length > 10) d = d.slice(1);
  if (d.length > 10) d = d.slice(-10);
  return d;
}

function getSelectedEmpresaId() {
  return Number(selectedEmpresaId || empresaId || 1);
}

function updateAppStats({ companyName = null, cartCount = null, orderCount = null } = {}) {
  const companyEl = $('#stat-company');
  const cartEl = $('#stat-cart');
  const ordersEl = $('#stat-orders');
  if (companyEl && companyName !== null) companyEl.textContent = companyName || 'Sin seleccionar';
  if (cartEl && cartCount !== null) cartEl.textContent = `${cartCount} item${cartCount === 1 ? '' : 's'}`;
  if (ordersEl && orderCount !== null) ordersEl.textContent = `${orderCount} activo${orderCount === 1 ? '' : 's'}`;
}

function renderEmpresaOptions(companies = [], preferredEmpresaId = null) {
  const root = $('#empresa-picker');
  const hint = $('#empresa-hint');
  const otpBtn = $('#btn-otp');
  if (!root || !hint) return;

  if (!companies.length) {
    root.classList.add('hidden');
    root.innerHTML = '';
    hint.textContent = 'Si tu número existe en varias empresas, te las vamos a mostrar acá.';
    updateAppStats({ companyName: 'Sin seleccionar' });
    if (otpBtn) otpBtn.textContent = 'Enviar código';
    return;
  }

  if (companies.length === 1) {
    const only = companies[0];
    selectedEmpresaId = Number(only.id);
    empresaId = selectedEmpresaId;
    root.classList.add('hidden');
    root.innerHTML = '';
    hint.textContent = `Empresa detectada: ${only.nombre}`;
    updateAppStats({ companyName: only.nombre });
    if (otpBtn) otpBtn.textContent = `Enviar código a ${only.nombre}`;
    return;
  }

  const preferred = companies.find((c) => Number(c.id) === Number(preferredEmpresaId)) || null;
  if (!selectedEmpresaId) selectedEmpresaId = Number(preferred?.id || companies[0].id);
  empresaId = getSelectedEmpresaId();

  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="muted small" style="margin-bottom:8px">Elegí con qué empresa querés operar:</div>
    <div id="empresa-options" class="company-options"></div>
  `;

  const list = root.querySelector('#empresa-options');
  companies.forEach((company) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const active = Number(company.id) === Number(selectedEmpresaId);
    btn.className = `company-btn${active ? ' active' : ''}`;
    btn.innerHTML = `${company.nombre}<span class="company-sub">${company.landing_slug ? `@${company.landing_slug}` : 'Cliente asociado'}</span>`;
    btn.addEventListener('click', () => {
      selectedEmpresaId = Number(company.id);
      empresaId = selectedEmpresaId;
      renderEmpresaOptions(companies, preferredEmpresaId);
    });
    list.appendChild(btn);
  });

  const current = companies.find((c) => Number(c.id) === Number(selectedEmpresaId));
  hint.textContent = current ? `Vas a ingresar a: ${current.nombre}` : 'Elegí una empresa para continuar.';
  updateAppStats({ companyName: current?.nombre || 'Sin seleccionar' });
  if (otpBtn) otpBtn.textContent = current ? `Enviar código a ${current.nombre}` : 'Enviar código';
}

async function lookupCompaniesForPhone() {
  telefono = normalizePhoneForInput($('#telefono').value.trim());
  $('#telefono').value = telefono;
  if (telefono.length < 8) throw new Error('Completá un teléfono válido');

  const normalized = telefono;
  if (normalized === lastCompaniesLookup && selectedEmpresaId) return [];

  const out = await j('/api/public/app/auth/companies', {
    method: 'POST',
    body: JSON.stringify({ telefono, slug: getSlug() }),
  });

  const companies = Array.isArray(out.companies) ? out.companies : [];
  lastCompaniesLookup = normalized;
  renderEmpresaOptions(companies, out.preferred_empresa_id || null);

  if (!companies.length) {
    selectedEmpresaId = Number(out.preferred_empresa_id || empresaId || 1);
    empresaId = selectedEmpresaId;
  }

  return companies;
}

function stopOrdersAutoRefresh() {
  if (ordersTimer) {
    clearInterval(ordersTimer);
    ordersTimer = null;
  }
}

function startOrdersAutoRefresh() {
  stopOrdersAutoRefresh();
  ordersTimer = setInterval(async () => {
    try {
      await loadOrders();
    } catch {
      // silenciar: si expira sesión, se verá en próximas acciones del usuario
    }
  }, 25000);
}

function showAuthOnly() {
  stopOrdersAutoRefresh();
  $('#hero-shell')?.classList.remove('hidden');
  $('#step-login').classList.remove('hidden');
  $('#step-code').classList.remove('hidden');
  $('#step-profile').classList.add('hidden');
  $('#step-catalog').classList.add('hidden');
  $('#step-cart').classList.add('hidden');
  $('#step-orders').classList.add('hidden');
}

function showApp() {
  $('#hero-shell')?.classList.add('hidden');
  $('#step-login').classList.add('hidden');
  $('#step-code').classList.add('hidden');
  $('#step-profile').classList.remove('hidden');
  $('#step-catalog').classList.remove('hidden');
  $('#step-cart').classList.remove('hidden');
  $('#step-orders').classList.remove('hidden');
  startOrdersAutoRefresh();
}

function loadProfileToForm(profile = {}, session = {}) {
  $('#cliente').value = profile?.cliente || '';
  $('#direccion').value = profile?.direccion || '';
  $('#ciudad').value = profile?.ciudad || '';
  $('#notas-pedido').value = profile?.notas || '';
  const tel = profile?.telefono || session?.telefono || '';
  $('#telefono-perfil').value = tel;
  telefono = tel;
}

function statusColor(estado = '') {
  const e = String(estado || '').toLowerCase();
  if (e.includes('entreg')) return '#0f9d58';
  if (e.includes('ruta')) return '#1a73e8';
  if (e.includes('prepar')) return '#7b61ff';
  if (e.includes('cancel')) return '#d93025';
  if (e.includes('pend')) return '#f9ab00';
  return '#61657a';
}

function statusProgress(estado = '') {
  const e = String(estado || '').toLowerCase();
  if (e.includes('cancel')) return 100;
  if (e.includes('entreg')) return 100;
  if (e.includes('ruta')) return 75;
  if (e.includes('prepar')) return 45;
  if (e.includes('pend')) return 20;
  return 10;
}

function showOrderAlert(text) {
  const el = $('#order-alert');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4500);
}

function maybeBrowserNotify(text) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    new Notification('PediVoy', { body: text });
  } catch {
    // noop
  }
}

function detectOrderStateChanges(orders = []) {
  let changed = null;
  for (const o of orders) {
    const id = Number(o.id || 0);
    const next = String(o.estado || '').trim();
    if (!id || !next) continue;
    const prev = lastOrderState.get(id);
    if (prev && prev !== next) {
      changed = { id, prev, next };
    }
    lastOrderState.set(id, next);
  }

  if (changed) {
    const txt = `Pedido #${changed.id}: ${changed.prev} → ${changed.next}`;
    showOrderAlert(txt);
    maybeBrowserNotify(txt);
  }
}

async function repeatOrder(orderId) {
  try {
    const out = await j(`/api/public/app/orders/${orderId}/items`);
    const items = out.items || [];
    cart.length = 0;
    items.forEach((it, idx) => {
      cart.push({
        id: `repeat-${orderId}-${idx}`,
        nombre: it.producto,
        precio: Number(it.precio_unitario || 0),
        cantidad: Number(it.cantidad || 1),
      });
    });
    renderCart();
    document.querySelector('#step-cart')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showOrderAlert(`Cargamos el pedido #${orderId} en tu carrito.`);
  } catch (e) {
    alert(e.message);
  }
}

function renderOrders(orders = []) {
  const root = $('#orders');
  if (!orders.length) {
    root.className = '';
    root.innerHTML = '<div class="empty-state">Todavía no tenés pedidos cargados.</div>';
    return;
  }

  root.className = 'orders-list';
  root.innerHTML = '';
  orders.forEach((o, index) => {
    const row = document.createElement('div');
    row.className = 'order-card';
    const fecha = o.fecha ? new Date(o.fecha).toLocaleString('es-AR') : '-';

    const detBtnId = `btn-det-${o.id}`;
    const repBtnId = `btn-rep-${o.id}`;
    const detBoxId = `det-${o.id}`;

    const prog = statusProgress(o.estado);
    const color = statusColor(o.estado);
    row.innerHTML = `
      <div class="order-top">
        <div>
          <div class="order-id">Pedido #${o.id}</div>
          <div class="order-meta">${fecha}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
          ${index === 0 ? '<span class="status-badge" style="background:#cffafe;color:#0f766e">Último pedido</span>' : ''}
          <span class="status-badge" style="background:${color}18;color:${color}">${o.estado || '-'}</span>
        </div>
      </div>
      <div style="margin-top:10px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div>
          <div class="muted small">Entrega</div>
          <strong>${o.direccion || 'Dirección pendiente'}</strong>
        </div>
        <div style="text-align:right">
          <div class="muted small">Monto</div>
          <strong>${money(o.monto || 0)}</strong>
        </div>
      </div>
      <div class="progress-track">
        <div class="progress-bar" style="width:${prog}%;background:${color}"></div>
      </div>
      <div class="order-meta">Progreso: ${prog}%</div>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-secondary" id="${detBtnId}">Ver detalle</button>
        <button class="btn btn-primary" id="${repBtnId}">Repetir pedido</button>
      </div>
      <div id="${detBoxId}" class="muted small" style="display:none;margin-top:8px"></div>
    `;

    const btn = row.querySelector(`#${detBtnId}`);
    const repBtn = row.querySelector(`#${repBtnId}`);
    const box = row.querySelector(`#${detBoxId}`);

    btn.addEventListener('click', async () => {
      try {
        const open = box.style.display !== 'none';
        if (open) {
          box.style.display = 'none';
          btn.textContent = 'Ver detalle';
          return;
        }

        const out = await j(`/api/public/app/orders/${o.id}/items`);
        const items = out.items || [];
        box.innerHTML = items.length
          ? items.map((it) => `• ${it.producto} x${it.cantidad} — ${money(Number(it.precio_unitario || 0) * Number(it.cantidad || 0))}`).join('<br>')
          : 'Sin ítems';
        box.style.display = 'block';
        btn.textContent = 'Ocultar detalle';
      } catch (e) {
        alert(e.message);
      }
    });

    repBtn.addEventListener('click', async () => repeatOrder(o.id));

    root.appendChild(row);
  });
}

async function loadOrders() {
  const out = await j('/api/public/app/orders');
  const orders = out.orders || [];
  updateAppStats({ orderCount: orders.length });
  detectOrderStateChanges(orders);
  renderOrders(orders);
}

function renderCart() {
  const root = $('#cart');
  root.innerHTML = '';
  if (!cart.length) {
    root.innerHTML = '<div class="empty-state">Todavía no agregaste productos al carrito.</div>';
  }
  for (const it of cart) {
    const row = document.createElement('div');
    row.className = 'cart-item';
    row.innerHTML = `
      <div class="cart-item-meta">
        <strong>${it.nombre}</strong>
        <div class="muted small">${money(it.precio)} por unidad</div>
        <button class="remove-btn" type="button">Quitar</button>
      </div>
      <div>
        <div class="cart-actions">
          <button class="qty-btn" type="button" data-act="minus">−</button>
          <span class="qty-badge">${it.cantidad}</span>
          <button class="qty-btn" type="button" data-act="plus">+</button>
        </div>
        <div style="text-align:right;margin-top:8px"><strong>${money(it.precio * it.cantidad)}</strong></div>
      </div>
    `;
    row.querySelector('[data-act="minus"]').addEventListener('click', () => changeCartQty(it.id, -1));
    row.querySelector('[data-act="plus"]').addEventListener('click', () => changeCartQty(it.id, 1));
    row.querySelector('.remove-btn').addEventListener('click', () => removeFromCart(it.id));
    root.appendChild(row);
  }
  const total = cart.reduce((a, b) => a + b.precio * b.cantidad, 0);
  updateAppStats({ cartCount: cart.reduce((a, b) => a + b.cantidad, 0) });
  $('#total').textContent = money(total);
}

function addToCart(p) {
  const i = cart.findIndex((x) => String(x.id) === String(p.id));
  if (i >= 0) cart[i].cantidad += 1;
  else cart.push({ id: p.id, nombre: p.nombre, precio: Number(p.precio || 0), cantidad: 1 });
  renderCart();
}

function changeCartQty(id, delta) {
  const item = cart.find((x) => String(x.id) === String(id));
  if (!item) return;
  item.cantidad += delta;
  if (item.cantidad <= 0) {
    const idx = cart.findIndex((x) => String(x.id) === String(id));
    if (idx >= 0) cart.splice(idx, 1);
  }
  renderCart();
}

function removeFromCart(id) {
  const idx = cart.findIndex((x) => String(x.id) === String(id));
  if (idx >= 0) cart.splice(idx, 1);
  renderCart();
}

async function loadAuthProviders() {
  try {
    const out = await j('/api/public/app/auth/providers');
    if (!out.google) $('#btn-google')?.classList.add('hidden');
  } catch {
    // si falla, no rompemos la pantalla
  }
}

async function loadEmpresa() {
  if (selectedEmpresaId) {
    empresaId = Number(selectedEmpresaId);
    return;
  }
  const slug = getSlug();
  const q = slug ? `?slug=${encodeURIComponent(slug)}` : '';
  const cfg = await j(`/public/config${q}`);
  empresaId = Number(cfg.empresa_id || 1);
  selectedEmpresaId = empresaId;
  updateAppStats({ companyName: cfg.nombre_empresa || cfg.nombre || `Empresa #${empresaId}` });
}

async function loadCatalog() {
  const rows = await j(`/public/productos?empresa_id=${empresaId}&scope=catalog`);
  const root = $('#productos');
  root.innerHTML = '';
  if (!rows.length) {
    root.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No hay productos disponibles por ahora.</div>';
    return;
  }
  rows.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'prod';
    const imageUrl = resolveImageUrl(p.imagen_promo || p.imagen || '');
    el.innerHTML = `
      ${imageUrl ? `<div class="prod-media"><img src="${imageUrl}" alt="${p.nombre}" loading="lazy" onerror="this.parentElement.style.display='none'" /></div>` : ''}
      <div class="prod-title">${p.nombre}</div>
      <div class="prod-desc">${p.descripcion || 'Disponible para pedido inmediato.'}</div>
      <div class="prod-foot">
        <span class="price">${money(p.precio)}</span>
        <button class="btn btn-primary" data-id="${p.id}" style="padding:10px 14px;border-radius:14px">Agregar</button>
      </div>
    `;
    el.querySelector('button').addEventListener('click', () => addToCart(p));
    root.appendChild(el);
  });
}

$('#telefono').addEventListener('input', () => {
  const digits = normalizePhoneForInput($('#telefono').value.trim());
  if (digits === lastCompaniesLookup) return;
  selectedEmpresaId = null;
  if (digits.length < 8) {
    lastCompaniesLookup = '';
    renderEmpresaOptions([], null);
  }
});

$('#telefono').addEventListener('blur', async () => {
  const digits = normalizePhoneForInput($('#telefono').value.trim());
  if (digits.length < 8) return;
  $('#telefono').value = digits;
  await lookupCompaniesForPhone().catch(() => {});
});

$('#btn-google').addEventListener('click', async () => {
  try {
    await lookupCompaniesForPhone().catch(() => []);
    await loadEmpresa();
    const slug = getSlug();
    const q = new URLSearchParams({ empresa_id: String(getSelectedEmpresaId()) });
    if (slug) q.set('slug', slug);
    location.href = `/api/public/app/auth/google/start?${q.toString()}`;
  } catch (e) {
    alert(e.message);
  }
});

$('#btn-otp').addEventListener('click', async () => {
  try {
    const companies = await lookupCompaniesForPhone();
    const currentEmpresaId = getSelectedEmpresaId();
    if (companies.length > 1 && !currentEmpresaId) {
      throw new Error('Elegí una empresa para continuar');
    }

    telefono = normalizePhoneForInput($('#telefono').value.trim());
    $('#telefono').value = telefono;
    const body = await j('/api/public/app/auth/request-otp', {
      method: 'POST',
      body: JSON.stringify({ empresa_id: currentEmpresaId, telefono, slug: getSlug() }),
    });
    empresaId = currentEmpresaId;
    selectedEmpresaId = currentEmpresaId;
    $('#step-code').classList.remove('hidden');
    $('#otp-debug').textContent = body.debug_code ? `Demo OTP: ${body.debug_code}` : '';
  } catch (e) {
    alert(e.message);
  }
});

$('#btn-verify').addEventListener('click', async () => {
  try {
    await j('/api/public/app/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ empresa_id: getSelectedEmpresaId(), telefono, code: $('#code').value.trim(), slug: getSlug() }),
    });

    const me = await j('/api/public/app/me');
    showApp();
    loadProfileToForm(me.profile, me.session);
    await loadCatalog();
    await loadOrders();
    await loadOrders();
  } catch (e) {
    alert(e.message);
  }
});

$('#btn-save-profile').addEventListener('click', async () => {
  try {
    const cliente = $('#cliente').value.trim();
    const direccion = $('#direccion').value.trim();
    const ciudad = $('#ciudad').value.trim();
    const tel = $('#telefono-perfil').value.trim();

    const out = await j('/api/public/app/profile', {
      method: 'POST',
      body: JSON.stringify({ cliente, direccion, ciudad, telefono: tel }),
    });

    loadProfileToForm(out.profile || {}, {});
    $('#profile-msg').textContent = 'Perfil guardado ✅';
    setTimeout(() => { $('#profile-msg').textContent = ''; }, 1800);
  } catch (e) {
    alert(e.message);
  }
});

$('#btn-enable-notif').addEventListener('click', async () => {
  try {
    if (!('Notification' in window)) throw new Error('Este navegador no soporta notificaciones');
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      showOrderAlert('Notificaciones activadas ✅');
    } else {
      showOrderAlert('Notificaciones no habilitadas');
    }
  } catch (e) {
    alert(e.message);
  }
});

$('#btn-refresh-orders').addEventListener('click', async () => {
  try {
    await loadOrders();
  } catch (e) {
    alert(e.message);
  }
});

$('#btn-send').addEventListener('click', async () => {
  try {
    if (!cart.length) throw new Error('Carrito vacío');

    const cliente = $('#cliente').value.trim();
    const direccion = $('#direccion').value.trim();
    const ciudad = $('#ciudad').value.trim();
    const notas = $('#notas-pedido').value.trim();
    const tel = $('#telefono-perfil').value.trim() || telefono;

    if (!cliente || !direccion) throw new Error('Completá nombre y dirección');
    if (onlyDigits(tel).length < 8) throw new Error('Completá un teléfono válido');

    const payload = {
      empresa_id: getSelectedEmpresaId(),
      cliente,
      telefono: tel,
      direccion,
      ciudad,
      notas,
      metodo_pago: 'efectivo',
      items: cart.map((i) => ({ producto: i.nombre, cantidad: i.cantidad, precio_unitario: i.precio })),
    };

    const out = await j('/public/pedidos', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    cart.length = 0;
    renderCart();
    await loadOrders();
    alert(`Pedido enviado #${out?.pedido?.id || ''}`);
  } catch (e) {
    alert(e.message);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopOrdersAutoRefresh();
  else if (!$('#step-orders').classList.contains('hidden')) startOrdersAutoRefresh();
});

(async function init() {
  await loadAuthProviders();
  try {
    await loadEmpresa();
    const me = await j('/api/public/app/me');
    if (me?.ok) {
      showApp();
      loadProfileToForm(me.profile, me.session);
      await loadCatalog();
    }
  } catch (e) {
    if (e?.data?.revalidate_required) {
      showAuthOnly();
      $('#otp-debug').textContent = 'Tu sesión necesita revalidación por seguridad.';
    }
    // sin sesión todavía
  }
})();
