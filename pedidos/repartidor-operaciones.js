let gSelectedComprobanteFile = null;

function setGastoComprobanteFile(file, source = 'archivo') {
  const input = $('#gFile');
  const hint = $('#gFileHint');
  gSelectedComprobanteFile = file || null;

  if (file && input && window.DataTransfer) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
  }

  if (hint) {
    if (file) {
      const origen = source === 'camara' ? 'Foto tomada' : 'Archivo seleccionado';
      hint.textContent = `${origen}: ${file.name}`;
    } else {
      hint.textContent = 'Podés subir una imagen o sacar una foto.';
    }
  }
}

function clearGastoComprobanteFile() {
  gSelectedComprobanteFile = null;
  if ($('#gFile')) $('#gFile').value = '';
  if ($('#gCameraFile')) $('#gCameraFile').value = '';
  if ($('#gFileHint')) $('#gFileHint').textContent = 'Podés subir una imagen o sacar una foto.';
}

function getGastoComprobanteFile() {
  return gSelectedComprobanteFile || ($('#gFile')?.files && $('#gFile').files[0]) || null;
}

function initRepartidorOperacionesUI() {
  // Gastos Inputs
  $('#gTipo').addEventListener('change', gToggle);
  $('#gCant').addEventListener('input', gCalc);
  $('#gPu').addEventListener('input', gCalc);
  $('#gProducto').addEventListener('change', gAutoPrice);
  $('#gHistFilter')?.addEventListener('change', loadGHist);
  $('#gHistRange')?.addEventListener('change', loadGHist);
  $('#gHistSearch')?.addEventListener('input', debounce(loadGHist, 180));
  $('#gTakePhotoBtn')?.addEventListener('click', () => $('#gCameraFile')?.click());
  $('#gCameraFile')?.addEventListener('change', () => {
    const file = $('#gCameraFile')?.files && $('#gCameraFile').files[0];
    if (file) setGastoComprobanteFile(file, 'camara');
  });
  $('#gFile')?.addEventListener('change', () => {
    const file = $('#gFile')?.files && $('#gFile').files[0];
    setGastoComprobanteFile(file, 'archivo');
    if (file && $('#gCameraFile')) $('#gCameraFile').value = '';
  });

  // --- GASTOS SUBMIT ---
  $('#gForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.submitter || e.target.querySelector('button');
      if(btn) btn.disabled = true;

      try {
          const type = $('#gTipo').value;
          const fecha = $('#gFecha').value;
          const descManual = $('#gDesc').value;
          const file = getGastoComprobanteFile();
          let finalBody = {};

          // Escenario A: Movimientos de Stock Retornable
          if (type === 'carga_llenos' || type === 'descarga_vacios') {
              const pid = $('#gProducto').value;
              const nombreProd = $('#gProducto').options[$('#gProducto').selectedIndex]?.text || '';
              const qty = Number($('#gCant').value);
              const pu = Number($('#gPu').value || 0);
              const montoManual = Number($('#gMonto').value || 0);
              const depositoId = $('#gDeposito')?.value || '';

              if (!pid) throw new Error('Selecciona un producto retornable.');
              if (!qty || qty <= 0) throw new Error('Ingresa cantidad.');

              const isCarga = type === 'carga_llenos';
              if (isCarga && !depositoId) throw new Error('Seleccioná el depósito de carga.');
              const montoFinal = isCarga ? (qty * pu) : montoManual;
              const pref = isCarga ? 'Carga' : 'Descarga';

              finalBody = {
                  fecha: fecha,
                  tipo: type,
                  descripcion: `${pref}: ${qty}u ${nombreProd}. ${descManual}`,
                  monto: montoFinal,
                  cantidad: qty,
                  precio_unitario: pu,
                  producto_id: pid,
                  deposito_id: depositoId || null
              };
          }
          // Escenario B: Gastos comunes (cantidad + precio unitario)
          else {
              const qty = Number($('#gCant').value || 0);
              const pu = Number($('#gPu').value || 0);
              if (!qty || qty <= 0) throw new Error('Ingresa cantidad.');
              if (!pu || pu <= 0) throw new Error('Ingresa precio unitario.');
              const montoDirecto = qty * pu;
              finalBody = {
                  fecha: fecha,
                  tipo: type,
                  descripcion: descManual,
                  monto: montoDirecto,
                  cantidad: qty,
                  precio_unitario: pu
              };
          }

          const formData = new FormData();
          formData.append('fecha', finalBody.fecha);
          formData.append('tipo', finalBody.tipo);
          formData.append('descripcion', finalBody.descripcion);
          formData.append('monto', String(finalBody.monto));
          
          // Agregar campos opcionales al FormData
          if(finalBody.cantidad) formData.append('cantidad', String(finalBody.cantidad));
          if(finalBody.producto_id) formData.append('producto_id', String(finalBody.producto_id));
          if(finalBody.deposito_id) formData.append('deposito_id', String(finalBody.deposito_id));
          if (me?.chofer_id) formData.append('chofer_id', String(me.chofer_id));
          
          if(file) formData.append('comprobante', file);
          
          await withLock('gastos:submit', async () => {
            await api('/api/gastos', { method: 'POST', body: formData });
          });

          toast('✅ Registro guardado');
          gInit(); 

      } catch (err) {
          notifyError(err?.message || 'Error guardando gasto', err);
      } finally {
          if(btn) btn.disabled = false;
      }
  });

  // Transferencias & Resumen
  $('#tfDate').onchange = loadTransf; $('#tfFilter').onchange = loadTransf;
  $('#resDate').onchange = calcResumen;
  $('#stDate').onchange = loadStockRepartidor;


}

