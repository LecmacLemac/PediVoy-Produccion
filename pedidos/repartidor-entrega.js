async function resolverZonaParaPedido(pedidoId){
  const pedido = pedidos.find(p => p.id === pedidoId);
  if (!pedido) return null;

  // Si ya tiene zona, no hacemos nada
  if (pedido.zona_id != null) return null;

  if (!Array.isArray(misZonas) || misZonas.length === 0) {
    // No tiene zonas asignadas -> dejamos "Sin zona"
    return null;
  }

  // Una sola zona -> auto-asignar
  if (misZonas.length === 1) {
    const z = misZonas[0];
    pedido.zona_id = z.id; // actualizamos en memoria para no volver a preguntar
    return z.id;
  }

  // Varias zonas -> que el repartidor elija
  const opciones = misZonas.map((z, idx) => `${idx + 1}) ${z.nombre}`).join('\n');
  const resp = prompt(
    'Tenés varias zonas asignadas.\n' +
    'Elegí la zona para este pedido escribiendo el número:\n\n' +
    opciones
  );

  if (resp === null) return null; // Canceló

  const idx = Number(resp) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= misZonas.length) {
    alert('Selección de zona inválida');
    return null;
  }

  const zona = misZonas[idx];
  pedido.zona_id = zona.id; // guardamos en memoria para siguientes acciones
  return zona.id;
}

