const $ = (s) => document.querySelector(s);
const money = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(Number(n || 0));

let empresaId = 1;
let selectedEmpresaId = null;
let telefono = '';
let lastCompaniesLookup = '';
const cart = [];
let catalogProducts = [];
let activeCatalogFilter = 'all';
let paymentMethod = 'efectivo';
let ordersTimer = null;
const lastOrderState = new Map();

function getInitialReferenteCode() {
  const params = new URLSearchParams(location.search);
  return String(
    params.get('codigo_referente')
    || params.get('referente')
    || params.get('ref')
    || ''
  ).trim().toUpperCase();
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

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

function setActiveTab(targetId) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.target === targetId);
  });
}

function isAppVisible() {
  return !$('#app-tabs')?.classList.contains('hidden');
}

function showAppView(targetId, { scroll = true } = {}) {
  const target = document.getElementById(targetId);
  if (!target || !target.classList.contains('app-view')) return;

  document.querySelectorAll('.app-view').forEach((view) => {
    view.classList.toggle('hidden', view.id !== targetId);
  });
  setActiveTab(targetId);

  if (targetId === 'step-orders') startOrdersAutoRefresh();
  else stopOrdersAutoRefresh();

  if (scroll) {
    $('#app-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function goToSection(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  if (targetId === 'step-cart' && isAppVisible()) {
    showAppView('step-catalog', { scroll: false });
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (isAppVisible() && target.classList.contains('app-view')) {
    showAppView(targetId);
    return;
  }
  if (target.classList.contains('hidden')) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function productCategory(p) {
  return String(p?.categoria || p?.rubro || p?.tipo || 'Productos').trim() || 'Productos';
}

function cartCount() {
  return cart.reduce((a, b) => a + Number(b.cantidad || 0), 0);
}

function updateQuickCustomerPanel() {
  const cliente = $('#cliente')?.value?.trim() || 'Sin datos';
  const direccion = $('#direccion')?.value?.trim() || 'Sin dirección';
  const ciudad = $('#ciudad')?.value?.trim();
  const quickCustomer = $('#quick-customer');
  const quickAddress = $('#quick-address');
  if (quickCustomer) quickCustomer.textContent = cliente;
  if (quickAddress) quickAddress.textContent = ciudad && direccion !== 'Sin dirección' ? `${direccion}, ${ciudad}` : direccion;
}

function syncCheckoutFromProfile({ force = false } = {}) {
  const fields = [
    ['#checkout-cliente', '#cliente'],
    ['#checkout-direccion', '#direccion'],
    ['#checkout-ciudad', '#ciudad'],
    ['#checkout-telefono', '#telefono-perfil'],
  ];
  fields.forEach(([checkoutSel, profileSel]) => {
    const checkout = $(checkoutSel);
    const profile = $(profileSel);
    if (!checkout || !profile) return;
    if (force || !checkout.value.trim()) checkout.value = profile.value || '';
  });
  updateQuickCustomerPanel();
}

function updateCheckoutState() {
  const btn = $('#btn-send');
  const msg = $('#checkout-msg');
  if (!btn) return;
  const cliente = $('#checkout-cliente')?.value?.trim() || '';
  const direccion = $('#checkout-direccion')?.value?.trim() || '';
  const tel = $('#checkout-telefono')?.value?.trim() || telefono || '';
  const ready = cart.length > 0 && cliente && direccion && onlyDigits(tel).length >= 8;
  btn.disabled = !ready;
  btn.style.opacity = ready ? '1' : '.55';
  btn.style.cursor = ready ? 'pointer' : 'not-allowed';
  if (msg) {
    if (!cart.length) msg.textContent = 'Agregá productos para enviar el pedido.';
    else if (!cliente || !direccion) msg.textContent = 'Confirmá nombre y dirección de entrega.';
    else if (onlyDigits(tel).length < 8) msg.textContent = 'Confirmá un teléfono válido.';
    else msg.textContent = 'Pedido listo para enviar.';
  }
}

function normalizeReferralCode() {
  const input = $('#codigo-referente');
  const value = input?.value?.trim().toUpperCase() || '';
  if (input) input.value = value;
  return value;
}

function setReferralPanel(open) {
  const panel = $('#code-panel');
  const btn = $('#btn-toggle-code');
  if (!panel || !btn) return;
  panel.classList.toggle('hidden', !open);
  btn.textContent = open ? 'Cerrar' : ($('#codigo-referente')?.value?.trim() ? 'Editar' : 'Agregar');
  if (open) $('#codigo-referente')?.focus();
}

function updateReferralSummary(message = '') {
  const code = normalizeReferralCode();
  const text = $('#code-summary-text');
  const status = $('#code-status');
  const btn = $('#btn-toggle-code');
  if (text) text.textContent = code ? `Código cargado: ${code}` : 'Sin código aplicado';
  if (status) status.textContent = message || (code ? 'Código guardado para enviar con el pedido.' : '');
  if (btn && $('#code-panel')?.classList.contains('hidden')) btn.textContent = code ? 'Editar' : 'Agregar';
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
  $('#app-tabs')?.classList.add('hidden');
  $('#step-login').classList.remove('hidden');
  $('#step-code').classList.add('hidden');
  $('#step-profile').classList.add('hidden');
  $('#step-catalog').classList.add('hidden');
  $('#step-orders').classList.add('hidden');
}

function showApp() {
  $('#hero-shell')?.classList.add('hidden');
  $('#app-tabs')?.classList.remove('hidden');
  $('#step-login').classList.add('hidden');
  $('#step-code').classList.add('hidden');
  showAppView('step-catalog', { scroll: false });
  renderCart();
}

function loadProfileToForm(profile = {}, session = {}) {
  $('#cliente').value = profile?.cliente || '';
  $('#direccion').value = profile?.direccion || '';
  $('#ciudad').value = profile?.ciudad || '';
  $('#notas-pedido').value = profile?.notas || '';
  const tel = profile?.telefono || session?.telefono || '';
  $('#telefono-perfil').value = tel;
  telefono = tel;
  syncCheckoutFromProfile({ force: true });
  updateCheckoutState();
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
        producto_id: Number(it.producto_id || 0) || null,
        precio: Number(it.precio_unitario || 0),
        cantidad: Number(it.cantidad || 1),
      });
    });
    renderCart();
    goToSection('step-cart');
    showOrderAlert(`Cargamos el pedido #${orderId} en tu carrito.`);
  } catch (e) {
    alert(e.message);
  }
}