async function gLoadProductos() {
  try {
    const ps = await api('/api/productos');
    const retornables = (Array.isArray(ps) ? ps : []).filter(p => !!p?.retornable);
    const emptyLabel = retornables.length ? 'Seleccionar producto retornable.' : 'Sin productos retornables configurados.';
    $('#gProducto').innerHTML = `<option value="">${emptyLabel}</option>` + retornables.map(p => `<option value="${Number(p.id)}">#${Number(p.id)} · ${esc(p.nombre)}</option>`).join('');
  } catch {}
}

async function gLoadDepositos() {
  try {
    const ds = await api('/api/stock/depositos');
    depositos = Array.isArray(ds) ? ds : [];
    const sel = $('#gDeposito');
    if (!sel) return;
    const emptyLabel = depositos.length ? 'Seleccionar depósito' : 'Sin depósitos activos';
    sel.innerHTML = `<option value="">${emptyLabel}</option>` + depositos.map(d => `<option value="${Number(d.id)}">${esc(d.nombre)}</option>`).join('');
  } catch {
    depositos = [];
  }
}

function gInit(){
  $('#gForm').reset();
  clearGastoComprobanteFile();
  $('#gFecha').value = getOyString();
  if($('#gHistFilter')) $('#gHistFilter').value='all';
  if($('#gHistRange')) $('#gHistRange').value='30';
  if($('#gHistSearch')) $('#gHistSearch').value='';
  gToggle();
  loadGHist();
}

function gToggle(){
  const t = $('#gTipo').value;
  const isStock = t === 'carga_llenos' || t === 'descarga_vacios';
  const isCarga = t === 'carga_llenos';
  const isGastoComun = ['combustible', 'insumos', 'varios'].includes(t);

  $('#gProdRow').hidden = !isStock;
  $('#gDepRow').hidden = !isCarga;

  // Cálculo por cantidad/precio para stock y gastos comunes
  $('#gCalcRow').hidden = !(isStock || isGastoComun);
  $('#gPuBox').hidden = false;

  // Monto editable solo para descarga_vacios; en carga/gasto común lo calcula cantidad*PU
  $('#gMontoRow').hidden = false;
  const montoEl = $('#gMonto');
  if (montoEl) {
    montoEl.readOnly = (isCarga || isGastoComun);
    if (isCarga || isGastoComun) gCalc();
  }
}

function gAutoPrice() {
  const pid = $('#gProducto').value;
  if (pid && myCosts[pid]) { $('#gPu').value = myCosts[pid]; gCalc(); toast(`Costo cargado: $${myCosts[pid]}`); }
}

function gCalc(){
  const q = Number($('#gCant').value)||0;
  const p = Number($('#gPu').value)||0;
  const total = q * p;
  $('#gTotalCalc').value = '$ ' + total.toFixed(2);

  const t = $('#gTipo')?.value;
  const isCarga = t === 'carga_llenos';
  const isGastoComun = ['combustible', 'insumos', 'varios'].includes(t);
  if (isCarga || isGastoComun) {
    $('#gMonto').value = total ? total.toFixed(2) : '';
  }
}

