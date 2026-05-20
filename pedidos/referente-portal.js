const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = document.body.dataset.page || 'dashboard';
const state = { perfil: null, notificaciones: [] };

function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value;
}

function setValue(selector, value) {
  const el = $(selector);
  if (el) el.value = value;
}

function setHtml(selector, value) {
  const el = $(selector);
  if (el) el.innerHTML = value;
}

function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401 || res.status === 403) {
    location.href = `login.html?next=${encodeURIComponent(location.pathname)}`;
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Error de API');
  return data;
}

function emptyRow(cols, text) {
  return `<tr><td colspan="${cols}" style="text-align:center;color:var(--muted);padding:24px">${esc(text)}</td></tr>`;
}

function formatDate(value) {
  return value ? dateFmt.format(new Date(value)) : '-';
}

function renderPerfil(p) {
  state.perfil = p || {};
  if (page === 'dashboard') setText('#nombreTitulo', state.perfil.nombre || 'Panel del referente');
  setText('#codigoRef', state.perfil.codigo || 'SIN CODIGO');
  setText('#empresaPill', state.perfil.empresa_nombre || 'Empresa');
  setValue('#nombre', state.perfil.nombre || '');
  setValue('#telefono', state.perfil.telefono || '');
  setValue('#email', state.perfil.email || '');
  setValue('#direccion', state.perfil.direccion || '');
  setValue('#notas', state.perfil.notas || '');
  renderInviteLink(state.perfil);
}

function buildInviteLink(p) {
  const url = new URL('/pedidos/app/', location.origin);
  const slug = String(p?.empresa_slug || '').trim();
  const codigo = String(p?.codigo || '').trim().toUpperCase();
  if (slug) url.searchParams.set('slug', slug);
  if (codigo) url.searchParams.set('referente', codigo);
  return url.toString();
}

function renderInviteLink(p) {
  const input = $('#inviteLink');
  const wa = $('#btnWhatsAppInvite');
  if (!input && !wa) return;
  const link = buildInviteLink(p);
  if (input) input.value = link;
  if (wa) {
    const text = `Hola, te comparto mi link de PediVoy para hacer tu pedido: ${link}`;
    wa.href = `https://wa.me/?text=${encodeURIComponent(text)}`;
  }
}

function renderResumen(r) {
  setText('#mClientes', Number(r?.clientes_activos || 0));
  setText('#mProductos', Number(r?.productos_activos || 0));
  setText('#mPedidos', Number(r?.pedidos_total || 0));
  setText('#mPedidos30', Number(r?.pedidos_30d || 0));
  setText('#mVentas', money.format(Number(r?.ventas_entregadas || 0)));
  setText('#mPendientes', money.format(Number(r?.comisiones_pendientes || 0)));
  setText('#mTotal', money.format(Number(r?.comisiones_total || 0)));
  setText('#mLiquidadas', money.format(Number(r?.comisiones_liquidadas || 0)));
}

function renderPedidos(rows, limit = null) {
  const data = Array.isArray(rows) ? (limit ? rows.slice(0, limit) : rows) : [];
  setHtml('#tbPedidos', data.length ? data.map((p) => {
    const fecha = p.fecha_entrega || p.fecha;
    const estado = String(p.estado || 'pendiente').toLowerCase();
    const badgeClass = estado === 'entregado' ? 'ok' : 'warn';
    return `
      <tr>
        <td>${esc(formatDate(fecha))}</td>
        <td><strong>${esc(p.cliente || '-')}</strong><br><span class="muted">${esc(p.direccion || '')}</span></td>
        <td>#${Number(p.id || 0)}</td>
        <td><span class="badge ${badgeClass}">${esc(p.estado || 'pendiente')}</span></td>
        <td>${esc(p.metodo_pago || '-')}</td>
        <td>${money.format(Number(p.monto || 0))}</td>
        <td>${money.format(Number(p.comision_total || 0))}</td>
      </tr>
    `;
  }).join('') : emptyRow(7, 'Sin pedidos vinculados todavía.'));
}

function renderComisiones(rows, limit = null) {
  const data = Array.isArray(rows) ? (limit ? rows.slice(0, limit) : rows) : [];
  setHtml('#tbComisiones', data.length ? data.map((c) => {
    const estado = String(c.estado || 'validada').toLowerCase();
    return `
      <tr>
        <td>${esc(formatDate(c.validada_at))}</td>
        <td>${esc(c.cliente || '-')}</td>
        <td>${esc(c.producto_nombre || '-')}</td>
        <td>#${Number(c.pedido_id || 0)}</td>
        <td>${money.format(Number(c.base_monto || 0))}</td>
        <td>${Number(c.porcentaje || 0).toFixed(2)}%</td>
        <td><strong>${money.format(Number(c.monto_comision || 0))}</strong></td>
        <td><span class="badge ${estado === 'liquidada' ? 'ok' : 'warn'}">${esc(c.estado || 'validada')}</span></td>
      </tr>
    `;
  }).join('') : emptyRow(8, 'Sin comisiones todavía.'));
}

