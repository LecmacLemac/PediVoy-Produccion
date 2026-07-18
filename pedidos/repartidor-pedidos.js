function toggleFilters(){ const b = $('#filterBox'); b.style.display = b.style.display==='none'?'block':'none'; }
window.toggleFilters = toggleFilters;

function initRepartidorPedidosUI() {
  ['fEstado','fZona','fHoy','fSearch'].forEach(id => $('#'+id).addEventListener('change', () => {
    saveFiltrosUI();
    renderCards();
  }));
  $('#fSearch').addEventListener('input', debounce(() => {
    saveFiltrosUI();
    renderCards();
  }, 200));
  const slaInp = document.getElementById('fSlaEta');
  if (slaInp) {
    slaInp.addEventListener('change', () => {
      saveRouteSlaThreshold(slaInp.value);
      renderRoutePlanCard();
    });
  }
  $('#btnRef').onclick = loadPedidos;
  // EVENTO PARA OPTIMIZAR RUTA
  $('#btnOpt').onclick = optimizarRuta;

  const btnRouteAdvance = document.getElementById('btnRouteAdvance');
  if (btnRouteAdvance) btnRouteAdvance.onclick = advanceRoutePlan;
  const btnRouteReset = document.getElementById('btnRouteReset');
  if (btnRouteReset) btnRouteReset.onclick = () => resetRoutePlan(true);

}

setInterval(updatePedidosSyncInfo, 15_000);

async function loadZonas(){
  try {
    const zs = await api('/api/zonas/choferes');
    zonas = zs || [];
    const fZonaEl = $('#fZona');
    fZonaEl.innerHTML = '<option value="">Todas</option>' + zonas.map(z=>`<option value="${Number(z.id)}">${esc(z.nombre)}</option>`).join('');

    // Reaplicar zona persistida cuando ya existen las opciones
    const pendingZona = fZonaEl.dataset.pendingValue;
    if (typeof pendingZona === 'string') {
      fZonaEl.value = pendingZona;
      delete fZonaEl.dataset.pendingValue;
    }
  } catch(e) {
    zonas = [];
    notifyError('Error cargando zonas', e);
  }
}

async function loadMisZonas(){
  try {
    const zs = await api('/api/repartidor/mis-zonas');
    misZonas = Array.isArray(zs) ? zs : [];
  } catch(e) {
    console.warn('No se pudieron cargar mis zonas', e);
    misZonas = [];
    notifyError('No se pudieron cargar tus zonas', e);
  }
}

async function loadPedidos(){
  try {
    const list = await api('/api/repartidor/pedidos', { cache: 'no-store' });
    pedidos = Array.isArray(list) ? list : [];
    const trs = await api('/api/transferencias?estado=verificado', { cache: 'no-store' });
    verificadas = new Set((Array.isArray(trs)?trs:trs.rows||[]).map(t=>Number(t.pedido_id)));
    pedidosLastSyncAt = Date.now();
    updatePedidosSyncInfo();
    syncRoutePlanWithPedidos();
    renderCards();
    renderRoutePlanCard();
    return list;
  } catch(e){
    if (isAuthRedirectError(e)) return [];
    toast('Error cargando pedidos');
    updatePedidosSyncInfo();
  }
}

function getRoutePlanStorageKey() {
  const choferId = me?.chofer_id || me?.id || 'anon';
  return `repartidor:route-plan:v1:${choferId}`;
}

function getRouteSlaStorageKey() {
  const choferId = me?.chofer_id || me?.id || 'anon';
  return `repartidor:route-sla:v1:${choferId}`;
}

function loadRouteSlaThreshold() {
  const raw = safeStorage.local.get(getRouteSlaStorageKey());
  const n = Number(raw || 30);
  slaEtaThresholdMin = Number.isFinite(n) && n >= 5 ? n : 30;
  const inp = document.getElementById('fSlaEta');
  if (inp) inp.value = String(slaEtaThresholdMin);
}

function saveRouteSlaThreshold(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n < 5) return;
  slaEtaThresholdMin = n;
  safeStorage.local.set(getRouteSlaStorageKey(), String(n));
}

function saveRoutePlan() {
  try {
    safeStorage.local.set(getRoutePlanStorageKey(), JSON.stringify(routePlan));
  } catch {}
}