async function loadGHist(){
  try {
    const choferId = Number(me?.chofer_id || 0);
    if (!choferId) {
      $('#gList').innerHTML = '<tr><td colspan="6" class="muted">No se pudo identificar tu chofer (chofer_id).</td></tr>';
      return;
    }
    const gs = await api('/api/gastos');
    const mode = $('#gHistFilter')?.value || 'all';
    const search = String($('#gHistSearch')?.value || '').trim().toLowerCase();
    const allRows = (Array.isArray(gs) ? gs : (gs.rows || []))
      .sort((a,b) => new Date(b.fecha) - new Date(a.fecha));

    // Rango configurable (7/30/90 días o todo)
    const rangeVal = String($('#gHistRange')?.value || '30');
    let cutoff = null;
    if (rangeVal !== 'all') {
      const days = Number(rangeVal);
      if (Number.isFinite(days) && days > 0) {
        cutoff = new Date();
        cutoff.setHours(0, 0, 0, 0);
        cutoff.setDate(cutoff.getDate() - (days - 1));
      }
    }

    const arr = allRows.filter(g => {
      const tipo = String(g?.tipo || '').toLowerCase();
      const isMercaderia = tipo === 'carga_llenos' || tipo === 'descarga_vacios';
      const f = new Date(g?.fecha);
      if (Number.isNaN(f.getTime())) return false;
      if (cutoff && f < cutoff) return false;
      if (mode === 'mercaderia' && !isMercaderia) return false;
      if (mode === 'gastos' && isMercaderia) return false;

      if (search) {
        const qty = Number(g?.cantidad || 0);
        const monto = Number(g?.monto || 0);
        const productoTxt = g?.producto_id ? getProductoNombreById(g.producto_id) : '';
        const haystack = [
          tipo,
          g?.descripcion || '',
          productoTxt,
          formatFechaAR(g.fecha),
          String(monto),
          String(qty)
        ].join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }

      return true;
    }).slice(0, 30);

    window.__gHist = arr;

    if (!arr.length) {
      $('#gList').innerHTML = '<tr><td colspan="6" class="muted">Sin movimientos para el rango/filtro/búsqueda seleccionado</td></tr>';
      return;
    }

    // CORRECCIÓN HORA ARGENTINA: Mostrar DD/MM usando la zona horaria correcta
    $('#gList').innerHTML = arr.map(g => {
      const tipo = String(g?.tipo || '').toLowerCase();
      const isMercaderia = tipo === 'carga_llenos' || tipo === 'descarga_vacios';
      const qty = Number(g?.cantidad || 0);
      const productoTxt = g?.producto_id ? getProductoNombreById(g.producto_id) : '';
      const detalleMerc = isMercaderia
        ? `${tipo === 'carga_llenos' ? 'Carga' : 'Descarga'}${qty > 0 ? `: ${qty}u` : ''}${productoTxt ? ` · ${productoTxt}` : ''}`
        : '';
      const detalle = [detalleMerc, g?.descripcion].filter(Boolean).join(' · ');
      const montoOCant = isMercaderia
        ? `${qty > 0 ? `${qty}u` : '-'}${Number(g?.monto || 0) > 0 ? ` • ${money(g.monto)}` : ''}`
        : money(g?.monto);

      const depositoTxt = g?.deposito_nombre || (g?.deposito_id ? `#${Number(g.deposito_id)}` : '-');
      const acciones = `<div style="display:flex; gap:6px; justify-content:flex-end;">
        <button class="iconbtn ghost" style="padding:4px 8px" onclick="gEdit(${Number(g.id)})">✏️</button>
        <button class="iconbtn ghost" style="padding:4px 8px; color:var(--danger)" onclick="gDel(${Number(g.id)})">🗑️</button>
      </div>`;
      return `<tr><td>${formatFechaAR(g.fecha)}</td><td>${esc(g.tipo)}</td><td>${esc(detalle || '-')}</td><td>${esc(depositoTxt)}</td><td>${montoOCant}</td><td>${acciones}</td></tr>`;
    }).join('');
  } catch (e) {
    console.error('Error cargando historial de gastos del repartidor', e);
    const msg = e?.status === 402
      ? 'Tu licencia está vencida y no se puede consultar el historial.'
      : (e?.message || 'No se pudo cargar el historial.');
    $('#gList').innerHTML = `<tr><td colspan="6" class="muted">${esc(msg)}</td></tr>`;
    notifyError(msg, e);
  }
}

