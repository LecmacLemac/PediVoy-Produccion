const $ = (s) => document.querySelector(s);
const money = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(Number(n || 0));

let empresaId = 1;
let telefono = '';
const cart = [];

async function j(url, options = {}) {
  const r = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
}

function getSlug() {
  return new URLSearchParams(location.search).get('slug') || '';
}

function renderCart() {
  const root = $('#cart');
  root.innerHTML = '';
  for (const it of cart) {
    const row = document.createElement('div');
    row.textContent = `${it.nombre} x${it.cantidad} — ${money(it.precio * it.cantidad)}`;
    root.appendChild(row);
  }
  const total = cart.reduce((a, b) => a + b.precio * b.cantidad, 0);
  $('#total').textContent = money(total);
}

function addToCart(p) {
  const i = cart.findIndex((x) => String(x.id) === String(p.id));
  if (i >= 0) cart[i].cantidad += 1;
  else cart.push({ id: p.id, nombre: p.nombre, precio: Number(p.precio || 0), cantidad: 1 });
  renderCart();
}

async function loadEmpresa() {
  const slug = getSlug();
  const q = slug ? `?slug=${encodeURIComponent(slug)}` : '';
  const cfg = await j(`/public/config${q}`);
  empresaId = Number(cfg.empresa_id || 1);
}

async function loadCatalog() {
  const rows = await j(`/public/productos?empresa_id=${empresaId}&scope=catalog`);
  const root = $('#productos');
  root.innerHTML = '';
  rows.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'prod';
    el.innerHTML = `
      <strong>${p.nombre}</strong>
      <div class="muted">${money(p.precio)}</div>
      <button data-id="${p.id}">Agregar</button>
    `;
    el.querySelector('button').addEventListener('click', () => addToCart(p));
    root.appendChild(el);
  });
}

$('#btn-google').addEventListener('click', async () => {
  try {
    await loadEmpresa();
    const slug = getSlug();
    const q = new URLSearchParams({ empresa_id: String(empresaId) });
    if (slug) q.set('slug', slug);
    location.href = `/api/public/app/auth/google/start?${q.toString()}`;
  } catch (e) {
    alert(e.message);
  }
});

$('#btn-otp').addEventListener('click', async () => {
  try {
    telefono = $('#telefono').value.trim();
    const body = await j('/api/public/app/auth/request-otp', {
      method: 'POST',
      body: JSON.stringify({ empresa_id: empresaId, telefono, slug: getSlug() }),
    });
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
      body: JSON.stringify({ empresa_id: empresaId, telefono, code: $('#code').value.trim(), slug: getSlug() }),
    });

    const me = await j('/api/public/app/me');
    if (me.profile) {
      $('#cliente').value = me.profile.cliente || '';
      $('#direccion').value = me.profile.direccion || '';
    }

    $('#step-profile').classList.remove('hidden');
    $('#step-catalog').classList.remove('hidden');
    $('#step-cart').classList.remove('hidden');
    await loadCatalog();
  } catch (e) {
    alert(e.message);
  }
});

$('#btn-send').addEventListener('click', async () => {
  try {
    if (!cart.length) throw new Error('Carrito vacío');

    const cliente = $('#cliente').value.trim();
    const direccion = $('#direccion').value.trim();
    if (!cliente || !direccion) throw new Error('Completá nombre y dirección');

    const payload = {
      empresa_id: empresaId,
      cliente,
      telefono,
      direccion,
      metodo_pago: 'efectivo',
      items: cart.map((i) => ({ producto: i.nombre, cantidad: i.cantidad, precio_unitario: i.precio })),
    };

    const out = await j('/public/pedidos', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    cart.length = 0;
    renderCart();
    alert(`Pedido enviado #${out?.pedido?.id || ''}`);
  } catch (e) {
    alert(e.message);
  }
});

(async function init() {
  try {
    await loadEmpresa();
    const me = await j('/api/public/app/me');
    telefono = me?.session?.telefono || '';
    if (me?.ok) {
      $('#step-code').classList.remove('hidden');
      $('#step-profile').classList.remove('hidden');
      $('#step-catalog').classList.remove('hidden');
      $('#step-cart').classList.remove('hidden');
      if (me.profile) {
        $('#cliente').value = me.profile.cliente || '';
        $('#direccion').value = me.profile.direccion || '';
      }
      await loadCatalog();
    }
  } catch {
    // sin sesión todavía
  }
})();