async function abrirActivosPaso(pedidoId, { movimientosIniciales = [], propagarError = false } = {}) {
  activosModalState.pedidoId = pedidoId;
  activosModalState.movimientosIniciales = Array.isArray(movimientosIniciales)
    ? movimientosIniciales.map(movimiento => ({ ...movimiento }))
    : [];

  try {
    const data = await api(`/api/repartidor/pedidos/${pedidoId}/activos-resumen`);
    activosModalState.data = data;

    const itemsActivos = Array.isArray(data.items_activos) ? data.items_activos : [];
    const retItems = Array.isArray(data?.retornables_resumen?.items) ? data.retornables_resumen.items : [];

    const ped = data.pedido || {};
    $('#amPedidoTitle').textContent = [
      ped.cliente || '',
      ped.direccion || '',
      `#${pedidoId}`,
      ped.monto != null ? money(ped.monto) : null
    ].filter(Boolean).join(' · ');

    const c = $('#amContenido');
    let html = `
      <div style="border:1px solid rgba(148,163,184,0.22); border-radius:12px; padding:0.75rem; background:rgba(15,23,42,0.45);">
        <div style="font-weight:700;">Resumen de cierre</div>
        <div class="muted" style="font-size:0.84rem; margin-top:4px;">
          Método de pago: <b>${esc(ped.metodo_pago || 'Sin definir')}</b>
          · Importe: <b>${money(Number(ped.monto || 0))}</b>
        </div>
      </div>
    `;

    const actosCliente = Array.isArray(data.activos_cliente) ? data.activos_cliente : [];
    const actosDisp    = Array.isArray(data.activos_disponibles) ? data.activos_disponibles : [];
    const itemActivoPorProducto = new Map(itemsActivos.map(item => [Number(item.producto_id), Number(item.item_pedido_id)]));

    // Opciones de activos disponibles (las usamos para entrega nueva y para cambio)
    const opcionesDisp = actosDisp.map(ad => `
      <option value="${ad.id}">
        ${esc(ad.codigo || ad.tipo || '')}
        ${ad.numero_serie ? ' · ' + esc(ad.numero_serie) : ''}
        ${ad.alquiler_mensual != null ? ' · ' + money(ad.alquiler_mensual) : ''}
      </option>
    `).join('');

    // 1) Bloque principal: retornables/envases primero, compacto para trabajo en calle
    if (retItems.length) {
      html += `
        <div style="background:rgba(6,182,212,0.10); border:1px solid rgba(6,182,212,0.34); border-radius:14px; padding:0.85rem; margin-top:0.2rem;">
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
            <div>
              <strong style="font-size:1rem;">🔁 Envases a recibir</strong>
              <div class="muted" style="font-size:0.82rem; margin-top:3px;">Confirmá los vacíos que entrega el cliente.</div>
            </div>
          </div>
          <div style="margin-top:0.75rem; display:grid; gap:0.65rem;">
            ${retItems.map(r => {
              const pid = Number(r.producto_id);
              const entregados = Number(r.cantidad_entregada || 0);
              const saldoPrevio = Number(r.saldo_actual || 0);
              const maxExigible = Math.max(0, saldoPrevio + entregados);
              const sugerido = Math.min(maxExigible, Math.max(0, Number(r.sugerido_devolver ?? Math.min(entregados, maxExigible))));
              return `
                <div style="background:rgba(15,23,42,0.62); border:1px solid rgba(148,163,184,0.22); border-radius:12px; padding:0.7rem;">
                  <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start; flex-wrap:wrap;">
                    <div style="min-width:170px; flex:1;">
                      <div><strong>${esc(r.producto || ('Producto #' + pid))}</strong></div>
                      <div class="muted" style="font-size:0.82rem; margin-top:2px;">Llenos entregados: <b>${entregados}</b> · Deuda previa: <b>${saldoPrevio}</b> · Máximo a recibir: <b>${maxExigible}</b></div>
                    </div>
                    <label style="margin:0; min-width:145px; flex:0 0 145px;">
                      <span style="font-size:0.72rem; color:#67e8f9; text-transform:uppercase; font-weight:700;">Vacíos recibidos</span>
                      <input type="number" min="0" max="${maxExigible}" step="1" value="${sugerido}" data-retornable-devuelto="1" data-producto-id="${pid}" data-entregados="${entregados}" data-max-exigible="${maxExigible}" style="margin-top:4px; font-size:1.25rem; font-weight:800; text-align:center;">
                    </label>
                  </div>
                  <div style="display:flex; gap:0.5rem; margin-top:0.55rem; flex-wrap:wrap;">
                    <button type="button" class="iconbtn ghost" data-ret-btn="0" data-producto-id="${pid}" style="padding:0.45rem 0.75rem;">Recibió 0</button>
                    <button type="button" class="iconbtn success" data-ret-btn="correcto" data-producto-id="${pid}" data-value="${sugerido}" style="padding:0.45rem 0.75rem;">Correcto: ${sugerido}</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    // 2) Activos a entregar: el scanner conserva sus movimientos y evita pedirlos de nuevo.
    const usaScanner = activosModalState.movimientosIniciales.length > 0;
    if (usaScanner) {
      html += `
        <div style="margin-top:0.75rem; border:1px solid rgba(16,185,129,0.35); border-radius:12px; padding:0.75rem; background:rgba(16,185,129,0.10);">
          <strong>📷 Movimientos escaneados</strong>
          <div class="muted" style="font-size:0.82rem; margin-top:3px;">${activosModalState.movimientosIniciales.length} movimiento(s) conservados. Revisá el checklist y confirmá el cierre.</div>
        </div>
      `;
    } else if (itemsActivos.length) {
      html += `<div style="margin-top:0.75rem;">`;
      html += `<div style="font-weight:700; margin-bottom:0.45rem;">📦 Activos/equipos a entregar</div>`;
      html += `
        <button
          type="button"
          class="iconbtn primary"
          data-abrir-scanner="1"
          aria-label="Escanear activos o equipos requeridos por el pedido"
          style="width:100%; margin-bottom:0.65rem;">
          📷 Escanear activos/equipos
        </button>
      `;

      if (!actosDisp.length) {
        html += `
          <div style="background: rgba(245,158,11,0.10); padding:0.8rem; border-radius:10px; border:1px solid rgba(245,158,11,0.35);">
            <div><strong>⚠️ No tenés activos disponibles</strong></div>
            <div class="muted" style="font-size:0.85rem; margin-top:4px;">
              Este pedido requiere entregar activos, pero tu stock disponible figura vacío.
            </div>
          </div>
        `;
      } else {
        html += `<div class="modal-list" style="margin-top:0.4rem;">`;

        itemsActivos.forEach((it) => {
          const qty = Number(it.cantidad) || 1;
          const itemId = it.item_pedido_id ?? it.id ?? null;
          const productoId = it.producto_id ?? null;

          for (let q = 0; q < qty; q++) {
            html += `
              <div style="padding:6px 0; border-bottom:1px dashed rgba(148,163,184,0.25);">
                <div style="display:flex; justify-content:space-between; gap:10px; align-items:center; flex-wrap:wrap;">
                  <div>
                    <div><strong>${esc(it.producto || 'Activo')}</strong> <span class="muted" style="font-size:0.85rem;">(${q + 1}/${qty})</span></div>
                    <div class="muted" style="font-size:0.8rem;">Seleccioná el equipo a entregar</div>
                  </div>
                  <div style="min-width:240px; flex:1;">
                    <select
                      data-am-entrega="1"
                      data-am-item-id="${itemId != null ? String(itemId) : ''}"
                      data-am-producto-id="${productoId != null ? String(productoId) : ''}"
                      style="width:100%;">
                      <option value="">Elegir activo...</option>
                      ${opcionesDisp}
                    </select>
                  </div>
                </div>
              </div>
            `;
          }
        });

        html += `</div>`;
      }
      html += `</div>`;
    }

    // 3) Información secundaria cerrada por defecto
    const movimientos = Array.isArray(data.movimientos_existentes) ? data.movimientos_existentes : [];
    const detalleItems = [];

    if (itemsActivos.length) {
      detalleItems.push(`
        <div>
          <small class="muted">Productos marcados como activo</small>
          <ul style="list-style:none; padding:0; margin:0.4rem 0;">
            ${itemsActivos.map(it => `
              <li style="padding:3px 0;"><strong>${it.cantidad}x</strong> ${esc(it.producto || '')}</li>
            `).join('')}
          </ul>
        </div>
      `);
    }

    if (actosCliente.length) {
      detalleItems.push(`
        <div>
          <small class="muted">Activos actualmente vinculados al cliente</small>
          <div class="modal-list" style="margin-top:0.4rem;">
            ${actosCliente.map(a => {
              const productoId = Number(a.producto_id);
              const itemPedidoId = itemActivoPorProducto.get(productoId);
              return `
              <div style="padding:6px 0; border-bottom:1px dashed rgba(148,163,184,0.25);">
                <div style="display:flex; justify-content:space-between; gap:8px; align-items:center; flex-wrap:wrap;">
                  <div>
                    <div><strong>${esc(a.codigo || a.tipo || '')}</strong></div>
                    <div style="font-size:0.8rem; color:var(--muted);">
                      ${esc(a.tipo || '')} · Estado: ${esc(a.estado || '')}
                      ${a.numero_serie ? ' · N° Serie: ' + esc(a.numero_serie) : ''}
                      ${a.alquiler_mensual != null ? ' · Alquiler: ' + money(a.alquiler_mensual) : ''}
                    </div>
                  </div>

                  <div style="min-width:170px; flex:1;">
                    <select data-am-accion="${a.id}" data-am-item-id="${itemPedidoId}" data-am-producto-id="${productoId}" style="width:100%; margin-bottom:4px;">
                      <option value="">(Sin cambios)</option>
                      <option value="retiro">Retirar</option>
                      <option value="mantenimiento">Retirar a mant.</option>
                      <option value="cambio"${actosDisp.length ? '' : ' disabled'}>Cambiar por...</option>
                    </select>

                    <select data-am-nuevo="${a.id}" style="width:100%;" ${actosDisp.length ? 'disabled' : 'disabled'}>
                      <option value="">Elegir activo nuevo...</option>
                      ${opcionesDisp}
                    </select>
                  </div>
                </div>
              </div>
            `; }).join('')}
          </div>
        </div>
      `);
    }

    if (movimientos.length) {
      const idxActivos = {};
      [...actosCliente, ...actosDisp].forEach(a => {
        if (!a || a.id == null) return;
        idxActivos[a.id] = a;
      });

      const describeActivo = (id) => {
        if (!id) return '';
        const a = idxActivos[id];
        if (!a) return `Activo #${id}`;
        let label = a.codigo || a.tipo || `Activo #${id}`;
        if (a.numero_serie) label += ` · N° ${a.numero_serie}`;
        return label;
      };

      detalleItems.push(`
        <div>
          <small class="muted">Historial de movimientos en este pedido</small>
          <div class="modal-list" style="margin-top:0.4rem; max-height:160px; overflow-y:auto;">
            ${movimientos.map(m => {
              const tipoTxt   = (m.tipo_operacion || '').toUpperCase();
              const estadoTxt = m.estado || '';
              const obsTxt    = m.observacion || '';
              const fechaTxt  = m.accion_at_utc ? formatFechaHoraAR(m.accion_at_utc) : '';
              const principal   = describeActivo(m.activo_id);
              const relacionado = describeActivo(m.activo_relacionado_id);
              let activosHtml = esc(principal);
              if (m.tipo_operacion === 'cambio' && m.activo_relacionado_id) activosHtml += ' → ' + esc(relacionado);
              const metaLine = [fechaTxt, tipoTxt, estadoTxt].filter(Boolean).join(' · ');
              return `
                <div style="padding:4px 0; border-bottom:1px dashed rgba(148,163,184,0.25);">
                  <div style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted);">${esc(metaLine)}</div>
                  <div style="font-size:0.9rem;">${activosHtml}</div>
                  ${obsTxt ? `<div style="font-size:0.8rem; color:var(--muted); margin-top:2px;">Nota: ${esc(obsTxt)}</div>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `);
    }

    if (detalleItems.length) {
      html += `
        <details style="margin-top:0.75rem; border:1px solid rgba(148,163,184,0.18); border-radius:12px; padding:0.65rem; background:rgba(15,23,42,0.35);">
          <summary style="cursor:pointer; font-weight:700;">Ver detalles del pedido</summary>
          <div style="display:grid; gap:0.8rem; margin-top:0.75rem;">
            ${detalleItems.join('')}
          </div>
        </details>
      `;
    }

    c.innerHTML = html;

    $$('#activosModal button[data-abrir-scanner]').forEach(btn => {
      btn.addEventListener('click', abrirScannerActivosDesdeModal);
    });

    $$('#activosModal button[data-ret-btn]').forEach(btn => {
      btn.addEventListener('click', () => {
        const productoId = btn.getAttribute('data-producto-id');
        const inp = $(`#activosModal input[data-retornable-devuelto="1"][data-producto-id="${productoId}"]`);
        if (!inp) return;
        if (btn.getAttribute('data-ret-btn') === '0') {
          inp.value = '0';
        } else {
          inp.value = btn.getAttribute('data-value') || inp.getAttribute('data-entregados') || '0';
        }
        inp.focus();
      });
    });

    $('#amObs').value = '';
    $('#amChkCliente').checked = true;
    $('#amChkProducto').checked = true;
    $('#amChkCobro').checked = false;
    $('#amGeo').checked = true;
    if ($('#amFoto')) $('#amFoto').value = '';
    setupFirmaEntregaCanvas();
    limpiarFirmaEntrega();
    $('#activosModal').hidden = false;

    // Listeners: habilitar combo "nuevo activo" cuando eligen CAMBIO
    $$('#activosModal select[data-am-accion]').forEach(sel => {
      sel.addEventListener('change', () => {
        const idViejo = sel.getAttribute('data-am-accion');
        const nuevoSel = $(`#activosModal select[data-am-nuevo="${idViejo}"]`);
        if (!nuevoSel) return;

        if (sel.value === 'cambio') {
          nuevoSel.disabled = false;
        } else {
          nuevoSel.disabled = true;
          nuevoSel.value = '';
        }
      });
    });

  } catch (e) {
    console.error(e);
    alert('No se pudieron cargar los datos de cierre de este pedido.');
    activosModalState.pedidoId = null;
    activosModalState.data = null;
    activosModalState.movimientosIniciales = [];
    if (propagarError) throw e;
  }
}

function setupFirmaEntregaCanvas() {
  const canvas = document.getElementById('amFirma');
  if (!canvas || canvas.dataset.ready === '1') return;

  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111827';

  let drawing = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * (canvas.width / r.width), y: (t.clientY - r.top) * (canvas.height / r.height) };
  };

  const start = (e) => { drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); canvas.dataset.hasSign = '1'; };
  const move = (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
  const end = () => { drawing = false; };

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); start(e); }, { passive: false });
  canvas.addEventListener('touchmove', (e) => { e.preventDefault(); move(e); }, { passive: false });
  canvas.addEventListener('touchend', end);

  canvas.dataset.ready = '1';
}