function calcMegTotal() {
  const q = Number($('#megCant')?.value || 0);
  const pu = Number($('#megPu')?.value || 0);
  const total = q * pu;
  if ($('#megMonto')) $('#megMonto').value = total ? total.toFixed(2) : '';
}

function abrirModalEditarGasto(row) {
  gastoEditRow = row;
  const tipo = String(row?.tipo || '').toLowerCase();
  const isMerc = ['carga_llenos', 'descarga_vacios'].includes(tipo);
  const isCarga = tipo === 'carga_llenos';
  const isGastoComun = ['combustible', 'insumos', 'varios'].includes(tipo);

  $('#megId').value = String(row.id || '');
  $('#megTipo').value = row.tipo || '-';
  $('#megFecha').value = formatFechaAR(row.fecha);
  $('#megDesc').value = row.descripcion || '';
  $('#megMeta').textContent = `#${Number(row.id)} · ${row.chofer_nombre || 'Chofer'}`;

  $('#megRowCant').hidden = !(isMerc || isGastoComun);
  $('#megRowMonto').hidden = false;
  $('#megRowDeposito').hidden = !isCarga;

  const cantidad = Number(row.cantidad || 0);
  const monto = Number(row.monto || 0);
  const pu = (cantidad > 0) ? (monto / cantidad) : 0;

  $('#megCant').value = (isMerc || isGastoComun) ? (cantidad || '') : '';
  $('#megPu').value = (isMerc || isGastoComun) ? (pu ? pu.toFixed(2) : '') : '';
  $('#megMonto').value = monto || '';

  // Para gastos comunes, el monto se calcula por cantidad*PU
  if (isGastoComun) {
    $('#megMonto').readOnly = true;
    calcMegTotal();
  } else {
    $('#megMonto').readOnly = false;
  }

  const depSel = $('#megDeposito');
  depSel.innerHTML = `<option value="">Sin depósito</option>` + (depositos || []).map(d => `<option value="${Number(d.id)}">${esc(d.nombre)}</option>`).join('');
  depSel.value = row?.deposito_id ? String(Number(row.deposito_id)) : '';

  $('#modalEditarGasto').hidden = false;
}

window.cerrarModalEditarGasto = function() {
  gastoEditRow = null;
  const form = $('#megForm');
  if (form) form.reset();
  $('#modalEditarGasto').hidden = true;
};

window.gEdit = async function(id) {
  try {
    const row = (window.__gHist || []).find(x => Number(x.id) === Number(id));
    if (!row) return toast('No encontré el movimiento.');
    abrirModalEditarGasto(row);
  } catch (e) {
    notifyError(e?.message || 'No se pudo abrir edición', e);
  }
};

$('#megCant')?.addEventListener('input', () => {
  const tipo = String(gastoEditRow?.tipo || '').toLowerCase();
  if (['combustible', 'insumos', 'varios'].includes(tipo)) calcMegTotal();
});
$('#megPu')?.addEventListener('input', () => {
  const tipo = String(gastoEditRow?.tipo || '').toLowerCase();
  if (['combustible', 'insumos', 'varios'].includes(tipo)) calcMegTotal();
});

$('#megForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const row = gastoEditRow;
    if (!row) return;

    const id = Number($('#megId').value || row.id);
    const tipo = String(row?.tipo || '').toLowerCase();
    const isMerc = ['carga_llenos', 'descarga_vacios'].includes(tipo);
    const isCarga = tipo === 'carga_llenos';
    const isGastoComun = ['combustible', 'insumos', 'varios'].includes(tipo);

    const fm = new FormData();
    fm.append('descripcion', String($('#megDesc').value || '').trim());

    if (isMerc || isGastoComun) {
      const cant = Number($('#megCant').value || 0);
      if (!cant || cant <= 0) return toast('Cantidad inválida.');
      fm.append('cantidad', String(cant));

      let monto = Number($('#megMonto').value || 0);
      if (isGastoComun) {
        const pu = Number($('#megPu').value || 0);
        if (!pu || pu <= 0) return toast('Precio unitario inválido.');
        monto = cant * pu;
        fm.append('monto', String(monto));
      } else {
        if (!Number.isFinite(monto) || monto < 0) return toast('Monto inválido.');
        fm.append('monto', String(monto));
      }

      if (isCarga) {
        const dep = $('#megDeposito').value;
        if (dep) fm.append('deposito_id', String(dep));
      }
    } else {
      const monto = Number($('#megMonto').value || 0);
      if (!Number.isFinite(monto) || monto <= 0) return toast('Monto inválido.');
      fm.append('monto', String(monto));
    }

    await api(`/api/gastos/${id}`, { method: 'PUT', body: fm });
    toast('✅ Movimiento actualizado');
    cerrarModalEditarGasto();
    await loadGHist();
  } catch (e2) {
    notifyError(e2?.message || 'No se pudo actualizar el movimiento', e2);
  }
});