function renderNotificaciones(rows, limit = 8) {
  state.notificaciones = Array.isArray(rows) ? rows : [];
  const box = $('#notificacionesList');
  if (!box) return;
  if (!state.notificaciones.length) {
    box.innerHTML = '<div class="muted">Sin notificaciones por ahora.</div>';
    return;
  }
  box.innerHTML = state.notificaciones.slice(0, limit).map((n) => {
    const unread = !n.leida_at;
    return `
      <article class="notice ${unread ? 'unread' : ''}">
        <div>
          <strong>${esc(n.titulo || 'Notificación')}</strong>
          <p>${esc(n.mensaje || '')}</p>
          <div class="muted">${esc(formatDate(n.created_at))}</div>
        </div>
        ${unread ? `<button class="btn" type="button" data-read-notice="${Number(n.id)}">Leída</button>` : '<span class="badge ok">Leída</span>'}
      </article>
    `;
  }).join('');
  $$('[data-read-notice]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/referente/notificaciones/${Number(btn.dataset.readNotice)}/leida`, { method: 'POST' });
        await loadNotificaciones();
      } catch (err) {
        toast(err.message || 'No se pudo marcar la notificación');
      }
    });
  });
}

function renderReglas(reglas) {
  const pct = Number(reglas?.porcentaje_comision || 0);
  const desde = reglas?.vigente_desde ? dateFmt.format(new Date(reglas.vigente_desde)) : 'sin inicio';
  const hasta = reglas?.vigente_hasta ? dateFmt.format(new Date(reglas.vigente_hasta)) : 'sin cierre';
  const condiciones = Array.isArray(reglas?.condiciones) ? reglas.condiciones : [];
  setText('#rPorcentaje', `${pct.toFixed(2)}%`);
  setText('#rVigencia', `${desde} / ${hasta}`);
  setText('#rPago', reglas?.forma_pago || 'Administración');
  setHtml('#reglasList', condiciones.length
    ? condiciones.map((item) => `<li>${esc(item)}</li>`).join('')
    : '<li>Sin reglas comerciales cargadas.</li>');
  setText('#rLiquidacion', reglas?.liquidacion || '');
  setText('#rContacto', reglas?.contacto || '');
}

function renderClientes(rows) {
  const data = Array.isArray(rows) ? rows : [];
  setHtml('#tbClientes', data.length ? data.map((c) => `
    <tr>
      <td><strong>${esc(c.cliente || '-')}</strong></td>
      <td>${esc(c.telefono || '-')}</td>
      <td>${esc(c.direccion || '-')}</td>
      <td>${esc(formatDate(c.asociado_at))}</td>
    </tr>
  `).join('') : emptyRow(4, 'Sin clientes vinculados.'));
}

function renderClientesPropuestos(rows) {
  const data = Array.isArray(rows) ? rows : [];
  setHtml('#tbClientesPropuestos', data.length ? data.map((c) => {
    const estado = String(c.estado || 'pendiente').toLowerCase();
    const badgeClass = estado === 'aprobado' ? 'ok' : (estado === 'rechazado' ? 'danger' : 'warn');
    return `
      <tr>
        <td><strong>${esc(c.cliente || '-')}</strong>${c.rechazo_motivo ? `<br><span class="muted">${esc(c.rechazo_motivo)}</span>` : ''}</td>
        <td>${esc(c.telefono || '-')}</td>
        <td>${esc(c.direccion || '-')}</td>
        <td><span class="badge ${badgeClass}">${esc(c.estado || 'pendiente')}</span></td>
        <td>${esc(formatDate(c.created_at))}</td>
      </tr>
    `;
  }).join('') : emptyRow(5, 'Sin clientes propuestos.'));
}

function renderProductos(rows) {
  const data = Array.isArray(rows) ? rows : [];
  setHtml('#tbProductos', data.length ? data.map((p) => `
    <tr>
      <td><strong>${esc(p.producto_nombre || '-')}</strong></td>
      <td>${money.format(Number(p.producto_precio || 0))}</td>
      <td>${p.porcentaje_comision == null ? 'General' : `${Number(p.porcentaje_comision || 0).toFixed(2)}%`}</td>
      <td>${p.vigente_desde ? esc(dateFmt.format(new Date(p.vigente_desde))) : 'sin inicio'} / ${p.vigente_hasta ? esc(dateFmt.format(new Date(p.vigente_hasta))) : 'sin cierre'}</td>
    </tr>
  `).join('') : emptyRow(4, 'Sin productos asignados.'));
}

async function loadNotificaciones() {
  const rows = await api('/api/referente/notificaciones');
  renderNotificaciones(rows, page === 'dashboard' ? 5 : 20);
}

async function loadDashboard() {
  const [resumen, pedidos, comisiones, notificaciones, reglas, productos] = await Promise.all([
    api('/api/referente/resumen'),
    api('/api/referente/pedidos'),
    api('/api/referente/comisiones'),
    api('/api/referente/notificaciones'),
    api('/api/referente/reglas'),
    api('/api/referente/productos'),
  ]);
  renderResumen(resumen);
  renderPedidos(pedidos, 6);
  renderComisiones(comisiones, 6);
  renderNotificaciones(notificaciones, 5);
  renderReglas(reglas || {});
  renderProductos(productos);
}