function limpiarFirmaEntrega() {
  const canvas = document.getElementById('amFirma');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.dataset.hasSign = '';
}

async function readFileAsDataUrl(file) {
  if (!file) return null;
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}

async function getGeoEntregaIfEnabled() {
  const useGeo = !!document.getElementById('amGeo')?.checked;
  if (!useGeo || !navigator.geolocation) return null;

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy || null }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 15000 }
    );
  });
}

async function buildEntregaMeta() {
  const checklist = {
    cliente_confirmado: !!document.getElementById('amChkCliente')?.checked,
    producto_entregado: !!document.getElementById('amChkProducto')?.checked,
    cobro_confirmado: !!document.getElementById('amChkCobro')?.checked,
  };

  const fotoFile = document.getElementById('amFoto')?.files?.[0] || null;
  const foto_data_url = await readFileAsDataUrl(fotoFile);

  const firmaCanvas = document.getElementById('amFirma');
  const firma_data_url = (firmaCanvas && firmaCanvas.dataset.hasSign === '1') ? firmaCanvas.toDataURL('image/png') : null;

  const geo = await getGeoEntregaIfEnabled();

  return {
    checklist,
    evidencia: {
      foto_data_url,
      firma_data_url,
      geo,
      ts: new Date().toISOString(),
    },
  };
}