window.gDel = async function(id) {
  try {
    if (!confirm('¿Eliminar este movimiento?')) return;
    await api(`/api/gastos/${Number(id)}`, { method: 'DELETE' });
    toast('🗑️ Movimiento eliminado');
    await loadGHist();
  } catch (e) {
    notifyError(e?.message || 'No se pudo eliminar el movimiento', e);
  }
};

// --- STOCK REPARTIDOR (cargas vs entregas) ---
function getProductoNombreById(id) {
  const opt = document.querySelector(`#gProducto option[value="${Number(id)}"]`);
  return opt?.textContent?.trim() || `Producto #${Number(id)}`;
}

async function loadStockRepartidor(){
  const d = $('#stDate')?.value || getOyString();
  const tbody = $('#stList');
  if (!tbody) return;

  try {
    const res = await api(`/api/repartidor/stock-acumulado?fecha=${encodeURIComponent(d)}`);
    const rows = Array.isArray(res?.rows) ? res.rows : [];
    const k = res?.kpis || {};

    const sumInicial = Number(k.saldo_inicial || 0);
    const sumCarga = Number(k.cargado || 0);
    const sumEnt = Number(k.entregado || 0);
    const sumSaldo = Number(k.saldo_final || 0);

    $('#stKpiInicial').textContent = `${sumInicial} u`;
    $('#stKpiCarga').textContent = `${sumCarga} u`;
    $('#stKpiEntregado').textContent = `${sumEnt} u`;
    $('#stKpiSaldo').textContent = `${sumSaldo} u`;

    const colorSaldo = sumSaldo >= 0 ? 'var(--brand)' : 'var(--danger)';
    const colorInicial = sumInicial >= 0 ? '#e5e7eb' : '#fca5a5';
    $('#stKpiInicial').style.color = colorInicial;
    $('#stKpiSaldo').style.color = colorSaldo;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">Sin movimientos para esta fecha</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const saldoInicial = Number(r.saldo_inicial || 0);
      const cargado = Number(r.cargado || 0);
      const entregado = Number(r.entregado || 0);
      const saldoFinal = Number(r.saldo_final || 0);
      return `
        <tr>
          <td>${esc(r.nombre || getProductoNombreById(r.producto_id))}</td>
          <td style="color:${saldoInicial >= 0 ? '#cbd5e1' : '#fca5a5'}">${saldoInicial}</td>
          <td>${cargado}</td>
          <td>${entregado}</td>
          <td style="font-weight:700; color:${saldoFinal >= 0 ? '#67e8f9' : '#fca5a5'}">${saldoFinal}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.error('Error loadStockRepartidor', e);
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Error cargando stock</td></tr>';
  }
}

// --- RESUMEN ---
function formatRetornableQty(qty) {
  const n = Number(qty || 0);
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

function getPedidoFechaResumen(pedido) {
  const estado = String(pedido?.estado || '').toLowerCase();
  if (estado === 'entregado' || estado === 'cancelado') {
    return isoToLocalYMD(pedido?.fecha_entrega || pedido?.fecha) || dbDateToYMD(pedido?.fecha_entrega_estimada);
  }
  return getPedidoFechaOperativa(pedido);
}

function buildRetornablesRutaResumen(fecha) {
  const byProduct = new Map();
  const byClient = new Map();
  let total = 0;

  (Array.isArray(pedidos) ? pedidos : [])
    .filter((pedido) => isPedidoActivoCarga(pedido) && getPedidoFechaResumen(pedido) === fecha)
    .forEach((pedido) => {
      const rows = getRetornablesPendientes(pedido);
      if (!rows.length) return;

      const clientKey = Number(pedido?.punto_entrega_id || 0) || `pedido:${pedido?.id || ''}`;
      const client = byClient.get(clientKey) || {
        cliente: pedido?.cliente || 'Cliente',
        direccion: pedido?.direccion || '',
        pedido_id: pedido?.id || null,
        total: 0,
        items: [],
      };

      rows.forEach((row) => {
        const saldo = Number(row?.saldo || 0);
        if (!Number.isFinite(saldo) || saldo <= 0) return;

        const producto = row?.producto || 'Retornable';
        const productKey = row?.producto_id ? `id:${Number(row.producto_id)}` : `name:${String(producto).toLowerCase()}`;
        const product = byProduct.get(productKey) || { producto, total: 0, clientes: 0 };
        product.total += saldo;
        product.clientes += 1;
        byProduct.set(productKey, product);

        client.total += saldo;
        client.items.push({ producto, saldo });
        total += saldo;
      });

      if (client.total > 0) byClient.set(clientKey, client);
    });

  return {
    total,
    productos: Array.from(byProduct.values()).sort((a, b) => b.total - a.total || a.producto.localeCompare(b.producto, 'es')),
    clientes: Array.from(byClient.values()).sort((a, b) => b.total - a.total || a.cliente.localeCompare(b.cliente, 'es')),
  };
}

function renderResumenRetornables(fecha) {
  const resumen = buildRetornablesRutaResumen(fecha);
  const productosEl = $('#retProductosList');
  const clientesEl = $('#retClientesList');
  const totalEl = $('#retKpiUnidades');
  const clientesKpiEl = $('#retKpiClientes');
  const productosKpiEl = $('#retKpiProductos');
  const metaEl = $('#retResumenMeta');

  if (totalEl) totalEl.textContent = `${formatRetornableQty(resumen.total)} u`;
  if (clientesKpiEl) clientesKpiEl.textContent = String(resumen.clientes.length);
  if (productosKpiEl) productosKpiEl.textContent = String(resumen.productos.length);
  if (metaEl) {
    metaEl.textContent = resumen.total
      ? 'Saldos pendientes de clientes con pedidos activos para la fecha seleccionada.'
      : 'Sin saldos pendientes en pedidos activos de la fecha seleccionada.';
  }

  if (productosEl) {
    if (!resumen.productos.length) {
      productosEl.className = 'retornables-list load-empty';
      productosEl.textContent = 'Sin retornables pendientes.';
    } else {
      productosEl.className = 'retornables-list';
      productosEl.innerHTML = resumen.productos.map((r) => `
        <div class="retornables-row">
          <span>${esc(r.producto)}<small>${r.clientes} ${r.clientes === 1 ? 'cliente' : 'clientes'}</small></span>
          <strong>${formatRetornableQty(r.total)} u</strong>
        </div>
      `).join('');
    }
  }

  if (clientesEl) {
    if (!resumen.clientes.length) {
      clientesEl.className = 'retornables-list load-empty';
      clientesEl.textContent = 'Sin clientes con saldo.';
    } else {
      clientesEl.className = 'retornables-list';
      clientesEl.innerHTML = resumen.clientes.slice(0, 12).map((r) => {
        const detalle = r.items.map((item) => `${formatRetornableQty(item.saldo)} ${item.producto}`).join(' · ');
        return `
          <div class="retornables-row">
            <span>${esc(r.cliente)}${r.pedido_id ? ` <small>Pedido #${Number(r.pedido_id)} · ${esc(r.direccion || '-')}</small>` : ''}<small>${esc(detalle)}</small></span>
            <strong>${formatRetornableQty(r.total)} u</strong>
          </div>
        `;
      }).join('');
    }
  }

  return resumen;
}

async function refrescarResumenRetornables() {
  await loadPedidos();
  await calcResumen();
  toast('Resumen actualizado');
}

async function calcResumen(){
  const resDateEl = $('#resDate');
  const d = resDateEl?.value;
  if (!d) return;

  const today = getOyString();
  const last30 = new Date();
  last30.setDate(last30.getDate() - 29);
  const last30Ymd = last30.toISOString().slice(0, 10);

  if (resDateEl) {
    resDateEl.max = today;
    resDateEl.min = last30Ymd;
  }

  if (d < last30Ymd || d > today) {
    toast('Podés consultar solo tus últimos 30 días');
    if (resDateEl) {
      resDateEl.value = d > today ? today : last30Ymd;
    }
    return calcResumen();
  }

  const list = pedidos.filter(p => getPedidoFechaResumen(p) === d && p.estado === 'entregado');

  let cash = 0, transf = 0, ctaCte = 0, artsV = 0;
  let cntCash = 0, cntTransf = 0, cntCtaCte = 0;

  list.forEach(p => { 
    const metodo = (p.metodo_pago || '').toLowerCase();
    if (metodo.includes('trans')) {
        transf += Number(p.monto);
        cntTransf++;
    } else if (metodo === 'cuenta_corriente' || metodo.startsWith('cta')) {
        ctaCte += Number(p.monto);
        cntCtaCte++;
    } else {
        cash += Number(p.monto); 
        cntCash++;
    }
    // CORRECCIÓN AQUÍ: No usamos p.cantidad del header, calculamos abajo
  });

  const prodMap = {};
  list.forEach(p => {
    const items = Array.isArray(p.items) ? p.items : [];
    items.forEach(it => {
      if (!it) return;
      const nombre = it.producto || it.nombre || 'Producto';
      const q = Number(it.cantidad || 0);
      if (!q) return;
      if (!prodMap[nombre]) prodMap[nombre] = 0;
      prodMap[nombre] += q;
      
      // SUMAMOS AL TOTAL GENERAL AQUÍ
      artsV += q; 
    });
  });

  const detalleArt = Object.keys(prodMap).length ? Object.entries(prodMap).map(([nombre, q]) => `• ${q} u. ${nombre}`).join('\n') : '• (sin detalle)';
  const retResumen = renderResumenRetornables(d);
  const detalleRetornablesProducto = retResumen.productos.length
    ? retResumen.productos.map((r) => `• ${formatRetornableQty(r.total)} u. ${r.producto} (${r.clientes} ${r.clientes === 1 ? 'cliente' : 'clientes'})`).join('\n')
    : '• Sin retornables pendientes en pedidos activos.';
  const detalleRetornablesCliente = retResumen.clientes.length
    ? retResumen.clientes.slice(0, 8).map((r) => `• ${r.cliente}: ${r.items.map((item) => `${formatRetornableQty(item.saldo)} ${item.producto}`).join(' · ')}`).join('\n')
    : '';

  let gas = 0, artsC = 0;
  let detalleGastos = '', detalleCarga = '';
  
  try { 
    const gs = await api(`/api/gastos?from=${d}&to=${d}&chofer_id=${me?.chofer_id||''}`); 
    const arr = Array.isArray(gs) ? gs : (gs.rows || []);
    arr.forEach(g => {
      const tipo = (g.tipo||'').toLowerCase();
      const m = Number(g.monto||0);
      gas += m;
      
      if (tipo.includes('carga_llenos') || tipo.includes('carga_vacios')) {
        artsC += Number(g.cantidad || 0);
        const dep = g?.deposito_nombre || (g?.deposito_id ? `Depósito #${Number(g.deposito_id)}` : 'Sin depósito');
        detalleCarga += `• ${g.cantidad||0} u. ${g.descripcion||g.tipo} (${dep}) ($${m})\n`;
      } else { 
        detalleGastos += `• ${g.descripcion||g.tipo}: $${m}\n`; 
      }
    });
  } catch(e){ console.error(e); }

  let pagoChofer = 0;
  try { const pago = await api(`/api/repartidor/pago-dia?fecha=${d}`); pagoChofer = Number(pago?.monto || pago?.pago || 0); } catch(e){ console.error(e); }

  const aRendir = cash - gas - pagoChofer;

  $('#rEnt').textContent = list.length; 
  $('#rCash').textContent = money(cash);
  $('#rTrans').textContent = money(transf); 
  $('#rCtaCte').textContent = money(ctaCte);
  $('#rGastos').textContent = money(gas);
  $('#rRendir').textContent = money(aRendir);

  const dNice = d.split('-').reverse().join('/');
  
  const txt = `📅 *RESUMEN DEL DÍA* ${dNice}\n
📦 *OPERATORIA*
• Entregados: ${list.length}
• Efectivo: ${cntCash} ped. (${money(cash)})
• Transf.:  ${cntTransf} ped. (${money(transf)})
• Cta. Cte.: ${cntCtaCte} ped. (${money(ctaCte)})
----------------
📈 *Venta Total:* ${money(cash + transf + ctaCte)}

🧾 *MERCADERÍA*
🔢 Tot. Artículos: ${artsV} u.
${detalleArt}

♻️ *RETORNABLES A RETIRAR*
Total pendiente: ${formatRetornableQty(retResumen.total)} u.
${detalleRetornablesProducto}
${detalleRetornablesCliente ? '\nClientes:\n' + detalleRetornablesCliente : ''}

💸 *MOVIMIENTOS DE CAJA*
+ Ingreso Efvo: ${money(cash)}
- Cta. Cte. no rendida: ${money(ctaCte)}
- Gastos/Compras: ${money(gas)}
- Retiro/Comisión: ${money(pagoChofer)}
================
💰 *EFECTIVO A RENDIR: ${money(aRendir)}*

📝 *DETALLE GASTOS*
${detalleGastos || '(Ninguno)'}
${detalleCarga ? '\n📦 *REPOSICIONES*\n' + detalleCarga : ''}`;

  $('#resText').value = txt;
}

