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

async function abrirActivosPaso(pedidoId) {
  activosModalState.pedidoId = pedidoId;
  let etapa = 'activos';

  try {
    const data = await api(`/api/repartidor/pedidos/${pedidoId}/activos-resumen`);
    activosModalState.data = data;

    const itemsActivos = Array.isArray(data.items_activos) ? data.items_activos : [];
    const retItems = Array.isArray(data?.retornables_resumen?.items) ? data.retornables_resumen.items : [];

    // 🔴 CASO 1: NO hay productos activos NI retornables -> entregar directo (TRANSACCIONAL)
    if (itemsActivos.length === 0 && retItems.length === 0) {
      const zonaId = await resolverZonaParaPedido(pedidoId);

      etapa = 'entrega';
      await withLock(`entregar:${pedidoId}`, async () => {
        await api(`/api/repartidor/pedidos/${pedidoId}/entregar`, {
          method: 'POST',
          body: {
            zona_id: zonaId != null ? zonaId : null,
            movimientos: [],
            retornables: [],
            checklist: {
              cliente_confirmado: true,
              producto_entregado: true,
              cobro_confirmado: false,
            },
          }
        });
      });

      toast('✅ Pedido entregado');
      activosModalState.pedidoId = null;
      activosModalState.data = null;
      await loadPedidos();
      return;
    }

    // 🟢 CASO 2: SÍ hay productos activos -> mostrar modal

    const ped = data.pedido || {};
    $('#amPedidoTitle').textContent = [
      ped.cliente || '',
      ped.direccion || '',
      `#${pedidoId}`,
      ped.monto != null ? money(ped.monto) : null
    ].filter(Boolean).join(' · ');

    const c = $('#amContenido');
    let html = '';

    const actosCliente = Array.isArray(data.activos_cliente) ? data.activos_cliente : [];
    const actosDisp    = Array.isArray(data.activos_disponibles) ? data.activos_disponibles : [];

    // Opciones de activos disponibles (las usamos para entrega nueva y para cambio)
    const opcionesDisp = actosDisp.map(ad => `
      <option value="${ad.id}">
        ${esc(ad.codigo || ad.tipo || '')}
        ${ad.numero_serie ? ' · ' + esc(ad.numero_serie) : ''}
        ${ad.alquiler_mensual != null ? ' · ' + money(ad.alquiler_mensual) : ''}
      </option>
    `).join('');

    // 1) Productos activos del pedido
    if (itemsActivos.length) {
      html += `
        <div>
          <small class="muted">Productos de este pedido marcados como activo</small>
          <ul style="list-style:none; padding:0; margin:0.4rem 0;">
            ${itemsActivos.map(it => `
              <li style="padding:3px 0;">
                <strong>${it.cantidad}x</strong> ${esc(it.producto || '')}
              </li>
            `).join('')}
          </ul>
        </div>
      `;
    }

    if (retItems.length) {
      html += `
        <div style="background:rgba(6,182,212,0.08); border:1px solid rgba(6,182,212,0.28); border-radius:12px; padding:0.75rem; margin-top:0.6rem;">
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
            <div>
              <strong>🔁 Retornables / envases</strong>
              <div class="muted" style="font-size:0.82rem; margin-top:3px;">Registrá cuántos vacíos entrega el cliente. Si no devuelve, queda deuda de envases.</div>
            </div>
          </div>
          <div style="margin-top:0.65rem; display:grid; gap:0.55rem;">
            ${retItems.map(r => {
              const pid = Number(r.producto_id);
              const entregados = Number(r.cantidad_entregada || 0);
              const saldoPrevio = Number(r.saldo_actual || 0);
              const sugerido = Math.max(0, Number(r.sugerido_devolver ?? Math.min(entregados, saldoPrevio + entregados)));
              return `
                <div style="display:grid; grid-template-columns:1fr 120px; gap:10px; align-items:center; background:rgba(15,23,42,0.58); border:1px solid rgba(148,163,184,0.22); border-radius:10px; padding:0.55rem;">
                  <div>
                    <div><strong>${esc(r.producto || ('Producto #' + pid))}</strong></div>
                    <div class="muted" style="font-size:0.8rem;">Entrega: ${entregados} lleno(s) · Saldo previo cliente: ${saldoPrevio}</div>
                  </div>
                  <label style="margin:0;">
                    <span style="font-size:0.68rem; color:var(--muted); text-transform:uppercase;">Vacíos recibidos</span>
                    <input type="number" min="0" step="1" value="${sugerido}" data-retornable-devuelto="1" data-producto-id="${pid}" data-entregados="${entregados}" style="margin-top:3px;">
                  </label>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    if (itemsActivos.length) {
      html += `<hr style="border-color:rgba(148,163,184,0.3); margin:0.6rem 0;">`;

      // 2) NUEVO: Seleccionar activos a ENTREGAR (aunque el cliente no tenga activos)
      //    (1 select por unidad según cantidad)
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
        html += `<small class="muted">Seleccionar activos disponibles para entregar</small>`;
        html += `<div class="modal-list" style="margin-top:0.4rem;">`;

        itemsActivos.forEach((it, idx) => {
          const qty = Number(it.cantidad) || 1;
          const itemId = it.item_pedido_id ?? it.id ?? null;
          const productoId = it.producto_id ?? null;

          for (let q = 0; q < qty; q++) {
            html += `
              <div style="padding:6px 0; border-bottom:1px dashed rgba(148,163,184,0.25);">
                <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
                  <div>
                    <div><strong>${esc(it.producto || 'Activo')}</strong> <span class="muted" style="font-size:0.85rem;">(${q + 1}/${qty})</span></div>
                    <div class="muted" style="font-size:0.8rem;">Seleccioná el equipo a entregar</div>
                  </div>
                  <div style="min-width:240px;">
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
    }

    html += `<hr style="border-color:rgba(148,163,184,0.3); margin:0.6rem 0;">`;

    // 3) Activos vinculados al cliente (retiro/mantenimiento/cambio)
    if (actosCliente.length) {
      html += `<small class="muted">Activos actualmente vinculados a este cliente</small>`;
      html += `<div class="modal-list" style="margin-top:0.4rem;">`;

      html += actosCliente.map(a => `
        <div style="padding:6px 0; border-bottom:1px dashed rgba(148,163,184,0.25);">
          <div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
            <div>
              <div><strong>${esc(a.codigo || a.tipo || '')}</strong></div>
              <div style="font-size:0.8rem; color:var(--muted);">
                ${esc(a.tipo || '')} · Estado: ${esc(a.estado || '')}
                ${a.numero_serie ? ' · N° Serie: ' + esc(a.numero_serie) : ''}
                ${a.alquiler_mensual != null ? ' · Alquiler: ' + money(a.alquiler_mensual) : ''}
              </div>
            </div>

            <div style="min-width:170px;">
              <select data-am-accion="${a.id}" style="width:100%; margin-bottom:4px;">
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
      `).join('');

      html += `</div>`;
    } else {
      html += `<p class="muted" style="margin:0.4rem 0;">No hay activos registrados para este cliente.</p>`;
    }

    // 4) Historial de movimientos ya registrados
    const movimientos = Array.isArray(data.movimientos_existentes) ? data.movimientos_existentes : [];
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

      html += `<hr style="border-color:rgba(148,163,184,0.3); margin:0.6rem 0;">`;
      html += `<small class="muted">Historial de movimientos en este pedido</small>`;
      html += `<div class="modal-list" style="margin-top:0.4rem; max-height:160px; overflow-y:auto;">`;

      html += movimientos.map(m => {
        const tipoTxt   = (m.tipo_operacion || '').toUpperCase();
        const estadoTxt = m.estado || '';
        const obsTxt    = m.observacion || '';
        const fechaTxt  = m.accion_at_utc ? formatFechaHoraAR(m.accion_at_utc) : '';

        const principal   = describeActivo(m.activo_id);
        const relacionado = describeActivo(m.activo_relacionado_id);

        let activosHtml = esc(principal);
        if (m.tipo_operacion === 'cambio' && m.activo_relacionado_id) {
          activosHtml += ' → ' + esc(relacionado);
        }

        const metaLine = [fechaTxt, tipoTxt, estadoTxt].filter(Boolean).join(' · ');

        return `
          <div style="padding:4px 0; border-bottom:1px dashed rgba(148,163,184,0.25);">
            <div style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted);">
              ${esc(metaLine)}
            </div>
            <div style="font-size:0.9rem;">
              ${activosHtml}
            </div>
            ${obsTxt ? `<div style="font-size:0.8rem; color:var(--muted); margin-top:2px;">Nota: ${esc(obsTxt)}</div>` : ''}
          </div>
        `;
      }).join('');

      html += `</div>`;
    }

    c.innerHTML = html;
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
    if (etapa === 'entrega') {
      alert(e?.message || 'No se pudo entregar el pedido.');
    } else {
      alert('No se pudieron cargar los activos de este pedido.');
    }
    activosModalState.pedidoId = null;
    activosModalState.data = null;
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
  activosModalState = { pedidoId: null, data: null };
}

async function confirmarEntregaConActivos() {
  const pid = activosModalState.pedidoId;
  if (!pid) {
    cerrarActivosModal();
    return;
  }

  if (!confirm('¿Confirmás la entrega y los movimientos de activos seleccionados?')) {
    return;
  }

  const movimientos = [];
  let faltaSeleccionNuevo = false;
  let faltaEntregaNuevo = false;

  // 0) NUEVO: ENTREGAS (activos disponibles seleccionados para entregar)
  // 1 select por unidad: data-am-entrega="1" + data-am-item-id + data-am-producto-id
  $$('#activosModal select[data-am-entrega="1"]').forEach(sel => {
    const activoId = Number(sel.value || 0);
    const itemPedidoId = Number(sel.getAttribute('data-am-item-id') || 0) || null;
    const productoId = Number(sel.getAttribute('data-am-producto-id') || 0) || null;

    // Si existe el select, se espera que el repartidor elija un activo
    if (!activoId) {
      faltaEntregaNuevo = true;
      return;
    }

    movimientos.push({
      tipoOperacion: 'entrega',
      activoId,
      itemPedidoId,
      productoId
    });
  });

  if (faltaEntregaNuevo) {
    alert('Faltan activos a entregar: seleccioná un equipo en cada "Elegir activo..."');
    return;
  }

  // 1) Movimientos sobre activos del cliente (retiro / mantenimiento / cambio)
  $$('#activosModal select[data-am-accion]').forEach(sel => {
    const tipo = sel.value;
    const activoViejoId = Number(sel.getAttribute('data-am-accion'));
    if (!tipo || !activoViejoId) return;

    if (tipo === 'retiro' || tipo === 'mantenimiento') {
      movimientos.push({
        tipoOperacion: tipo,
        activoId: activoViejoId
        // motivo: opcional (si después agregás UI: 'reparacion' | 'devolucion')
      });
    } else if (tipo === 'cambio') {
      const nuevoSel = $(`#activosModal select[data-am-nuevo="${activoViejoId}"]`);
      const nuevoId = nuevoSel ? Number(nuevoSel.value) : 0;

      if (!nuevoId) {
        faltaSeleccionNuevo = true;
        return;
      }

      movimientos.push({
        tipoOperacion: 'cambio',
        activoId: nuevoId,                 // entra
        activoRelacionadoId: activoViejoId // sale
        // motivo: opcional
      });
    }
  });

  if (faltaSeleccionNuevo) {
    alert('Seleccionaste "Cambiar por..." pero no elegiste el activo nuevo en al menos un caso.');
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
    $$('[data-retornable-devuelto="1"]').forEach(inp => {
      const productoId = Number(inp.getAttribute('data-producto-id') || 0);
      const devueltos = Number(inp.value || 0);
      if (productoId && Number.isFinite(devueltos) && devueltos >= 0) {
        retornables.push({ producto_id: productoId, devueltos });
      }
    });

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
    cerrarActivosModal();
    await loadPedidos();
  } catch (e) {
    console.error(e);
    alert('Error guardando la entrega y los movimientos de activos.');
  }
}

async function confirmarEntregaScanner() {
  // 1. Capturamos los inputs del modal de escaneo
  const inputsAsignar = document.querySelectorAll('.input-asignar');
  const inputsRetirar = document.querySelectorAll('.input-retirar');
  
  const movimientos = [];
  let error = false;

  // 2. Recorremos cada fila (cada ítem del pedido)
  inputsAsignar.forEach((inp, idx) => {
    const valorAsignar = inp.value.trim();                // ID Nuevo (Entrega)
    const valorRetirar = inputsRetirar[idx].value.trim(); // ID Viejo (Retiro)
    const prodId = parseInt(inp.dataset.prodId, 10);

    // Validación visual: marcar rojo si ambos están vacíos
    if (!valorAsignar && !valorRetirar) {
      inp.style.border = '1px solid red';
      error = true;
    } else {
      inp.style.border = '1px solid var(--border)';
      
      // A. ENTREGA: Si hay un valor en el input de asignar, es una entrega
      if (valorAsignar) {
        movimientos.push({
          tipoOperacion: 'entrega',
          activoId: parseInt(valorAsignar, 10),
          productoId: prodId,
          origen: 'scanner_app'
        });
      }

      // B. RETIRO: Si hay un valor en el input de retirar, es un retiro
      if (valorRetirar) {
        movimientos.push({
          tipoOperacion: 'retiro',
          activoId: parseInt(valorRetirar, 10),
          productoId: prodId,
          observacion: 'Retiro registrado por escáner'
        });
      }
    }
  });

  // 3. Validaciones finales
  if (error) {
    toast('⚠️ Escaneá al menos un equipo (entrega o retiro) por ítem.');
    return;
  }

  if (movimientos.length === 0) {
    toast('⚠️ No hay datos para enviar.');
    return;
  }

  // 4. Enviar al servidor
  const modal = document.getElementById('modalEscanearActivos');
  modal.style.display = 'none';
  
  try {
    // Usamos la variable global pedidoEnProcesoId que seteaste en iniciarProcesoEntrega
    if (!pedidoEnProcesoId) throw new Error('ID de pedido perdido');

    // Igual que en confirmarEntregaConActivos: resolvemos zona (si aplica)
    const zonaId = await resolverZonaParaPedido(pedidoEnProcesoId);

    const geo = await getGeoEntregaIfEnabled();
    const body = {
      movimientos,
      checklist: {
        cliente_confirmado: true,
        producto_entregado: true,
        cobro_confirmado: false,
      },
      evidencia: { geo, ts: new Date().toISOString() },
    };
    if (zonaId != null) body.zona_id = zonaId;

    // Llamada transaccional: entrega + movimientos + stock chofer
    await withLock(`entregar:${pedidoEnProcesoId}`, async () => {
      await api(`/api/repartidor/pedidos/${pedidoEnProcesoId}/entregar`, {
        method: 'POST',
        body
      });
    });

    toast('✅ Entrega registrada (Escáner)');
    pedidoEnProcesoId = null;
    await loadPedidos(); // Recargar la lista

  } catch (e) {
    console.error(e);
    toast('❌ Error: ' + (e.message || 'Error al procesar entrega'));
    // Si falla, volvemos a mostrar el modal
    modal.style.display = 'flex';
  }
}

function cerrarModalEscaneo() {
  const modal = document.getElementById('modalEscanearActivos');
  if (modal) modal.style.display = 'none';
  // Si querés, limpiar los inputs:
  document.querySelectorAll('.input-asignar, .input-retirar').forEach(i => i.value = '');
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