function cerrarActivosModal() {
  $('#activosModal').hidden = true;
  activosModalState = { pedidoId: null, data: null, movimientosIniciales: [] };
}

async function confirmarEntregaConActivos() {
  const pid = activosModalState.pedidoId;
  if (!pid) {
    cerrarActivosModal();
    return;
  }

  const checklist = {
    cliente_confirmado: document.getElementById('amChkCliente')?.checked === true,
    producto_entregado: document.getElementById('amChkProducto')?.checked === true,
    cobro_confirmado: document.getElementById('amChkCobro')?.checked === true,
  };
  const faltantesChecklist = [];
  if (checklist.cliente_confirmado !== true) faltantesChecklist.push('cliente');
  if (checklist.producto_entregado !== true) faltantesChecklist.push('producto');
  if (checklist.cobro_confirmado !== true) faltantesChecklist.push('cobro');
  if (faltantesChecklist.length) {
    alert(`Falta confirmar: ${faltantesChecklist.join(', ')}.`);
    return;
  }

  if (!confirm('¿Confirmás el cierre final de la entrega y los movimientos seleccionados?')) {
    return;
  }

  const movimientos = Array.isArray(activosModalState.movimientosIniciales)
    ? activosModalState.movimientosIniciales.map(movimiento => ({ ...movimiento }))
    : [];
  let faltaSeleccionNuevo = false;
  const claveAsignacion = (itemPedidoId, productoId) => `${Number(itemPedidoId)}:${Number(productoId)}`;
  const requeridosPorClave = new Map();
  for (const item of (activosModalState.data?.items_activos || [])) {
    const itemPedidoId = Number(item.item_pedido_id);
    const productoId = Number(item.producto_id);
    const cantidad = Number(item.cantidad);
    requeridosPorClave.set(claveAsignacion(itemPedidoId, productoId), cantidad);
  }
  const asignacionesPorClave = new Map();
  for (const movimiento of movimientos) {
    if (movimiento.tipoOperacion === 'entrega' || movimiento.tipoOperacion === 'cambio') {
      const clave = claveAsignacion(movimiento.itemPedidoId, movimiento.productoId);
      asignacionesPorClave.set(clave, (asignacionesPorClave.get(clave) || 0) + 1);
    }
  }

  // 0) Recolectar primero cambios: cada cambio consume una unidad requerida.
  $$('#activosModal select[data-am-accion]').forEach(sel => {
    const tipo = sel.value;
    const activoViejoId = Number(sel.getAttribute('data-am-accion'));
    const itemPedidoId = Number(sel.getAttribute('data-am-item-id'));
    const productoId = Number(sel.getAttribute('data-am-producto-id'));
    if (!tipo || !activoViejoId) return;

    if (tipo === 'retiro' || tipo === 'mantenimiento') {
      movimientos.push({ tipoOperacion: tipo, activoId: activoViejoId, itemPedidoId, productoId });
      return;
    }
    if (tipo === 'cambio') {
      const nuevoSel = $(`#activosModal select[data-am-nuevo="${activoViejoId}"]`);
      const nuevoId = nuevoSel ? Number(nuevoSel.value) : 0;
      if (!nuevoId) {
        faltaSeleccionNuevo = true;
        return;
      }
      movimientos.push({
        tipoOperacion: 'cambio',
        activoId: nuevoId,
        activoRelacionadoId: activoViejoId,
        itemPedidoId,
        productoId
      });
      const clave = claveAsignacion(itemPedidoId, productoId);
      asignacionesPorClave.set(clave, (asignacionesPorClave.get(clave) || 0) + 1);
    }
  });

  if (faltaSeleccionNuevo) {
    alert('Seleccionaste "Cambiar por..." pero no elegiste el activo nuevo en al menos un caso.');
    return;
  }
  for (const [clave, asignadas] of asignacionesPorClave) {
    if (asignadas > (requeridosPorClave.get(clave) || 0)) {
      alert('Sobran cambios o asignaciones de activos para los productos del pedido.');
      return;
    }
  }

  // 1) Exigir entregas sólo para las unidades que no fueron cubiertas por cambios.
  let faltaAsignacion = false;
  $$('#activosModal select[data-am-entrega="1"]').forEach(sel => {
    const itemPedidoId = Number(sel.getAttribute('data-am-item-id') || 0) || null;
    const productoId = Number(sel.getAttribute('data-am-producto-id') || 0) || null;
    const clave = claveAsignacion(itemPedidoId, productoId);
    const requeridas = requeridosPorClave.get(clave) || 0;
    const asignadas = asignacionesPorClave.get(clave) || 0;
    if (asignadas >= requeridas) return;

    const activoId = Number(sel.value || 0);
    if (!activoId) {
      faltaAsignacion = true;
      return;
    }
    movimientos.push({ tipoOperacion: 'entrega', activoId, itemPedidoId, productoId });
    asignacionesPorClave.set(clave, asignadas + 1);
  });

  for (const [clave, requeridas] of requeridosPorClave) {
    if ((asignacionesPorClave.get(clave) || 0) !== requeridas) faltaAsignacion = true;
  }
  if (faltaAsignacion) {
    alert('Faltan asignaciones de activos: completá las entregas restantes o revisá los cambios.');
    return;
  }

  // 2) Evitar duplicados en la misma entrega (entrega + cambios)
  const idsUsados = movimientos
    .filter(m => m.tipoOperacion === 'entrega' || m.tipoOperacion === 'cambio')
    .map(m => Number(m.activoId))
    .filter(Boolean);

  const setIds = new Set(idsUsados);
  if (idsUsados.length !== setIds.size) {
    alert('Estás asignando el mismo activo nuevo más de una vez. Corregilo antes de confirmar.');
    return;
  }

  // 3) Observación común
  const obs = $('#amObs')?.value || '';
  movimientos.forEach(m => { m.observacion = obs; });

  try {
    const zonaId = await resolverZonaParaPedido(pid);

    const meta = await buildEntregaMeta();

    const retornables = [];
    let errorRetornable = '';
    $$('[data-retornable-devuelto="1"]').forEach(inp => {
      if (errorRetornable) return;
      const productoId = Number(inp.getAttribute('data-producto-id') || 0);
      const raw = String(inp.value ?? '').trim();
      const devueltos = Number(raw);
      const maxExigible = Number(inp.getAttribute('data-max-exigible'));
      if (!raw || !Number.isSafeInteger(devueltos) || devueltos < 0) {
        errorRetornable = 'La cantidad de vacíos debe ser un entero mayor o igual a 0.';
        return;
      }
      if (!Number.isSafeInteger(maxExigible) || devueltos > maxExigible) {
        errorRetornable = `La cantidad de vacíos supera el máximo exigible (${maxExigible}).`;
        return;
      }
      retornables.push({ producto_id: productoId, devueltos });
    });
    if (errorRetornable) {
      alert(errorRetornable);
      return;
    }

    // ✅ ÚNICA llamada transaccional: entrega + movimientos + stock chofer + retornables (backend)
    const body = { movimientos, retornables, checklist: meta.checklist, evidencia: meta.evidencia };
    if (zonaId != null) body.zona_id = zonaId;

    await withLock(`entregar:${pid}`, async () => {
      await api(`/api/repartidor/pedidos/${pid}/entregar`, {
        method: 'POST',
        body
      });
    });

    toast('✅ Entrega registrada');
    pedidoEnProcesoId = null;
    cerrarActivosModal();
    await loadPedidos();
  } catch (e) {
    console.error(e);
    alert(e?.message || 'Error guardando la entrega y los movimientos de activos.');
  }
}