function copyRes(){ navigator.clipboard.writeText($('#resText').value).then(()=>toast('Copiado!')); }

// --- TRANSF ---
async function loadTransf(){
  const d = $('#tfDate').value, st = $('#tfFilter').value;
  try {
      let q = `/api/transferencias?fecha=${d}`; 
      if(st) q += `&estado=${st}`;
      
      const res = await api(q);
      const lista = res.rows || res;

      $('#tfList').innerHTML = lista.map(t => {
        const pedidoId = Number(t.pedido_id);
        const hasPedido = Number.isFinite(pedidoId) && pedidoId > 0;

        return `
        <tr>
          <td>#${hasPedido ? pedidoId : '-'}</td>
          <td>${esc(t.cliente)}</td>
          <td><b>${money(t.monto)}</b></td>
          <td style="text-align:center">
            ${hasPedido
              ? `<input type="checkbox" 
                        style="transform: scale(1.5); cursor: pointer;" 
                        ${t.validado ? 'checked' : ''} 
                        onchange="togglePagoRepartidor(${pedidoId}, this)">`
              : (t.validado ? '✅' : '⏳') // Si no tiene pedido asociado, mostramos solo estado
            }
          </td>
        </tr>
      `;
      }).join('');
  } catch(e) { console.error(e); }
}