function restoreRoutePlan() {
  try {
    const raw = safeStorage.local.get(getRoutePlanStorageKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    routePlan = {
      orderedIds: Array.isArray(data?.orderedIds) ? data.orderedIds.map((x) => Number(x)).filter(Boolean) : [],
      currentIndex: Number(data?.currentIndex || 0),
      updatedAt: data?.updatedAt || null,
    };
  } catch {}
}

function resetRoutePlan(showToast = false) {
  routePlan = { orderedIds: [], currentIndex: 0, updatedAt: null };
  saveRoutePlan();
  renderRoutePlanCard();
  if (showToast) toast('Ruta optimizada reiniciada');
}

function advanceRoutePlan() {
  if (!routePlan.orderedIds.length) return;
  routePlan.currentIndex = Math.min(routePlan.currentIndex + 1, routePlan.orderedIds.length - 1);
  routePlan.updatedAt = new Date().toISOString();
  saveRoutePlan();
  renderRoutePlanCard();
}

function syncRoutePlanWithPedidos() {
  if (!routePlan.orderedIds.length) return;
  const activeIds = new Set(
    (pedidos || [])
      .filter((p) => ['pendiente', 'en_ruta', 'en_camino'].includes(String(p.estado || '').toLowerCase()))
      .map((p) => Number(p.id))
      .filter(Boolean)
  );

  routePlan.orderedIds = routePlan.orderedIds.filter((id) => activeIds.has(id));
  if (routePlan.currentIndex >= routePlan.orderedIds.length) {
    routePlan.currentIndex = Math.max(0, routePlan.orderedIds.length - 1);
  }
  saveRoutePlan();
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (v) => (Number(v) * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function estimateEtaMin(km) {
  const avgKmH = 22; // urbano repartidor
  return Math.max(1, Math.round((Number(km || 0) / avgKmH) * 60));
}

function etaLevel(min) {
  const m = Number(min || 0);
  if (m > Number(slaEtaThresholdMin || 30)) return 'bad';
  if (m <= 15) return 'ok';
  return 'warn';
}

function etaBadgeHtml(min, km) {
  const level = etaLevel(min);
  const arrival = new Date(Date.now() + Number(min || 0) * 60_000)
    .toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const bg = level === 'ok' ? 'rgba(34,197,94,.18)' : level === 'warn' ? 'rgba(245,158,11,.18)' : 'rgba(239,68,68,.18)';
  const color = level === 'ok' ? '#86efac' : level === 'warn' ? '#fde68a' : '#fecaca';
  const slaTxt = level === 'bad' ? ` · SLA>${slaEtaThresholdMin}m` : '';
  return `<span style="display:inline-block; padding:2px 8px; border-radius:999px; background:${bg}; color:${color}; font-weight:700;">ETA ${min} min · ${km.toFixed(1)} km · llega ${arrival}${slaTxt}</span>`;
}

function isPedidoActivoCarga(pedido) {
  return ['pendiente', 'en_ruta', 'en_camino'].includes(String(pedido?.estado || '').toLowerCase());
}

function getPedidoItemsForCarga(pedido) {
  const candidates = [
    pedido?.items,
    pedido?.productos,
    pedido?.detalle,
    pedido?.items_activos,
    pedido?.productos_pendientes
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (typeof candidate === 'string' && candidate.trim()) {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
  }

  const pedidoQty = Number(pedido?.cantidad || pedido?.unidades || 0);
  if (Number.isFinite(pedidoQty) && pedidoQty > 0) {
    return [{
      producto: pedido?.producto || pedido?.producto_nombre || pedido?.nombre || `Pedido #${pedido?.id || ''}`.trim(),
      producto_id: pedido?.producto_id,
      cantidad: pedidoQty
    }];
  }

  return [];
}

function getItemProductKey(item) {
  const id = Number(item?.producto_id || item?.id_producto || 0);
  if (Number.isFinite(id) && id > 0) return `id:${id}`;
  return `name:${String(item?.producto || item?.nombre || item?.producto_nombre || item?.descripcion || 'Producto').trim().toLowerCase()}`;
}

function getItemQtyForCarga(item) {
  const qty = Number(
    item?.cantidad ??
    item?.qty ??
    item?.unidades ??
    item?.cantidad_pedida ??
    item?.cantidad_total ??
    item?.cantidad_pendiente ??
    item?.cantidad_entregar ??
    0
  );
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function getItemNameForCarga(item) {
  const name = item?.producto || item?.nombre || item?.producto_nombre || item?.descripcion;
  if (name) return name;

  const id = Number(item?.producto_id || item?.id_producto || 0);
  return Number.isFinite(id) && id > 0 ? `Producto ID ${id}` : 'Producto';
}

function getRetornablesPendientes(pedido) {
  const rows = Array.isArray(pedido?.retornables_pendientes) ? pedido.retornables_pendientes : [];
  return rows
    .map((r) => ({
      producto: r?.producto || r?.nombre || r?.producto_nombre || 'Retornable',
      saldo: Number(r?.saldo || 0),
    }))
    .filter((r) => Number.isFinite(r.saldo) && r.saldo > 0);
}

function renderRetornablesPendientes(pedido) {
  const rows = getRetornablesPendientes(pedido);
  if (!rows.length) return '';

  const detail = rows
    .map((r) => `<span><strong>${Number(r.saldo).toLocaleString('es-AR')}x</strong> ${esc(r.producto)}</span>`)
    .join('');

  return `
    <div style="margin-top:10px; background:rgba(245,158,11,.14); color:#fde68a; padding:9px; border-radius:8px; font-size:.88rem; border:1px solid rgba(245,158,11,.35);">
      <div style="font-weight:800; margin-bottom:4px;">Retirar retornables del cliente</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">${detail}</div>
    </div>`;
}

function renderCargaPendiente(list) {
  const totalEl = document.getElementById('cargaPendienteTotal');
  const listEl = document.getElementById('cargaPendienteList');
  if (!totalEl || !listEl) return;

  const byProduct = new Map();
  let totalUnits = 0;
  let activeOrders = 0;

  (Array.isArray(list) ? list : []).filter(isPedidoActivoCarga).forEach((pedido) => {
    activeOrders += 1;
    getPedidoItemsForCarga(pedido).forEach((item) => {
      const qty = getItemQtyForCarga(item);
      if (!qty) return;

      const key = getItemProductKey(item);
      const name = getItemNameForCarga(item);
      const current = byProduct.get(key) || { name, qty: 0 };
      current.qty += qty;
      byProduct.set(key, current);
      totalUnits += qty;
    });
  });

  totalEl.textContent = `${totalUnits} ${totalUnits === 1 ? 'unidad' : 'unidades'} · ${activeOrders} ${activeOrders === 1 ? 'pedido activo' : 'pedidos activos'}`;

  if (!totalUnits || !byProduct.size) {
    listEl.className = 'load-empty';
    listEl.textContent = activeOrders ? 'Pedidos activos sin detalle de productos.' : 'Sin carga pendiente.';
    return;
  }

  listEl.className = 'load-chips';
  listEl.innerHTML = Array.from(byProduct.values())
    .sort((a, b) => b.qty - a.qty || String(a.name).localeCompare(String(b.name), 'es'))
    .map((item) => `<span class="load-chip"><strong>${Number(item.qty).toLocaleString('es-AR')}x</strong> ${esc(item.name)}</span>`)
    .join('');
}

async function getCurrentPositionSafe() {
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
    );
  });
}

function renderRoutePlanCard() {
  const card = document.getElementById('routePlanCard');
  const body = document.getElementById('routePlanBody');
  const meta = document.getElementById('routePlanMeta');
  const btnAdvance = document.getElementById('btnRouteAdvance');
  if (!card || !body || !meta || !btnAdvance) return;

  if (!routePlan.orderedIds.length) {
    card.hidden = true;
    card.classList.remove('sla-critical');
    return;
  }

  card.hidden = false;
  const currentId = routePlan.orderedIds[routePlan.currentIndex];
  const p = pedidos.find((x) => Number(x.id) === Number(currentId));

  if (!p) {
    body.textContent = 'Ruta guardada, esperando sincronización de pedidos…';
    meta.textContent = routePlan.updatedAt ? `Actualizado ${new Date(routePlan.updatedAt).toLocaleTimeString('es-AR')}` : '-';
    card.classList.remove('sla-critical');
    return;
  }

  const mapsLink = (Number(p.latitud) && Number(p.longitud))
    ? `https://www.google.com/maps?q=${Number(p.latitud)},${Number(p.longitud)}`
    : null;

  let etaTxt = 'ETA: -';
  let leftTxt = '';

  const currLat = Number(p.latitud || 0);
  const currLng = Number(p.longitud || 0);

  if (currLat && currLng) {
    getCurrentPositionSafe().then((pos) => {
      if (!pos) return;
      const km = haversineKm(pos.lat, pos.lng, currLat, currLng);
      const eta = estimateEtaMin(km);
      const etaEl = document.getElementById('routeEtaNow');
      if (etaEl) etaEl.innerHTML = etaBadgeHtml(eta, km);

      const cardEl = document.getElementById('routePlanCard');
      const isCritical = etaLevel(eta) === 'bad';
      if (cardEl) cardEl.classList.toggle('sla-critical', isCritical);

      if (isCritical) {
        const now = Date.now();
        if (now - lastSlaToastAt > 120000) {
          toast(`⚠️ ETA supera SLA (${slaEtaThresholdMin} min).`);
          lastSlaToastAt = now;
        }
      }
    });

    let kmLeft = 0;
    let prev = { lat: currLat, lng: currLng };
    for (let i = routePlan.currentIndex + 1; i < routePlan.orderedIds.length; i++) {
      const nx = pedidos.find((x) => Number(x.id) === Number(routePlan.orderedIds[i]));
      const nLat = Number(nx?.latitud || 0);
      const nLng = Number(nx?.longitud || 0);
      if (!nLat || !nLng) continue;
      kmLeft += haversineKm(prev.lat, prev.lng, nLat, nLng);
      prev = { lat: nLat, lng: nLng };
    }
    if (kmLeft > 0) leftTxt = ` · Restante aprox: ${kmLeft.toFixed(1)} km`; 
  }

  body.innerHTML = `
    <div><b>#${p.id}</b> · ${esc(p.cliente || 'Cliente')}</div>
    <div class="muted" style="margin-top:2px;">${esc(p.direccion || '-')}</div>
    <div id="routeEtaNow" class="muted" style="margin-top:4px;">${etaTxt}</div>
    <div style="margin-top:6px; display:flex; gap:8px; flex-wrap:wrap;">
      <span class="muted">Estado: ${esc(String(p.estado || 'pendiente'))}</span>
      <span class="muted">Monto: ${money(p.monto)}</span>
      ${mapsLink ? `<a class="iconbtn ghost" style="padding:4px 8px; text-decoration:none;" target="_blank" href="${mapsLink}">📍 Ir ahora</a>` : ''}
    </div>
  `;

  meta.textContent = `Parada ${routePlan.currentIndex + 1} / ${routePlan.orderedIds.length}${leftTxt}`;
  btnAdvance.disabled = routePlan.currentIndex >= routePlan.orderedIds.length - 1;
}

// ==========================================
// NUEVA FUNCIÓN: OPTIMIZADOR DE RUTA (PostGIS)
// ==========================================

async function optimizarRuta() {
  if (!navigator.geolocation) return toast('GPS no disponible');

  const btn = $('#btnOpt');
  btn.disabled = true; 
  btn.innerHTML = '⏳ Calculando...';

  navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
          await withLock('ruta:optimizar', async () => {
            const { latitude, longitude } = pos.coords;
            const res = await api('/api/repartidor/optimizar-ruta', {
                method: 'POST',
                body: { lat: latitude, lng: longitude }
            });

            if (res.ok && res.ruta && res.ruta.length > 0) {
                // Obtenemos el orden devuelto por la API (nearest neighbor)
                const optimizedIds = res.ruta.map(r => r.id);
                
                // Mapa para búsqueda rápida de índice
                const orderMap = new Map(optimizedIds.map((id, index) => [id, index]));

                // Reordenamos el array local 'pedidos'
                pedidos.sort((a, b) => {
                    const idxA = orderMap.has(a.id) ? orderMap.get(a.id) : 9999;
                    const idxB = orderMap.has(b.id) ? orderMap.get(b.id) : 9999;
                    return idxA - idxB;
                });

                routePlan = {
                  orderedIds: optimizedIds,
                  currentIndex: 0,
                  updatedAt: new Date().toISOString(),
                };
                saveRoutePlan();

                renderCards();
                renderRoutePlanCard();
                toast('🚀 Ruta optimizada con éxito');
            } else {
                toast('⚠️ No se pudo optimizar (quizás no hay pedidos activos)');
            }
          });
      } catch (e) {
          console.error(e);
          notifyError(e?.message || 'Error al optimizar', e);
      } finally {
          btn.disabled = false;
          btn.innerHTML = '⚡ Optimizar Ruta';
      }
  }, (err) => {
      console.warn(err);
      toast(getGeoErrorMessage(err));
      if (getGeoErrorCode(err) === 1) showGpsHelp();
      btn.disabled = false;
      btn.innerHTML = '⚡ Optimizar Ruta';
  }, GEO_OPTS_ACTIVATE);
}

