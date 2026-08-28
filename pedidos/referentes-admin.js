const $ = (s) => document.querySelector(s);
    const money = new Intl.NumberFormat('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 });
    const dateFmt = new Intl.DateTimeFormat('es-AR', { day:'2-digit', month:'2-digit', year:'2-digit' });
    const state = { user:null, isSuper:false, referentes:[], productos:[], productosAsignados:new Map(), comisiones:[], clientesPropuestos:[], clientesVinculados:[], resumen:null, liquidaciones:[], comisionesSeleccionadas:new Set() };

    function currentPage() {
      return document.body.dataset.adminPage || 'dashboard';
    }

    function toast(msg) {
      const t = $('#toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2600);
    }

    function esc(v) {
      return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    }

    function authFetch(url, opts = {}) {
      const headers = { 'Content-Type':'application/json', ...(opts.headers || {}) };
      return fetch(url, { ...opts, headers, credentials:'include' });
    }

    function empresaQS() {
      const id = $('#empSel')?.value;
      return state.isSuper && id ? `?empresa_id=${encodeURIComponent(id)}` : '';
    }

    function comisionesQS() {
      const params = new URLSearchParams();
      const empresaId = $('#empSel')?.value;
      const desde = $('#fComisionDesde')?.value;
      const hasta = $('#fComisionHasta')?.value;
      if (state.isSuper && empresaId) params.set('empresa_id', empresaId);
      if (desde) params.set('from', desde);
      if (hasta) params.set('to', hasta);
      const qs = params.toString();
      return qs ? `?${qs}` : '';
    }

    function superSinEmpresa() {
      return state.isSuper && !$('#empSel')?.value;
    }

    function empresaSeleccionadaNombre() {
      const sel = $('#empSel');
      return sel?.selectedOptions?.[0]?.textContent?.trim() || '';
    }

    function emptyRow(colspan, msg, detail = '') {
      const extra = detail ? `<div class="muted" style="margin-top:.35rem">${esc(detail)}</div>` : '';
      return `<tr><td colspan="${Number(colspan)}" style="text-align:center;padding:2rem;color:var(--muted)"><strong style="color:#fff">${esc(msg)}</strong>${extra}</td></tr>`;
    }

    function setMetric(id, label, value) {
      const strong = $(id);
      if (!strong) return;
      const labelEl = strong.previousElementSibling;
      if (labelEl) labelEl.textContent = label;
      strong.textContent = value;
    }

    function renderCompanyContext() {
      const ctx = $('#companyContext');
      if (!ctx) return;
      const needsEmpresa = superSinEmpresa();
      if (!state.isSuper) {
        ctx.hidden = true;
        $('#btnNuevo').disabled = false;
        $('#btnLiquidarSeleccion').disabled = false;
        return;
      }
      ctx.hidden = false;
      ctx.classList.toggle('warn', needsEmpresa);
      $('#companyContextText').textContent = needsEmpresa
        ? 'Selecciona una empresa para cargar datos, crear referentes, validar clientes y liquidar comisiones.'
        : `Operando sobre ${empresaSeleccionadaNombre()}. Los listados, clientes y comisiones quedan filtrados por empresa.`;
      $('#btnNuevo').disabled = needsEmpresa;
      $('#btnLiquidarSeleccion').disabled = needsEmpresa;
    }

    async function api(url, opts = {}) {
      const res = await authFetch(url, opts);
      if (res.status === 401) {
        location.href = 'login.html';
        return null;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Error de API');
      return data;
    }

    function normalizeCode(value) {
      return String(value || '').trim().toUpperCase().replace(/\s+/g, '-');
    }

    function validUntilLabel(r) {
      const desde = r.vigente_desde ? dateFmt.format(new Date(r.vigente_desde)) : 'sin inicio';
      const hasta = r.vigente_hasta ? dateFmt.format(new Date(r.vigente_hasta)) : 'sin cierre';
      return `${desde} / ${hasta}`;
    }

    function renderSummary() {
      renderCompanyContext();
      const activos = state.referentes.filter((r) => r.activo).length;
      const clientes = state.referentes.reduce((a, r) => a + Number(r.clientes_count || 0), 0);
      const productos = state.referentes.reduce((a, r) => a + Number(r.productos_count || 0), 0);
      const propuestos = state.clientesPropuestos.filter((c) => c.estado === 'pendiente').length;
      const pendientes = state.referentes.reduce((a, r) => a + Number(r.comisiones_pendientes || 0), 0);
      const liquidadas = state.referentes.reduce((a, r) => a + Number(r.comisiones_liquidadas || 0), 0);
      if ($('#dRefs')) $('#dRefs').textContent = `${activos} activos`;
      if ($('#dClientes')) $('#dClientes').textContent = `${clientes} vinculados`;
      if ($('#dPendientes')) $('#dPendientes').textContent = `${money.format(pendientes)} pendiente`;

      if (currentPage() === 'comisiones') {
        const rows = getComisionesFiltradas();
        const rowsPendientes = rows.filter((c) => c.estado === 'validada');
        const rowsLiquidadas = rows.filter((c) => c.estado === 'liquidada');
        const selectedRows = getComisionesPendientes([...state.comisionesSeleccionadas]);
        const montoPendiente = rowsPendientes.reduce((acc, c) => acc + Number(c.monto_comision || 0), 0);
        const montoSeleccionado = selectedRows.reduce((acc, c) => acc + Number(c.monto_comision || 0), 0);
        const montoLiquidado = rowsLiquidadas.reduce((acc, c) => acc + Number(c.monto_comision || 0), 0);
        const desde = $('#fComisionDesde')?.value;
        const hasta = $('#fComisionHasta')?.value;
        const periodo = desde || hasta ? [desde || 'inicio', hasta || 'hoy'].join(' / ') : 'Todo';
        setMetric('#mActivos', 'Pendientes', rowsPendientes.length);
        setMetric('#mClientes', 'Monto pendiente', money.format(montoPendiente));
        setMetric('#mProductos', 'Seleccionadas', selectedRows.length);
        setMetric('#mPropuestos', 'Monto seleccionado', money.format(montoSeleccionado));
        setMetric('#mPendientes', 'Liquidado filtrado', money.format(montoLiquidado));
        setMetric('#mLiquidadas', 'Periodo', periodo);
        renderControlOperativo();
        return;
      }

      setMetric('#mActivos', 'Referentes activos', activos);
      setMetric('#mClientes', 'Clientes asociados', clientes);
      setMetric('#mProductos', 'Productos asociados', productos);
      setMetric('#mPropuestos', 'Clientes a validar', propuestos);
      setMetric('#mPendientes', 'Pendiente a liquidar', money.format(pendientes));
      setMetric('#mLiquidadas', 'Liquidado', money.format(liquidadas));
      renderControlOperativo();
    }

    function renderControlOperativo() {
      const alertas = $('#referentesAlertas');
      const auditoria = $('#referentesAuditoria');
      if (!alertas || !auditoria) return;
      if (superSinEmpresa()) {
        alertas.innerHTML = '<div class="muted">Selecciona una empresa para ver alertas operativas.</div>';
        auditoria.innerHTML = '<div class="muted">Sin empresa seleccionada.</div>';
        return;
      }
      const r = state.resumen || {};
      const items = [
        {
          label: 'Comisiones pendientes',
          value: money.format(Number(r.comisiones_pendientes_total || 0)),
          detail: `${Number(r.comisiones_pendientes_count || 0)} comisión/es esperando liquidación`,
          tone: Number(r.comisiones_pendientes_count || 0) ? 'warn' : 'ok',
        },
        {
          label: 'Clientes a validar',
          value: Number(r.clientes_pendientes || 0),
          detail: 'prospectos cargados por referentes',
          tone: Number(r.clientes_pendientes || 0) ? 'warn' : 'ok',
        },
        {
          label: 'Referentes sin acceso',
          value: Number(r.referentes_sin_acceso || 0),
          detail: 'activos sin usuario habilitado',
          tone: Number(r.referentes_sin_acceso || 0) ? 'warn' : 'ok',
        },
        {
          label: 'Liquidado este mes',
          value: money.format(Number(r.comisiones_liquidadas_mes_total || 0)),
          detail: `${Number(r.comisiones_liquidadas_mes_count || 0)} comisión/es liquidadas`,
          tone: 'ok',
        },
      ];
      alertas.innerHTML = items.map((item) => `
        <div class="alert-item">
          <div><strong>${esc(item.label)}</strong><span>${esc(item.detail)}</span></div>
          <span class="badge ${item.tone}">${esc(item.value)}</span>
        </div>
      `).join('');
      if (!state.liquidaciones.length) {
        auditoria.innerHTML = '<div class="muted">Todavía no hay liquidaciones registradas.</div>';
        return;
      }
      auditoria.innerHTML = state.liquidaciones.map((l) => `
        <button class="audit-action" type="button" onclick="openLoteDetalle(${Number(l.id)})">
        <div class="audit-item">
          <div>
            <strong>Lote #${Number(l.id)} · ${money.format(Number(l.total || 0))}</strong>
            <small>${Number(l.comisiones_count || 0)} comisión/es · ${esc(l.liquidacion_referencia || 'sin referencia')}</small>
            <small>${esc(l.liquidacion_nota || '')}</small>
          </div>
          <small>${l.liquidada_at ? esc(dateFmt.format(new Date(l.liquidada_at))) : '-'}<br>${esc(l.liquidada_por_username || 'sin usuario')}</small>
        </div>
        </button>
      `).join('');
    }

    async function openLoteDetalle(id) {
      if (!id) return;
      const data = await api(`/api/referentes/liquidaciones/${Number(id)}${empresaQS()}`);
      const lote = data?.liquidacion || {};
      const rows = Array.isArray(data?.comisiones) ? data.comisiones : [];
      $('#loteDetalleTitle').textContent = `Liquidación #${Number(lote.id || id)}`;
      $('#loteDetalleResumen').textContent = `${money.format(Number(lote.total || 0))} · ${Number(lote.comisiones_count || rows.length)} comisión/es`;
      $('#loteDetalleMeta').textContent = [
        lote.liquidada_at ? dateFmt.format(new Date(lote.liquidada_at)) : '',
        lote.liquidada_por_username ? `usuario ${lote.liquidada_por_username}` : '',
        lote.liquidacion_referencia || 'sin referencia',
        lote.liquidacion_nota || '',
      ].filter(Boolean).join(' · ');
      $('#loteDetalleRows').innerHTML = rows.length ? rows.map((c) => `
        <div class="detail-row">
          <div>
            <strong>${esc(c.referente_nombre || '-')} <span class="code">${esc(c.referente_codigo || '')}</span></strong>
            <small>${esc(c.cliente || '-')} · ${esc(c.producto_nombre || '-')} · Pedido #${Number(c.pedido_id || 0)}</small>
            <small>Base ${money.format(Number(c.base_monto || 0))} · ${Number(c.porcentaje || 0).toFixed(2)}%</small>
          </div>
          <strong>${money.format(Number(c.monto_comision || 0))}</strong>
        </div>
      `).join('') : '<div class="muted">El lote no tiene comisiones asociadas.</div>';
      $('#dlgLoteDetalle').showModal();
    }

    function renderReferentes() {
      renderSummary();
      const q = $('#q').value.trim().toLowerCase();
      const estado = $('#estadoRef')?.value || 'todos';
      const rows = state.referentes.filter((r) => {
        if (estado === 'activos' && !r.activo) return false;
        if (estado === 'inactivos' && r.activo) return false;
        if (estado === 'sin-acceso' && r.usuario_id) return false;
        if (!q) return true;
        return [r.nombre, r.codigo, r.email, r.telefono].some((v) => String(v || '').toLowerCase().includes(q));
      });
      const tb = $('#tbReferentes');
      if (superSinEmpresa()) {
        tb.innerHTML = emptyRow(10, 'Selecciona una empresa', 'El super admin debe elegir empresa para ver o crear referentes.');
        return;
      }
      if (!rows.length) {
        tb.innerHTML = emptyRow(10, 'No hay referentes para mostrar.');
        return;
      }
      tb.innerHTML = rows.map((r) => `
        <tr style="opacity:${r.activo ? 1 : .55}">
          <td data-label="Referente">
            <strong>${esc(r.nombre)}</strong>
            <div class="muted">${esc(r.email || r.telefono || 'Sin contacto')}</div>
          </td>
          <td data-label="Codigo"><span class="code">${esc(r.codigo)}</span></td>
          <td data-label="Comision"><strong>${Number(r.porcentaje_comision || 0).toFixed(2)}%</strong></td>
          <td data-label="Vigencia">${esc(validUntilLabel(r))}</td>
          <td data-label="Clientes">${Number(r.clientes_count || 0)}</td>
          <td data-label="Productos">${Number(r.productos_count || 0)}</td>
          <td data-label="Pendiente">${money.format(Number(r.comisiones_pendientes || 0))}</td>
          <td data-label="Acceso">
            ${r.usuario_id ? `<span class="badge ${r.usuario_activo ? 'ok' : 'off'}">${r.usuario_activo ? 'Habilitado' : 'Bloqueado'}</span><div class="muted">${esc(r.usuario_username || '')}</div>` : '<span class="badge warn">Sin usuario</span>'}
          </td>
          <td data-label="Estado"><span class="badge ${r.activo ? 'ok' : 'off'}">${r.activo ? 'Activo' : 'Inactivo'}</span></td>
          <td data-label="Acciones">
            <div class="actions">
              <button class="btn btn-sm" onclick="openAcceso(${Number(r.id)})">Acceso</button>
              <button class="btn btn-sm" onclick="openEdit(${Number(r.id)})">Editar</button>
              <button class="btn btn-sm btn-danger" onclick="removeReferente(${Number(r.id)})">Eliminar</button>
            </div>
          </td>
        </tr>
      `).join('');
    }

    function getComisionesFiltradas() {
      const q = ($('#qComisiones')?.value || '').trim().toLowerCase();
      const ref = $('#fComisionRef')?.value || 'todos';
      const estado = $('#fComisionEstado')?.value || 'todos';
      const desde = $('#fComisionDesde')?.value || '';
      const hasta = $('#fComisionHasta')?.value || '';
      return state.comisiones.filter((c) => {
        const fecha = String(c.validada_at || c.liquidada_at || '').slice(0, 10);
        if (desde && fecha && fecha < desde) return false;
        if (hasta && fecha && fecha > hasta) return false;
        if (estado !== 'todos' && String(c.estado || 'validada') !== estado) return false;
        if (ref !== 'todos' && String(c.referente_id) !== ref) return false;
        if (!q) return true;
        return [c.referente_nombre, c.referente_codigo, c.cliente, c.producto_nombre, c.pedido_id]
          .some((v) => String(v || '').toLowerCase().includes(q));
      });
    }

    function csvCell(value) {
      return '"' + String(value ?? '').replace(/"/g, '""') + '"';
    }

    function exportComisionesCSV() {
      if (superSinEmpresa()) return toast('Selecciona una empresa primero.');
      const rows = getComisionesFiltradas();
      if (!rows.length) return toast('No hay comisiones para exportar.');
      const headers = ['Fecha','Referente','Codigo','Cliente','Producto','Pedido','Base','Porcentaje','Comision','Estado','Lote','Liquidada','Referencia','Liquidada por'];
      const lines = [headers.map(csvCell).join(',')];
      rows.forEach((c) => {
        lines.push([
          c.validada_at ? dateFmt.format(new Date(c.validada_at)) : '',
          c.referente_nombre || '',
          c.referente_codigo || '',
          c.cliente || '',
          c.producto_nombre || '',
          c.pedido_id ? '#' + c.pedido_id : '',
          Number(c.base_monto || 0).toFixed(2),
          Number(c.porcentaje || 0).toFixed(2),
          Number(c.monto_comision || 0).toFixed(2),
          c.estado || 'validada',
          c.liquidacion_lote_id ? '#' + c.liquidacion_lote_id : '',
          c.liquidada_at ? dateFmt.format(new Date(c.liquidada_at)) : '',
          c.liquidacion_referencia || '',
          c.liquidada_por_username || '',
        ].map(csvCell).join(','));
      });
      const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const empresa = empresaSeleccionadaNombre().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'empresa';
      a.href = url;
      a.download = 'referentes-comisiones-' + empresa + '-' + new Date().toISOString().slice(0,10) + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Exportadas ' + rows.length + ' comisión/es.');
    }

    function renderComisiones() {
      const tb = $('#tbComisiones');
      const rows = getComisionesFiltradas();
      if (superSinEmpresa()) {
        tb.innerHTML = emptyRow(11, 'Selecciona una empresa', 'Las comisiones se cargan por empresa para evitar mezclar liquidaciones.');
        renderSummary();
        return;
      }
      if (!rows.length) {
        tb.innerHTML = emptyRow(11, 'No hay comisiones para esos filtros.');
        renderSummary();
        return;
      }
      tb.innerHTML = rows.slice(0, 120).map((c) => `
        <tr>
          <td>
            <input type="checkbox" style="width:auto" data-comision-check="${Number(c.id)}" ${c.estado === 'validada' ? '' : 'disabled'} ${state.comisionesSeleccionadas.has(Number(c.id)) ? 'checked' : ''} />
          </td>
          <td data-label="Fecha">${c.validada_at ? esc(dateFmt.format(new Date(c.validada_at))) : '-'}</td>
          <td data-label="Referente">${esc(c.referente_nombre)} <div class="code">${esc(c.referente_codigo)}</div></td>
          <td data-label="Cliente">${esc(c.cliente || '-')}</td>
          <td data-label="Producto">${esc(c.producto_nombre || '-')}</td>
          <td data-label="Pedido">#${Number(c.pedido_id || 0)}</td>
          <td data-label="Base">${money.format(Number(c.base_monto || 0))}</td>
          <td data-label="%">${Number(c.porcentaje || 0).toFixed(2)}%</td>
          <td data-label="Comision"><strong>${money.format(Number(c.monto_comision || 0))}</strong></td>
          <td data-label="Estado"><span class="badge ${c.estado === 'liquidada' ? 'ok' : 'warn'}">${esc(c.estado || 'validada')}</span></td>
          <td data-label="Accion" style="text-align:right">
            ${c.estado === 'validada'
              ? `<button class="btn btn-sm" onclick="openLiquidacion([${Number(c.id)}])">Liquidar</button>`
              : `<span class="muted">${c.liquidacion_lote_id ? `Lote #${Number(c.liquidacion_lote_id)}` : 'liquidada'}<br>${c.liquidada_at ? esc(dateFmt.format(new Date(c.liquidada_at))) : ''}</span>`}
          </td>
        </tr>
      `).join('');
      document.querySelectorAll('[data-comision-check]').forEach((input) => {
        input.addEventListener('change', () => {
          const id = Number(input.dataset.comisionCheck);
          if (input.checked) state.comisionesSeleccionadas.add(id);
          else state.comisionesSeleccionadas.delete(id);
          renderSummary();
        });
      });
      renderSummary();
    }

    function renderClientesPropuestos() {
      renderSummary();
      const tb = $('#tbClientesPropuestos');
      const q = ($('#qClientes')?.value || '').trim().toLowerCase();
      const ref = $('#fClienteRef')?.value || 'todos';
      const modo = $('#fClientesModo')?.value || 'todos';
      const rows = state.clientesPropuestos.filter((c) => {
        if (modo === 'vinculados') return false;
        if (ref !== 'todos' && String(c.referente_id) !== ref) return false;
        if (!q) return true;
        return [c.cliente, c.telefono, c.direccion, c.ciudad, c.referente_nombre, c.referente_codigo]
          .some((v) => String(v || '').toLowerCase().includes(q));
      });
      if (superSinEmpresa()) {
        tb.innerHTML = emptyRow(7, 'Selecciona una empresa', 'Los clientes pendientes se validan dentro de una empresa concreta.');
        return;
      }
      if (!rows.length) {
        tb.innerHTML = emptyRow(7, 'Sin clientes pendientes para esos filtros.');
        return;
      }
      tb.innerHTML = rows.map((c) => `
        <tr>
          <td data-label="Fecha">${c.created_at ? esc(dateFmt.format(new Date(c.created_at))) : '-'}</td>
          <td data-label="Referente">${esc(c.referente_nombre || '-')} <div class="code">${esc(c.referente_codigo || '')}</div></td>
          <td data-label="Cliente"><strong>${esc(c.cliente || '-')}</strong></td>
          <td data-label="Telefono">${esc(c.telefono || '-')}</td>
          <td data-label="Direccion">${esc([c.direccion, c.ciudad].filter(Boolean).join(', ') || '-')}</td>
          <td data-label="Notas">${esc(c.notas || '-')}</td>
          <td data-label="Accion" style="text-align:right">
            <div class="actions">
              <button class="btn btn-sm" onclick="aprobarClientePropuesto(${Number(c.id)})">Aprobar</button>
              <button class="btn btn-sm btn-danger" onclick="rechazarClientePropuesto(${Number(c.id)})">Rechazar</button>
            </div>
          </td>
        </tr>
      `).join('');
    }

    function renderClientesVinculados() {
      const tb = $('#tbClientesVinculados');
      const q = ($('#qClientes')?.value || '').trim().toLowerCase();
      const ref = $('#fClienteRef')?.value || 'todos';
      const modo = $('#fClientesModo')?.value || 'todos';
      const rows = state.clientesVinculados.filter((c) => {
        if (modo === 'pendientes') return false;
        if (ref !== 'todos' && String(c.referente_id) !== ref) return false;
        if (!q) return true;
        return [c.cliente, c.telefono, c.direccion, c.ciudad, c.referente_nombre, c.referente_codigo]
          .some((v) => String(v || '').toLowerCase().includes(q));
      });
      if (superSinEmpresa()) {
        tb.innerHTML = emptyRow(7, 'Selecciona una empresa', 'Los clientes vinculados se consultan por empresa.');
        return;
      }
      if (!rows.length) {
        tb.innerHTML = emptyRow(7, 'Sin clientes vinculados para esos filtros.');
        return;
      }
      tb.innerHTML = rows.map((c) => `
        <tr>
          <td data-label="Desde">${c.asociado_at ? esc(dateFmt.format(new Date(c.asociado_at))) : '-'}</td>
          <td data-label="Referente">${esc(c.referente_nombre || '-')} <div class="code">${esc(c.referente_codigo || c.codigo_referente || '')}</div></td>
          <td data-label="Cliente">
            <strong>${esc(c.cliente || '-')}</strong>
            <div class="muted">${esc([c.direccion, c.ciudad].filter(Boolean).join(', ') || 'Sin dirección')}</div>
          </td>
          <td data-label="Telefono">${esc(c.telefono || '-')}</td>
          <td data-label="Pedidos">${Number(c.pedidos_count || 0)}</td>
          <td data-label="Comisiones">${money.format(Number(c.comisiones_total || 0))}</td>
          <td data-label="Accion" style="text-align:right">
            <button class="btn btn-sm btn-danger" onclick="desvincularCliente(${Number(c.cliente_id)})">Desvincular</button>
          </td>
        </tr>
      `).join('');
    }

    function renderProductosPicker(asignados = []) {
      const assigned = new Map(asignados.map((p) => [Number(p.producto_id), p]));
      state.productosAsignados = assigned;
      const wrap = $('#productosPicker');
      if (!state.productos.length) {
        wrap.innerHTML = '<div style="padding:1rem;color:var(--muted)">No hay productos cargados para esta empresa.</div>';
        return;
      }
      wrap.innerHTML = state.productos.map((p) => {
        const rel = assigned.get(Number(p.id));
        return `
          <div class="product-row">
            <input type="checkbox" data-prod-check="${Number(p.id)}" ${rel ? 'checked' : ''} />
            <div>
              <strong>${esc(p.nombre)}</strong>
              <div class="muted">${money.format(Number(p.precio || 0))}</div>
            </div>
            <input type="number" min="0" max="100" step="0.01" data-prod-pct="${Number(p.id)}" placeholder="% propio" value="${rel?.porcentaje_comision ?? ''}" />
          </div>
        `;
      }).join('');
    }

    async function loadProductos() {
      if (superSinEmpresa()) {
        state.productos = [];
        return;
      }
      state.productos = await api('/api/productos' + empresaQS()) || [];
    }

    async function loadReferentes() {
      renderCompanyContext();
      if (superSinEmpresa()) {
        state.referentes = [];
        state.comisiones = [];
        state.clientesPropuestos = [];
        state.clientesVinculados = [];
        state.resumen = null;
        state.liquidaciones = [];
        state.comisionesSeleccionadas.clear();
        renderReferentes();
        hydrateFilterOptions();
        renderComisiones();
        renderClientesPropuestos();
        renderClientesVinculados();
        return;
      }
      const [refs, coms, clientesPropuestos, clientesVinculados, resumen] = await Promise.all([
        api('/api/referentes' + empresaQS()),
        api('/api/referentes/comisiones' + comisionesQS()),
        api('/api/referentes/clientes-propuestos' + empresaQS()),
        api('/api/referentes/clientes' + empresaQS()),
        api('/api/referentes/resumen' + empresaQS()),
      ]);
      state.referentes = Array.isArray(refs) ? refs : [];
      state.comisiones = Array.isArray(coms) ? coms : [];
      state.clientesPropuestos = Array.isArray(clientesPropuestos) ? clientesPropuestos : [];
      state.clientesVinculados = Array.isArray(clientesVinculados) ? clientesVinculados : [];
      state.resumen = resumen?.resumen || null;
      state.liquidaciones = Array.isArray(resumen?.liquidaciones) ? resumen.liquidaciones : [];
      state.comisionesSeleccionadas = new Set([...state.comisionesSeleccionadas].filter((id) => state.comisiones.some((c) => Number(c.id) === id && c.estado === 'validada')));
      renderReferentes();
      hydrateFilterOptions();
      renderComisiones();
      renderClientesPropuestos();
      renderClientesVinculados();
    }

    function hydrateFilterOptions() {
      const options = '<option value="todos">Todos</option>' + state.referentes.map((r) => `<option value="${Number(r.id)}">${esc(r.nombre || r.codigo || r.id)}</option>`).join('');
      ['#fClienteRef', '#fComisionRef'].forEach((sel) => {
        const el = $(sel);
        if (!el) return;
        const current = el.value || 'todos';
        el.innerHTML = options;
        el.value = [...el.options].some((o) => o.value === current) ? current : 'todos';
      });
    }

    function applyPageChrome() {
      const page = currentPage();
      const meta = {
        dashboard: ['Dashboard de referentes', 'Vista ejecutiva del programa: estado, alertas, accesos rápidos y últimas liquidaciones.'],
        listado: ['Referentes', 'Alta, edicion, acceso y productos comisionables por referente.'],
        clientes: ['Clientes referidos', 'Busqueda, validacion, vinculacion y desvinculacion de clientes.'],
        comisiones: ['Comisiones y liquidaciones', 'Mesa operativa para revisar pendientes, seleccionar pagos, exportar y auditar liquidaciones.'],
        configuracion: ['Configuracion de referentes', 'Reglas comerciales y criterios operativos del programa.'],
      }[page] || ['Referentes', ''];
      $('#pageTitle').textContent = meta[0];
      $('#pageSubtitle').textContent = meta[1];
      document.title = `${meta[0]} | Referentes - MultiEmpresas`;
      document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === page));
      const btnNuevo = $('#btnNuevo');
      if (btnNuevo) {
        btnNuevo.hidden = page !== 'listado';
        btnNuevo.textContent = 'Nuevo referente';
      }
    }

    function getComisionesPendientes(ids) {
      const wanted = new Set(ids.map(Number));
      return state.comisiones.filter((c) => wanted.has(Number(c.id)) && c.estado === 'validada');
    }

    function openLiquidacion(ids = []) {
      const selectedIds = ids.length ? ids.map(Number) : [...state.comisionesSeleccionadas];
      const rows = getComisionesPendientes(selectedIds);
      if (!rows.length) return toast('No hay comisiones pendientes seleccionadas.');
      state.comisionesSeleccionadas = new Set(rows.map((c) => Number(c.id)));
      const total = rows.reduce((acc, c) => acc + Number(c.monto_comision || 0), 0);
      $('#liqResumen').textContent = `${rows.length} - ${money.format(total)}`;
      $('#liqReferencia').value = '';
      $('#liqNota').value = '';
      $('#dlgLiquidacion').showModal();
      $('#liqReferencia').focus();
    }

    async function liquidarSeleccionadas() {
      const ids = [...state.comisionesSeleccionadas];
      const rows = getComisionesPendientes(ids);
      if (!rows.length) return toast('Seleccioná comisiones pendientes.');
      const body = {
        comision_ids: rows.map((c) => Number(c.id)),
        referencia: $('#liqReferencia').value.trim() || null,
        nota: $('#liqNota').value.trim() || null,
      };
      if (state.isSuper) body.empresa_id = Number($('#empSel').value);
      const result = await api('/api/referentes/comisiones/liquidar', {
        method:'POST',
        body: JSON.stringify(body),
      });
      $('#dlgLiquidacion').close();
      state.comisionesSeleccionadas.clear();
      const lote = result?.lote?.id ? ` · lote #${result.lote.id}` : '';
      toast(`Liquidación registrada: ${result?.liquidadas || 0} comisión/es${lote}`);
      await refreshAll();
    }

    async function refreshAll() {
      try {
        renderCompanyContext();
        await loadProductos();
        await loadReferentes();
      } catch (e) {
        console.error(e);
        toast(e.message || 'No se pudo cargar referentes');
      }
    }

    function resetForm() {
      $('#formReferente').reset();
      $('#refId').value = '';
      $('#activo').checked = true;
      $('#porcentaje').value = '0';
      $('#codigo').disabled = false;
      renderProductosPicker([]);
    }

    async function openNew() {
      if (state.isSuper && !$('#empSel').value) return toast('Selecciona una empresa primero.');
      resetForm();
      $('#dlgTitle').textContent = 'Nuevo referente';
      $('#dlgReferente').showModal();
      $('#nombre').focus();
    }

    async function openEdit(id) {
      const r = state.referentes.find((x) => Number(x.id) === Number(id));
      if (!r) return;
      resetForm();
      $('#dlgTitle').textContent = 'Editar referente';
      $('#refId').value = r.id;
      $('#nombre').value = r.nombre || '';
      $('#codigo').value = r.codigo || '';
      $('#codigo').disabled = true;
      $('#porcentaje').value = Number(r.porcentaje_comision || 0);
      $('#telefono').value = r.telefono || '';
      $('#email').value = r.email || '';
      $('#direccion').value = r.direccion || '';
      $('#desde').value = r.vigente_desde ? String(r.vigente_desde).slice(0, 10) : '';
      $('#hasta').value = r.vigente_hasta ? String(r.vigente_hasta).slice(0, 10) : '';
      $('#notas').value = r.notas || '';
      $('#activo').checked = !!r.activo;
      try {
        const asignados = await api(`/api/referentes/${id}/productos` + empresaQS());
        renderProductosPicker(Array.isArray(asignados) ? asignados : []);
      } catch (e) {
        toast(e.message || 'No se pudieron cargar productos asignados');
      }
      $('#dlgReferente').showModal();
    }

    function generatePassword() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      let out = 'Ref-';
      const cryptoObj = window.crypto || window.msCrypto;
      const bytes = new Uint8Array(10);
      cryptoObj.getRandomValues(bytes);
      for (const b of bytes) out += chars[b % chars.length];
      return out;
    }

    async function openAcceso(id) {
      const r = state.referentes.find((x) => Number(x.id) === Number(id));
      if (!r) return;
      $('#formAcceso').reset();
      $('#accesoRefId').value = id;
      $('#accesoTitle').textContent = `Acceso de ${r.nombre || 'referente'}`;
      $('#accesoUsername').value = r.usuario_username || normalizeCode(r.codigo || r.nombre || `ref-${id}`).toLowerCase();
      $('#accesoPassword').value = r.usuario_id ? '' : generatePassword();
      $('#accesoPassword').placeholder = r.usuario_id ? 'Dejar vacio para no cambiar' : 'Clave inicial obligatoria';
      $('#accesoActivo').checked = r.usuario_id ? r.usuario_activo !== false : true;

      try {
        const data = await api(`/api/referentes/${id}/acceso` + empresaQS());
        if (data?.username) $('#accesoUsername').value = data.username;
        if (data?.id) $('#accesoActivo').checked = data.activo !== false;
      } catch (e) {
        toast(e.message || 'No se pudo cargar el acceso');
      }

      $('#dlgAcceso').showModal();
      $('#accesoUsername').focus();
    }

    async function saveAcceso() {
      const id = Number($('#accesoRefId').value);
      const body = {
        username: $('#accesoUsername').value.trim(),
        password: $('#accesoPassword').value,
        activo: $('#accesoActivo').checked,
      };
      if (state.isSuper) body.empresa_id = Number($('#empSel').value);
      if (!body.password) delete body.password;

      await api(`/api/referentes/${id}/acceso`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      $('#dlgAcceso').close();
      toast('Acceso actualizado');
      await refreshAll();
    }

    function collectProductos() {
      return state.productos
        .filter((p) => document.querySelector(`[data-prod-check="${Number(p.id)}"]`)?.checked)
        .map((p) => {
          const pctValue = document.querySelector(`[data-prod-pct="${Number(p.id)}"]`)?.value;
          return {
            producto_id: Number(p.id),
            porcentaje_comision: pctValue === '' ? null : Number(pctValue),
            activo: true,
          };
        });
    }

    async function saveReferente() {
      const id = $('#refId').value;
      const body = {
        nombre: $('#nombre').value.trim(),
        codigo: normalizeCode($('#codigo').value),
        porcentaje_comision: Number($('#porcentaje').value || 0),
        telefono: $('#telefono').value.trim() || null,
        email: $('#email').value.trim() || null,
        direccion: $('#direccion').value.trim() || null,
        vigente_desde: $('#desde').value || null,
        vigente_hasta: $('#hasta').value || null,
        notas: $('#notas').value.trim() || null,
        activo: $('#activo').checked,
      };
      if (state.isSuper) body.empresa_id = Number($('#empSel').value);
      if (!body.nombre || !body.codigo) return toast('Nombre y codigo son obligatorios.');

      const saved = await api(id ? `/api/referentes/${id}` : '/api/referentes', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      const refId = Number(id || saved?.id);
      await api(`/api/referentes/${refId}/productos`, {
        method:'POST',
        body: JSON.stringify({ empresa_id: state.isSuper ? Number($('#empSel').value) : undefined, productos: collectProductos() }),
      });
      $('#dlgReferente').close();
      toast('Referente guardado');
      await refreshAll();
    }

    async function removeReferente(id) {
      if (!confirm('Eliminar este referente? Sus asociaciones historicas quedan preservadas para auditoria.')) return;
      try {
        await api(`/api/referentes/${id}` + empresaQS(), { method:'DELETE' });
        toast('Referente eliminado');
        await refreshAll();
      } catch (e) {
        toast(e.message || 'No se pudo eliminar');
      }
    }

    async function aprobarClientePropuesto(id) {
      if (!confirm('Aprobar este cliente y vincularlo al referente?')) return;
      const body = {};
      if (state.isSuper) body.empresa_id = Number($('#empSel').value);
      try {
        await api(`/api/referentes/clientes-propuestos/${id}/aprobar`, {
          method:'POST',
          body: JSON.stringify(body),
        });
        toast('Cliente aprobado y vinculado');
        await refreshAll();
      } catch (e) {
        toast(e.message || 'No se pudo aprobar');
      }
    }

    async function rechazarClientePropuesto(id) {
      const motivo = prompt('Motivo del rechazo opcional') || '';
      const body = { motivo: motivo.trim() || null };
      if (state.isSuper) body.empresa_id = Number($('#empSel').value);
      try {
        await api(`/api/referentes/clientes-propuestos/${id}/rechazar`, {
          method:'POST',
          body: JSON.stringify(body),
        });
        toast('Cliente propuesto rechazado');
        await refreshAll();
      } catch (e) {
        toast(e.message || 'No se pudo rechazar');
      }
    }

    async function desvincularCliente(clienteId) {
      const motivo = prompt('Motivo de desvinculación opcional') || '';
      if (!confirm('Desvincular este cliente del referente? Los pedidos anteriores quedan preservados.')) return;
      const body = { motivo: motivo.trim() || null };
      if (state.isSuper) body.empresa_id = Number($('#empSel').value);
      try {
        await api(`/api/referentes/clientes/${Number(clienteId)}/desvincular`, {
          method:'POST',
          body: JSON.stringify(body),
        });
        toast('Cliente desvinculado');
        await refreshAll();
      } catch (e) {
        toast(e.message || 'No se pudo desvincular');
      }
    }

    async function init() {
      applyPageChrome();
      $('#logout').onclick = async (e) => {
        e.preventDefault();
        try { await authFetch('/api/logout', { method:'POST' }); } catch {}
        location.href = 'login.html';
      };
      $('#btnNuevo').onclick = openNew;
      $('#btnRefresh').onclick = refreshAll;
      $('#btnLiquidarSeleccion').onclick = () => openLiquidacion();
      $('#chkAllComisiones').addEventListener('change', (e) => {
        const checked = e.target.checked;
        getComisionesFiltradas().filter((c) => c.estado === 'validada').forEach((c) => {
          if (checked) state.comisionesSeleccionadas.add(Number(c.id));
          else state.comisionesSeleccionadas.delete(Number(c.id));
        });
        renderComisiones();
      });
      $('#q').addEventListener('input', renderReferentes);
      $('#estadoRef')?.addEventListener('change', renderReferentes);
      ['#qClientes', '#fClienteRef', '#fClientesModo'].forEach((sel) => {
        $(sel)?.addEventListener(sel === '#qClientes' ? 'input' : 'change', () => {
          renderClientesVinculados();
          renderClientesPropuestos();
        });
      });
      ['#qComisiones', '#fComisionRef', '#fComisionEstado'].forEach((sel) => {
        $(sel)?.addEventListener(sel === '#qComisiones' ? 'input' : 'change', renderComisiones);
      });
      ['#fComisionDesde', '#fComisionHasta'].forEach((sel) => {
        $(sel)?.addEventListener('change', refreshAll);
      });
      $('#btnExportComisiones')?.addEventListener('click', exportComisionesCSV);
      $('#btnClose').onclick = () => $('#dlgReferente').close();
      $('#btnCancel').onclick = () => $('#dlgReferente').close();
      $('#btnAccesoClose').onclick = () => $('#dlgAcceso').close();
      $('#btnAccesoCancel').onclick = () => $('#dlgAcceso').close();
      $('#btnLiqClose').onclick = () => $('#dlgLiquidacion').close();
      $('#btnLiqCancel').onclick = () => $('#dlgLiquidacion').close();
      $('#btnLoteClose').onclick = () => $('#dlgLoteDetalle').close();
      $('#btnGenPass').onclick = () => {
        $('#accesoPassword').value = generatePassword();
        $('#accesoPassword').focus();
      };
      $('#codigo').addEventListener('blur', () => { $('#codigo').value = normalizeCode($('#codigo').value); });
      $('#formReferente').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await saveReferente(); } catch (err) { console.error(err); toast(err.message || 'No se pudo guardar'); }
      });
      $('#formAcceso').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await saveAcceso(); } catch (err) { console.error(err); toast(err.message || 'No se pudo guardar acceso'); }
      });
      $('#formLiquidacion').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await liquidarSeleccionadas(); } catch (err) { console.error(err); toast(err.message || 'No se pudo liquidar'); }
      });

      const me = await api('/api/me');
      state.user = me?.user || {};
      state.isSuper = String(state.user.role || '').toLowerCase() === 'super';
      $('#rolePill').textContent = state.isSuper ? 'SUPER ADMIN' : String(state.user.role || 'admin').toUpperCase();

      if (state.isSuper) {
        $('#empWrap').hidden = false;
        const empresas = await api('/api/empresas');
        $('#empSel').innerHTML = '<option value="">Seleccionar empresa</option>' + (Array.isArray(empresas) ? empresas.map((e) => `<option value="${Number(e.id)}">${esc(e.nombre)}</option>`).join('') : '');
        $('#empSel').addEventListener('change', () => {
          state.comisionesSeleccionadas.clear();
          refreshAll();
        });
      }

      await refreshAll();
    }

    init().catch((e) => {
      console.error(e);
      toast(e.message || 'Error inicializando referentes');
    });