function limpiarEstadoScannerActivos() {
  document.querySelectorAll('.input-asignar, .input-retirar').forEach(input => {
    input.value = '';
    input.style.border = '';
  });
  const lista = document.getElementById('listaActivosEscanear');
  if (lista) lista.innerHTML = '';
  pedidoEnProcesoId = null;
}

async function abrirScannerActivosDesdeModal() {
  const pedidoId = Number(activosModalState.pedidoId);
  const movimientosIniciales = Array.isArray(activosModalState.movimientosIniciales)
    ? activosModalState.movimientosIniciales
    : [];
  const itemsActivos = Array.isArray(activosModalState.data?.items_activos)
    ? activosModalState.data.items_activos
    : [];

  if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0 || movimientosIniciales.length > 0) {
    toast('⚠️ No se puede abrir el scanner para este cierre.');
    return;
  }
  if (!itemsActivos.length) {
    toast('⚠️ Este pedido no tiene activos requeridos para escanear.');
    return;
  }

  const unidades = [];
  for (const item of itemsActivos) {
    const itemPedidoId = Number(item?.item_pedido_id);
    const productoId = Number(item?.producto_id);
    const cantidad = Number(item?.cantidad);
    if (!Number.isSafeInteger(itemPedidoId) || itemPedidoId <= 0
        || !Number.isSafeInteger(productoId) || productoId <= 0
        || !Number.isSafeInteger(cantidad) || cantidad <= 0) {
      toast('⚠️ Los activos requeridos no tienen IDs o cantidades válidos.');
      return;
    }
    for (let unidad = 1; unidad <= cantidad; unidad += 1) {
      unidades.push({
        itemPedidoId,
        productoId,
        producto: String(item?.producto || `Producto #${productoId}`),
        unidad,
        cantidad,
      });
    }
  }

  if (!unidades.length) {
    toast('⚠️ Este pedido no tiene activos requeridos para escanear.');
    return;
  }

  const lista = document.getElementById('listaActivosEscanear');
  const scannerModal = document.getElementById('modalEscanearActivos');
  const universalModal = document.getElementById('activosModal');
  if (!lista || !scannerModal || !universalModal) {
    toast('⚠️ No se pudo abrir el scanner de activos.');
    return;
  }

  lista.innerHTML = unidades.map(({ itemPedidoId, productoId, producto, unidad, cantidad }) => `
    <div class="scan-item" style="padding:0.75rem; border:1px solid var(--border); border-radius:10px; margin-bottom:0.65rem;">
      <div style="font-weight:700; margin-bottom:0.5rem;">${esc(producto)} <span class="muted">(${unidad}/${cantidad})</span></div>
      <label style="display:block; margin-bottom:0.5rem;">
        Equipo a entregar
        <input class="input-asignar" data-item-id="${itemPedidoId}" data-prod-id="${productoId}" inputmode="numeric" autocomplete="off" aria-label="ID del equipo a entregar para ${esc(producto)}, unidad ${unidad} de ${cantidad}" placeholder="Escanear ID a entregar">
      </label>
      <label style="display:block;">
        Equipo a retirar (opcional)
        <input class="input-retirar" data-item-id="${itemPedidoId}" data-prod-id="${productoId}" inputmode="numeric" autocomplete="off" aria-label="ID del equipo a retirar para ${esc(producto)}, unidad ${unidad} de ${cantidad}" placeholder="Escanear ID a retirar">
      </label>
    </div>
  `).join('');

  pedidoEnProcesoId = pedidoId;
  universalModal.hidden = true;
  scannerModal.style.display = 'flex';
}