function renderCards() {
  const fEst = $('#fEstado').value;
  const fZon = $('#fZona').value;
  const fHoy = $('#fHoy').checked;
  const fTxt = $('#fSearch').value.toLowerCase();
  const today = getOyString();

  // 1. FILTRADO
  let list = pedidos.filter(p => {
    const isActive = isPedidoActivoCarga(p);

    // Filtro de "Solo Hoy" (aplica solo si no está activo/pendiente)
    if (fHoy && !isActive) {
      const fDb = p.fecha_entrega || p.fecha;
      if (isoToLocalYMD(fDb) !== today) return false;
    }

    // Filtros de Zona, Texto y Estado
    if (fZon && String(p.zona_id) !== fZon) return false;
    if (fTxt) {
      const haystack = [
        p.id,
        p.cliente,
        p.direccion,
        p.telefono,
        p.notas,
        p.estado,
        p.metodo_pago
      ].map(v => String(v ?? '').toLowerCase()).join(' | ');
      if (!haystack.includes(fTxt)) return false;
    }
    
    if (fEst === 'activos') {
      if (!isActive) return false;
    } else if (fEst && String(p.estado || '').toLowerCase() !== fEst) {
      return false;
    }
    return true;
  });

  renderCargaPendiente(list);

  // 2. GENERACIÓN DE HTML
  const html = list.map(p => {
    const stRaw = String(p.estado || '').toLowerCase();
    const st = ['pendiente', 'en_ruta', 'en_camino', 'entregado', 'cancelado'].includes(stRaw)
      ? stRaw
      : 'pendiente';
    const isVerif = verificadas.has(Number(p.id)) || p.validado;
    const met = (p.metodo_pago || 'efectivo').toLowerCase();
    
    // --- A. PROCESAR ÍTEMS CON PRECIOS ---
    let itemsHtml = '';
    if (Array.isArray(p.items) && p.items.length > 0) {
      itemsHtml = '<div style="margin-top:8px; font-size:0.9rem; color:var(--ink);">';
      p.items.forEach(it => {
        const prodName = it.producto || it.nombre || 'Prod';
        const pu = Number(it.precio_unitario || 0);
        const qty = Number(it.cantidad || 0);
        const totalLinea = pu * qty;
        const precioTxt = totalLinea > 0
          ? `<span style="color:var(--muted); font-size:0.85rem">${money(totalLinea)}</span>`
          : '';

        itemsHtml += `
          <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px dashed rgba(255,255,255,0.1); padding:4px 0;">
            <div style="display:flex; gap:6px;">
              <strong style="color:var(--brand)">${qty}x</strong>
              <span>${esc(prodName)}</span>
            </div>
            ${precioTxt}
          </div>`;
      });
      itemsHtml += '</div>';
    } else {
      itemsHtml = '<div style="margin-top:5px; font-style:italic; color:var(--muted); font-size:0.85rem">Sin detalle de ítems</div>';
    }

    const retornablesHtml = renderRetornablesPendientes(p);

    // --- B. NOTAS DESTACADAS ---
    const notasHtml = p.notas 
      ? `<div style="margin-top:10px; background:rgba(245, 158, 11, 0.15); color:#fbbf24; padding:8px; border-radius:6px; font-size:0.85rem; border:1px solid rgba(245, 158, 11, 0.3); display:flex; gap:6px; align-items:start;">
          <span>📝</span> <span>${esc(p.notas)}</span>
         </div>` 
      : '';

    // --- C. BOTONES DE ACCIÓN (Lógica de cambio de estado) ---
    const btnCancel = `<button class="iconbtn ghost" style="color:var(--danger); border-color:rgba(239, 68, 68, 0.3); margin-left:auto" onclick="setStatus(${p.id}, 'cancelado', this)">❌ Cancelar</button>`;
    
    let actions = '';
    if (st === 'pendiente') {
      actions = `
        <button class="iconbtn primary" onclick="setStatus(${p.id}, 'en_ruta', this)">🚚 Iniciar Ruta</button>
        ${btnCancel}
      `;
    } else if (st === 'en_ruta' || st === 'en_camino') {
      actions = `
        <button class="iconbtn success" onclick="setStatus(${p.id}, 'entregado', this)">✅ Entregar</button>
        <button class="iconbtn ghost" style="border-color:var(--warning); color:var(--warning);" onclick="setStatus(${p.id}, 'pendiente', this)">↩ Pausar (Pendiente)</button>
        ${btnCancel}
      `;
    }
    
    const icon = { pendiente:'🕒', en_ruta:'🚚', entregado:'✅', cancelado:'❌' }[st] || '•';
    const mapLink = p.latitud 
      ? `<a href="https://www.google.com/maps?q=${p.latitud},${p.longitud}" target="_blank" class="iconbtn ghost">📍 Ir</a>` 
      : '';
    const wppLink = p.telefono 
      ? `<a href="https://wa.me/${p.telefono.replace(/\D/g,'')}" target="_blank" class="iconbtn ghost">💬 Chat</a>` 
      : '';

    // --- D. BOTONES DE PAGO SEGÚN CANALES HABILITADOS ---
    const showEfec = !pagosCanales || pagosCanales.efectivo !== false;
    const showTrans = !pagosCanales || pagosCanales.transferencia !== false;
    const ctaCteHabilitada = p.cuenta_corriente_habilitada === true;
    const showCtaCte = ctaCteHabilitada && (!pagosCanales || pagosCanales.cuenta_corriente !== false);

    let payButtons = '';
    if (showEfec) {
      payButtons += `
        <div 
          class="pay-opt ${met === 'efectivo' ? 'active efectivo' : ''}"
          onclick="setPay(${p.id}, 'efectivo', this)"
        >
          💵 Efectivo
        </div>`;
    }

    if (showTrans) {
      payButtons += `
        <div 
          class="pay-opt ${met === 'transferencia' ? 'active transferencia' : ''}"
          onclick="setPay(${p.id}, 'transferencia', this)"
        >
          📱 Transf.
        </div>`;
    }

    if (showCtaCte) {
      payButtons += `
        <div
          class="pay-opt ${met === 'cuenta_corriente' ? 'active cuenta-corriente' : ''}"
          onclick="setPay(${p.id}, 'cuenta_corriente', this)"
        >
          🧾 Cta. Cte.
        </div>`;
    }

    if (isVerif) {
      payButtons += `<span class="verified-badge">✓ Verificada</span>`;
    }

    const payRowHtml = payButtons
      ? `<div class="pay-row">${payButtons}</div>`
      : '';

    return `
      <div class="pedido-card ${st}">
        <div class="pc-top">
          <div style="flex:1">
            <div class="pc-client">${esc(p.cliente)} <small style="opacity:0.6">#${p.id}</small></div>
            <div class="pc-addr">${esc(p.direccion)}</div>
          </div>
          <button class="pc-state-btn">${icon}</button>
        </div>
        ${itemsHtml}
        ${retornablesHtml}
        ${notasHtml}
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px; padding-top:8px; border-top:1px solid var(--border);">
          <span style="color:var(--muted); font-size:0.9rem; text-transform:uppercase; letter-spacing:0.5px;">Total a Cobrar</span>
          <span style="font-size:1.4rem; font-weight:bold; color:#fff; text-shadow:0 0 10px rgba(0,0,0,0.5)">${money(p.monto)}</span>
        </div>
        ${payRowHtml}
        <div class="pc-actions">
          ${mapLink}
          ${wppLink}
          ${actions}
        </div>
      </div>`;
  }).join('');

  $('#cardsContainer').innerHTML = html;
  $('#emptyMsg').hidden = list.length > 0;
}