async function loadEvidenciasEntrega(){
  try {
    const from = document.getElementById('evDateFrom')?.value || '';
    const to = document.getElementById('evDateTo')?.value || '';
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);

    const data = await api(`/api/repartidor/entregas-evidencias?${qs.toString()}`);
    const rows = Array.isArray(data?.items) ? data.items : [];

    const tbody = document.getElementById('evList');
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">Sin evidencias registradas</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r) => {
      const chk = r.checklist || {};
      const ev = r.evidencia || {};
      const checklistTxt = [
        chk.cliente_confirmado ? '👤' : '—',
        chk.producto_entregado ? '📦' : '—',
        chk.cobro_confirmado ? '💵' : '—',
      ].join(' ');

      const evTxt = [
        ev.foto_data_url ? '📷' : '',
        ev.firma_data_url ? '✍️' : '',
        ev.geo?.lat ? '📍' : '',
      ].filter(Boolean).join(' ') || '-';

      const fecha = r.updated_at ? new Date(r.updated_at).toLocaleString('es-AR') : '-';
      return `
        <tr>
          <td>${fecha}</td>
          <td>#${Number(r.pedido_id || 0)}</td>
          <td>${esc(r.cliente || '-')}</td>
          <td>${checklistTxt}</td>
          <td>${evTxt}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.error(e);
    const tbody = document.getElementById('evList');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="muted">Error cargando evidencias</td></tr>';
  }
}

async function togglePagoRepartidor(pedidoId, checkbox) {
  if (!confirm(checkbox.checked ? '¿Validar este pago?' : '¿Anular validación?')) {
    checkbox.checked = !checkbox.checked;
    return;
  }

  const marcado = checkbox.checked;
  checkbox.disabled = true;

  try {
    await withLock(`pago:${pedidoId}`, async () => {
      const res = await api(`/api/pedidos/${pedidoId}/toggle-pago`, {
        method: 'POST',
        body: { marcado }
      });

      if (res && res.ok) {
        toast(marcado ? '✅ Transferencia validada' : '↩️ Validación anulada');
        // si tenés alguna función para refrescar resumen/caja, llamala acá
        // loadCaja?.();
      } else {
        throw new Error(res?.error || 'Error al guardar');
      }
    });
  } catch (e) {
    console.error(e);
    notifyError(e?.message || 'Error al actualizar pago', e);
    checkbox.checked = !marcado;
  } finally {
    checkbox.disabled = false;
  }
}