function renderOrders(orders = []) {
  const root = $('#orders');
  const last = orders[0] || null;
  const summaryLastOrder = $('#summary-last-order');
  const summaryLastStatus = $('#summary-last-status');
  if (summaryLastOrder) summaryLastOrder.textContent = last ? `#${last.id}` : '-';
  if (summaryLastStatus) summaryLastStatus.textContent = last?.estado || '-';

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
    const trackUrl = `/pedidos/pedido.html?id=${encodeURIComponent(o.id)}`;

    const prog = statusProgress(o.estado);
    const color = statusColor(o.estado);
    row.innerHTML = `
      <div class="order-top">
        <div>
          <div class="order-id">Pedido #${esc(o.id)}</div>
          <div class="order-meta">${fecha}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
          ${index === 0 ? '<span class="status-badge" style="background:#cffafe;color:#0f766e">Último pedido</span>' : ''}
          <span class="status-badge" style="background:${color}18;color:${color}">${esc(o.estado || '-')}</span>
        </div>
      </div>
      <div style="margin-top:10px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div>
          <div class="muted small">Entrega</div>
          <strong>${esc(o.direccion || 'Dirección pendiente')}</strong>
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
        <a class="btn btn-ghost" href="${trackUrl}" style="text-align:center;text-decoration:none">Seguimiento</a>
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
          ? items.map((it) => `• ${esc(it.producto)} x${esc(it.cantidad)} — ${money(Number(it.precio_unitario || 0) * Number(it.cantidad || 0))}`).join('<br>')
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
        <strong>${esc(it.nombre)}</strong>
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
  const count = cartCount();
  updateAppStats({ cartCount: count });
  const cartBtn = $('#btn-go-cart');
  if (cartBtn) cartBtn.textContent = count ? `Ver resumen (${count})` : 'Ver resumen';
  $('#total').textContent = money(total);
  updateCheckoutState();
}

function addToCart(p) {
  const i = cart.findIndex((x) => String(x.id) === String(p.id));
  if (i >= 0) cart[i].cantidad += 1;
  else cart.push({ id: p.id, producto_id: Number(p.id || 0) || null, nombre: p.nombre, precio: Number(p.precio || 0), cantidad: 1 });
  renderCart();
  const quick = $('#quick-last-action');
  if (quick) quick.textContent = `${p.nombre} agregado`;
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
  catalogProducts = Array.isArray(rows) ? rows : [];
  renderCatalogFilters();
  renderCatalog();
}

function renderCatalogFilters() {
  const root = $('#catalog-filters');
  if (!root) return;
  const cats = Array.from(new Set(catalogProducts.map(productCategory))).sort((a, b) => a.localeCompare(b, 'es'));
  const current = cats.includes(activeCatalogFilter) ? activeCatalogFilter : 'all';
  activeCatalogFilter = current;
  root.innerHTML = '';
  [{ key: 'all', label: 'Todo' }, ...cats.map((c) => ({ key: c, label: c }))].forEach((f) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `filter-chip${activeCatalogFilter === f.key ? ' active' : ''}`;
    btn.textContent = f.label;
    btn.addEventListener('click', () => {
      activeCatalogFilter = f.key;
      renderCatalogFilters();
      renderCatalog();
    });
    root.appendChild(btn);
  });
}

function renderCatalog() {
  const rows = catalogProducts;
  const root = $('#productos');
  const q = String($('#catalog-search')?.value || '').trim().toLowerCase();
  const filtered = rows.filter((p) => {
    const matchesCategory = activeCatalogFilter === 'all' || productCategory(p) === activeCatalogFilter;
    const haystack = `${p.nombre || ''} ${p.descripcion || ''} ${productCategory(p)}`.toLowerCase();
    const matchesSearch = !q || haystack.includes(q);
    return matchesCategory && matchesSearch;
  });
  const count = $('#catalog-count');
  if (count) count.textContent = `${filtered.length} producto${filtered.length === 1 ? '' : 's'} disponible${filtered.length === 1 ? '' : 's'}`;

  root.innerHTML = '';
  if (!rows.length) {
    root.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No hay productos disponibles por ahora.</div>';
    return;
  }
  if (!filtered.length) {
    root.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No encontramos productos con ese filtro.</div>';
    return;
  }
  filtered.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'prod';
    const imageUrl = resolveImageUrl(p.imagen_promo || p.imagen || '');
    el.innerHTML = `
      ${imageUrl ? `<div class="prod-media"><img src="${esc(imageUrl)}" alt="${esc(p.nombre)}" loading="lazy" onerror="this.parentElement.style.display='none'" /></div>` : ''}
      <div class="prod-title">${esc(p.nombre)}</div>
      <div class="prod-desc">${esc(p.descripcion || 'Disponible para pedido inmediato.')}</div>
      <div class="prod-foot">
        <span class="price">${money(p.precio)}</span>
        <button class="btn btn-primary" data-id="${p.id}" style="padding:10px 14px;border-radius:14px">Agregar</button>
      </div>
    `;
    el.querySelector('button').addEventListener('click', () => addToCart(p));
    root.appendChild(el);
  });
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => goToSection(btn.dataset.target));
});

$('#btn-profile-catalog')?.addEventListener('click', () => goToSection('step-catalog'));
$('#btn-go-orders')?.addEventListener('click', () => goToSection('step-orders'));
$('#btn-go-cart')?.addEventListener('click', () => goToSection('step-cart'));
$('#catalog-search')?.addEventListener('input', renderCatalog);
$('#btn-clear-search')?.addEventListener('click', () => {
  $('#catalog-search').value = '';
  renderCatalog();
});

document.querySelectorAll('#payment-methods .method-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    paymentMethod = btn.dataset.method || 'efectivo';
    document.querySelectorAll('#payment-methods .method-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

['#cliente', '#direccion', '#ciudad', '#telefono-perfil'].forEach((sel) => {
  $(sel)?.addEventListener('input', () => {
    syncCheckoutFromProfile();
    updateCheckoutState();
  });
});

['#checkout-cliente', '#checkout-direccion', '#checkout-ciudad', '#checkout-telefono'].forEach((sel) => {
  $(sel)?.addEventListener('input', updateCheckoutState);
});

$('#btn-toggle-code')?.addEventListener('click', () => {
  const panel = $('#code-panel');
  setReferralPanel(panel?.classList.contains('hidden'));
});

$('#btn-apply-code')?.addEventListener('click', () => {
  const code = normalizeReferralCode();
  updateReferralSummary(code ? 'Código agregado al pedido.' : 'No cargaste ningún código.');
  if (code) setReferralPanel(false);
});

$('#codigo-referente')?.addEventListener('input', updateReferralSummary);

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

    const cliente = $('#checkout-cliente').value.trim() || $('#cliente').value.trim();
    const direccion = $('#checkout-direccion').value.trim() || $('#direccion').value.trim();
    const ciudad = $('#checkout-ciudad').value.trim() || $('#ciudad').value.trim();
    const notas = $('#notas-pedido').value.trim();
    const tel = $('#checkout-telefono').value.trim() || $('#telefono-perfil').value.trim() || telefono;
    const codigoReferente = normalizeReferralCode();

    if (!cliente || !direccion) throw new Error('Completá nombre y dirección');
    if (onlyDigits(tel).length < 8) throw new Error('Completá un teléfono válido');

    const payload = {
      empresa_id: getSelectedEmpresaId(),
      cliente,
      telefono: tel,
      direccion,
      ciudad,
      notas,
      metodo_pago: paymentMethod,
      codigo_referente: codigoReferente || undefined,
      items: cart.map((i) => ({
        producto: i.nombre,
        producto_id: Number(i.producto_id || i.id || 0) || undefined,
        cantidad: i.cantidad,
        precio_unitario: i.precio,
      })),
    };

    const out = await j('/public/pedidos', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    cart.length = 0;
    renderCart();
    if (out?.referente?.codigo) {
      $('#codigo-referente').value = out.referente.codigo;
      updateReferralSummary('Código aplicado al pedido enviado.');
    } else {
      updateReferralSummary();
    }
    await loadOrders();
    $('#quick-last-action').textContent = `Pedido #${out?.pedido?.id || ''} enviado`;
    showOrderAlert(`Pedido enviado #${out?.pedido?.id || ''}`);
    goToSection('step-orders');
  } catch (e) {
    alert(e.message);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopOrdersAutoRefresh();
  else if (isAppVisible() && !$('#step-orders').classList.contains('hidden')) startOrdersAutoRefresh();
});

(async function init() {
  await loadAuthProviders();
  const initialReferenteCode = getInitialReferenteCode();
  if (initialReferenteCode && $('#codigo-referente')) {
    $('#codigo-referente').value = initialReferenteCode;
    updateReferralSummary('Código recibido desde el enlace.');
  } else {
    updateReferralSummary();
  }
  try {
    await loadEmpresa();
    const me = await j('/api/public/app/me');
    if (me?.ok) {
      showApp();
      loadProfileToForm(me.profile, me.session);
      await loadCatalog();
      await loadOrders();
    }
  } catch (e) {
    if (e?.data?.revalidate_required) {
      showAuthOnly();
      $('#otp-debug').textContent = 'Tu sesión necesita revalidación por seguridad.';
    }
    // sin sesión todavía
  }
})();