async function loadClientes() {
  const [clientes, clientesPropuestos] = await Promise.all([
    api('/api/referente/clientes'),
    api('/api/referente/clientes-propuestos'),
  ]);
  renderClientes(clientes);
  renderClientesPropuestos(clientesPropuestos);
}

async function loadPedidos() {
  const [resumen, pedidos] = await Promise.all([
    api('/api/referente/resumen'),
    api('/api/referente/pedidos'),
  ]);
  renderResumen(resumen);
  renderPedidos(pedidos);
}

async function loadComisiones() {
  const [resumen, comisiones, reglas] = await Promise.all([
    api('/api/referente/resumen'),
    api('/api/referente/comisiones'),
    api('/api/referente/reglas'),
  ]);
  renderResumen(resumen);
  renderComisiones(comisiones);
  renderReglas(reglas || {});
}

async function loadPerfil() {
  await loadNotificaciones();
}

function bindPerfilForm() {
  $('#perfilForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const saved = await api('/api/referente/perfil', {
        method: 'PUT',
        body: JSON.stringify({
          nombre: $('#nombre').value.trim(),
          telefono: $('#telefono').value.trim() || null,
          email: $('#email').value.trim() || null,
          direccion: $('#direccion').value.trim() || null,
          notas: $('#notas').value.trim() || null,
        }),
      });
      renderPerfil({ ...state.perfil, ...saved });
      toast('Información actualizada');
    } catch (err) {
      toast(err.message || 'No se pudo guardar');
    }
  });
}

function bindClientePropuestoForm() {
  $('#clientePropuestoForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btnClientePropuesto');
    const prevText = btn?.textContent || '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Enviando...';
    }
    try {
      await api('/api/referente/clientes-propuestos', {
        method: 'POST',
        body: JSON.stringify({
          cliente: $('#propCliente').value.trim(),
          telefono: $('#propTelefono').value.trim() || null,
          direccion: $('#propDireccion').value.trim() || null,
          ciudad: $('#propCiudad').value.trim() || null,
          notas: $('#propNotas').value.trim() || null,
        }),
      });
      e.target.reset();
      toast('Cliente enviado a validación');
      const rows = await api('/api/referente/clientes-propuestos');
      renderClientesPropuestos(rows);
    } catch (err) {
      toast(err.message || 'No se pudo enviar el cliente');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prevText;
      }
    }
  });
}

function bindPasswordForm() {
  $('#passwordForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = $('#currentPassword');
    const newPassword = $('#newPassword');
    const confirmPassword = $('#confirmPassword');
    const btn = $('#btnPassword');

    [currentPassword, newPassword, confirmPassword].forEach((input) => input?.setAttribute('aria-invalid', 'false'));
    if (newPassword.value.length < 8) {
      newPassword.setAttribute('aria-invalid', 'true');
      toast('La nueva clave debe tener al menos 8 caracteres');
      return;
    }
    if (newPassword.value !== confirmPassword.value) {
      confirmPassword.setAttribute('aria-invalid', 'true');
      toast('La confirmación no coincide');
      return;
    }
    if (currentPassword.value === newPassword.value) {
      newPassword.setAttribute('aria-invalid', 'true');
      toast('La nueva clave debe ser diferente');
      return;
    }

    const prevText = btn?.textContent || '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Actualizando...';
    }
    try {
      await api('/api/referente/password', {
        method: 'PUT',
        body: JSON.stringify({
          current_password: currentPassword.value,
          new_password: newPassword.value,
          confirm_password: confirmPassword.value,
        }),
      });
      e.target.reset();
      toast('Clave actualizada');
    } catch (err) {
      currentPassword.setAttribute('aria-invalid', 'true');
      toast(err.message || 'No se pudo actualizar la clave');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prevText;
      }
    }
  });
}

function bindActions() {
  $('#btnCopyInvite')?.addEventListener('click', async () => {
    const link = $('#inviteLink')?.value || '';
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copiado');
    } catch {
      $('#inviteLink')?.select();
      document.execCommand('copy');
      toast('Link copiado');
    }
  });

  $('#btnReadAll')?.addEventListener('click', async () => {
    try {
      const result = await api('/api/referente/notificaciones/marcar-leidas', { method: 'POST' });
      toast(`Notificaciones marcadas: ${result?.actualizadas || 0}`);
      await loadNotificaciones();
    } catch (err) {
      toast(err.message || 'No se pudieron marcar');
    }
  });

  $('#logout')?.addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST', credentials: 'include' }); } catch {}
    location.href = 'login.html';
  });
}

async function init() {
  const perfil = await api('/api/referente/perfil');
  renderPerfil(perfil);
  bindActions();
  bindPerfilForm();
  bindClientePropuestoForm();
  bindPasswordForm();

  if (page === 'clientes') await loadClientes();
  else if (page === 'pedidos') await loadPedidos();
  else if (page === 'comisiones') await loadComisiones();
  else if (page === 'perfil') await loadPerfil();
  else await loadDashboard();
}

init().catch((e) => {
  console.error(e);
  toast(e.message || 'No se pudo cargar el panel');
});