async function confirmarEntregaScanner() {
  // 1. Capturamos los inputs del modal de escaneo
  const inputsAsignar = document.querySelectorAll('.input-asignar');
  const inputsRetirar = document.querySelectorAll('.input-retirar');
  
  const movimientos = [];
  let error = false;
  let errorMensaje = '';
  const idsUsados = new Set();

  if (!inputsAsignar.length || inputsAsignar.length !== inputsRetirar.length) {
    toast('⚠️ No hay filas válidas para confirmar el scanner.');
    return;
  }

  // 2. Recorremos cada fila (cada ítem del pedido)
  inputsAsignar.forEach((inp, idx) => {
    const valorAsignar = inp.value.trim();                // ID Nuevo (Entrega)
    const retirarInput = inputsRetirar[idx];
    const valorRetirar = retirarInput.value.trim(); // ID Viejo (Retiro)
    const itemPedidoId = Number(inp.dataset.itemId);
    const prodId = Number(inp.dataset.prodId);
    const asignarId = valorAsignar ? Number(valorAsignar) : null;
    const retirarId = valorRetirar ? Number(valorRetirar) : null;
    const itemPedidoIdValido = /^\d+$/.test(String(inp.dataset.itemId || '')) && Number.isSafeInteger(itemPedidoId) && itemPedidoId > 0;
    const prodIdValido = /^\d+$/.test(String(inp.dataset.prodId || '')) && Number.isSafeInteger(prodId) && prodId > 0;
    const asignarIdValido = /^\d+$/.test(valorAsignar) && Number.isSafeInteger(asignarId) && asignarId > 0;
    const retirarIdValido = !valorRetirar || (/^\d+$/.test(valorRetirar) && Number.isSafeInteger(retirarId) && retirarId > 0);
    const idsFila = [asignarId, retirarId].filter(id => id != null);
    const tieneDuplicado = idsFila.some(id => idsUsados.has(id)) || (idsFila.length === 2 && idsFila[0] === idsFila[1]);

    // Validación visual: marcar rojo si ambos están vacíos
    if (
      !valorAsignar
      || !itemPedidoIdValido
      || !prodIdValido
      || !asignarIdValido
      || !retirarIdValido
      || tieneDuplicado
    ) {
      inp.style.border = '1px solid red';
      retirarInput.style.border = '1px solid red';
      error = true;
      if (!valorAsignar || !asignarIdValido) {
        errorMensaje = '⚠️ El equipo a entregar es obligatorio y debe tener un ID válido en cada fila.';
      } else if (tieneDuplicado) {
        errorMensaje = '⚠️ Hay un ID de activo repetido entre filas u operaciones.';
      } else {
        errorMensaje = '⚠️ La fila contiene IDs de pedido, producto o activo inválidos.';
      }
    } else {
      inp.style.border = '1px solid var(--border)';
      retirarInput.style.border = '1px solid var(--border)';
      
      idsFila.forEach(id => idsUsados.add(id));
      movimientos.push({
        tipoOperacion: 'entrega',
        activoId: asignarId,
        itemPedidoId,
        productoId: prodId,
        origen: 'scanner_app'
      });

      // B. RETIRO: Si hay un valor en el input de retirar, es un retiro
      if (valorRetirar) {
        movimientos.push({
          tipoOperacion: 'retiro',
          activoId: retirarId,
          itemPedidoId,
          productoId: prodId,
          observacion: 'Retiro registrado por escáner'
        });
      }
    }
  });

  // 3. Validaciones finales
  if (error) {
    toast(errorMensaje || '⚠️ El equipo a entregar es obligatorio en cada fila.');
    return;
  }

  if (movimientos.length === 0) {
    toast('⚠️ No hay datos para enviar.');
    return;
  }

  // 4. Volver al mismo cierre universal sin reconstruir su DOM ni repetir consultas.
  const modal = document.getElementById('modalEscanearActivos');
  const universalModal = document.getElementById('activosModal');
  if (!pedidoEnProcesoId || !universalModal) {
    toast('❌ Error: se perdió el cierre activo');
    return;
  }
  activosModalState.movimientosIniciales = movimientos.map(movimiento => ({ ...movimiento }));
  if (modal) modal.style.display = 'none';
  universalModal.hidden = false;
  limpiarEstadoScannerActivos();
}

function cerrarModalEscaneo() {
  const modal = document.getElementById('modalEscanearActivos');
  if (modal) modal.style.display = 'none';
  limpiarEstadoScannerActivos();
  const universalModal = document.getElementById('activosModal');
  if (universalModal && activosModalState.pedidoId) universalModal.hidden = false;
}

async function abrirModalPagoQR(pedidoId) {
  const pedido = pedidos.find(p => p.id === pedidoId);
  if (!pedido) {
    toast('Pedido no encontrado');
    return;
  }

  qrPagoState.pedidoId = pedidoId;
  qrPagoState.link = null;

  const modal = document.getElementById('modalPagoQR');
  const infoEl = document.getElementById('qrInfoTexto');
  const canvas = document.getElementById('qrCanvas');

  infoEl.textContent = `Mostrá este QR al cliente para pagar ${money(pedido.monto)}.`;

  // Limpiar canvas
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  modal.style.display = 'flex';

  try {
    const pago = await api(`/api/repartidor/pedidos/${pedidoId}/pago-qr`, {
      method: 'POST',
      body: {
        canal: 'repartidor',      // desde el chofer
        metodoPago: 'qr_dinamico' // método de pago canónico
      }
    });

    // Texto por si el proveedor devuelve checkout_url, etc.
    infoEl.textContent = `Mostrá este QR al cliente para pagar ${money(pedido.monto)}.`;

    const qrValue = pago.qr_payload || pago.checkout_url;
    if (!qrValue) {
      infoEl.textContent = 'No se pudo generar el QR de pago.';
      return;
    }

    // Generar código QR en el canvas
    new QRious({
      element: canvas,
      value: qrValue,
      size: 240
    });

    qrPagoState.link = qrValue;
  } catch (e) {
    console.error('Error generando pago QR', e);
    infoEl.textContent = 'Error generando el QR de pago.';
  }
}

function cerrarModalPagoQR() {
  const modal = document.getElementById('modalPagoQR');
  if (modal) modal.style.display = 'none';
  qrPagoState = { pedidoId: null, link: null };
}

async function usarTransferenciaManualQR(el = null) {
  const id = qrPagoState.pedidoId;
  if (!id) {
    toast('Pedido no encontrado');
    return;
  }

  const restoreBtn = setActionBusy(el, true);

  try {
    await api(`/api/repartidor/pedidos/${id}/transferencia/notificar`, { method: 'POST' });
    toast('WhatsApp de transferencia enviado');
    cerrarModalPagoQR();
    await abrirActivosPaso(id);
  } catch (e) {
    notifyError(e?.message || 'No se pudo enviar el WhatsApp de transferencia', e);
  } finally {
    restoreBtn();
  }
}

async function confirmarPagoQR() {
  const id = qrPagoState.pedidoId;
  if (!id) return;

  try {
    const estado = await api(`/api/repartidor/pedidos/${id}/pago-qr/estado`, { cache: 'no-store' });
    if (!estado?.pagado) {
      toast('El pago QR todavía no figura aprobado.');
      return;
    }

    cerrarModalPagoQR();
    await abrirActivosPaso(id);
  } catch (e) {
    notifyError(e?.message || 'No se pudo validar el pago QR', e);
  }
}

function setActionBusy(el, busy = true) {
  if (!el) return () => {};

  const tag = (el.tagName || '').toLowerCase();
  const originalHtml = el.innerHTML;
  const hadDisabled = !!el.disabled;
  const originalPointer = el.style.pointerEvents;
  const originalOpacity = el.style.opacity;

  if (busy) {
    if (tag === 'button') {
      el.disabled = true;
      el.innerHTML = '⏳ Procesando...';
    } else {
      el.style.pointerEvents = 'none';
      el.style.opacity = '0.6';
      if (!/Procesando/.test(el.textContent || '')) {
        el.innerHTML = '⏳ Procesando...';
      }
    }
  }

  return () => {
    if (tag === 'button') {
      el.disabled = hadDisabled;
      el.innerHTML = originalHtml;
    } else {
      el.style.pointerEvents = originalPointer;
      el.style.opacity = originalOpacity;
      el.innerHTML = originalHtml;
    }
  };
}

async function setStatus(id, st, el = null){
  const statusPermitidos = ['pendiente', 'en_ruta', 'en_camino', 'entregado', 'cancelado'];
  if (!statusPermitidos.includes(String(st))) {
    toast('Estado inválido');
    return;
  }

  const restoreBtn = setActionBusy(el, true);

  try {
    await withLock(`status:${id}`, async () => {
      if (st === 'entregado') {
        const pedido = pedidos.find(p => p.id === id);
        const met = (pedido && pedido.metodo_pago ? String(pedido.metodo_pago) : '').toLowerCase();

        const esTransferencia = met === 'transferencia';
        const qrHabilitado = !!(pagosCanales && pagosCanales.qr_dinamico);

        if (esTransferencia && qrHabilitado) {
          await abrirModalPagoQR(id);
          return;
        }

        await abrirActivosPaso(id);
        return;
      }

      if (st === 'cancelado' && !confirm(
        '⚠️ ¿Estás seguro de que deseas CANCELAR este pedido?\nEsta acción lo quitará de tu lista activa.'
      )) return;

      // Resolver zona si el pedido no tiene
      const zonaId = await resolverZonaParaPedido(id);

      const body = { estado: st };
      if (zonaId != null) body.zona_id = zonaId;

      await api(`/api/repartidor/pedidos/${id}`, { method:'PUT', body });

      if (st === 'en_ruta' && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
          updateDriverLocationOnMap(pos);
          gpsSyncState.disabled = false;
          gpsSyncState.denied = false;
          persistGpsPreference(true);
          updateGpsButtonUI();
          api('/api/track/update', {
            method:'POST',
            body:{ pedido_id:id, lat:pos.coords.latitude, lng:pos.coords.longitude }
          });
        }, err => {
          console.warn('GPS Error', err);
          const code = getGeoErrorCode(err);
          if (code === 1) {
            gpsSyncState.denied = true;
            gpsSyncState.disabled = true;
            persistGpsPreference(false);
            updateGpsButtonUI();
          } else {
            toast(getGeoErrorMessage(err));
          }
        }, GEO_OPTS_ACTIVATE);
      }

      await loadPedidos();
    });
  } catch (e) {
    notifyError(e?.message || 'No se pudo actualizar el estado del pedido', e);
  } finally {
    restoreBtn();
  }
}

async function setPay(id, met, el = null) {
  // Normalizar y validar método
  const metodo = String(met || '').toLowerCase();
  const permitidos = ['efectivo', 'transferencia', 'cuenta_corriente'];

  if (!permitidos.includes(metodo)) {
    toast('Método de pago inválido');
    return;
  }

  const pedido = pedidos.find(p => Number(p.id) === Number(id));
  if (metodo === 'cuenta_corriente' && pedido?.cuenta_corriente_habilitada !== true) {
    toast('Este cliente no está habilitado para Cta. Cte.');
    return;
  }

  // Respetar canales habilitados por la empresa
  if (pagosCanales && pagosCanales[metodo] === false) {
    toast('Este método de cobro no está habilitado para tu empresa.');
    return;
  }

  const restoreBtn = setActionBusy(el, true);

  try {
    await withLock(`pay:${id}`, async () => {
      // También acá: si el pedido sigue sin zona, la resolvemos al cambiar forma de pago
      const zonaId = await resolverZonaParaPedido(id);

      const body = { metodo_pago: metodo };
      if (zonaId != null) body.zona_id = zonaId;

      await api(`/api/repartidor/pedidos/${id}`, { method: 'PUT', body });
      await loadPedidos();
    });
  } catch (e) {
    notifyError(e?.message || 'No se pudo actualizar el método de pago', e);
  } finally {
    restoreBtn();
  }
}

function toast(m){ const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 2000); }
