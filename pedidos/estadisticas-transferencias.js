(function () {
  function buildEntregadosUrl(from, to, metodo_pago) {
    const base = '/api/reportes/entregados';
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const choferId = document.querySelector('#fFilChofer')?.value;
    if (choferId) params.set('chofer_id', choferId);
    if (metodo_pago) params.set('metodo_pago', metodo_pago);

    const emp = qsEmpresa();
    let url = base;
    if (emp) {
      url += emp;
      const qs = params.toString();
      if (qs) url += '&' + qs;
    } else {
      const qs = params.toString();
      if (qs) url += '?' + qs;
    }
    return url;
  }

  async function loadTransferenciasData(from, to) {
    try {
      const url = buildEntregadosUrl(from, to, 'transferencia');
      const res = await api(url);
      const list = Array.isArray(res) ? res : (Array.isArray(res?.rows) ? res.rows : []);
      const totalAll = list.reduce((a, t) => a + num(t.monto), 0);
      const totalPaid = list.reduce((a, t) => a + (t.pagado ? num(t.monto) : 0), 0);
      const pend = list.filter(t => !t.pagado).length;
      const aiVerified = list.filter(isTransferAiVerified).length;

      window.__transfers = list;
      window.__transfers_total = totalPaid;
      window.__transfers_total_all = totalAll;
      window.__transfers_pend = pend;

      $('#kpiTransferencia').textContent = money(totalPaid);
      updateTransferResumen(list.length, pend, aiVerified);
    } catch (e) {
      if (typeof isAuthRedirectError === 'function' && isAuthRedirectError(e)) throw e;
      console.error(e);
      window.__transfers = [];
      window.__transfers_total = 0;
      window.__transfers_total_all = 0;
      window.__transfers_pend = 0;
      $('#kpiTransferencia').textContent = money(0);
      $('#transferResumen').textContent = 'Error cargando transferencias';
    }
  }

  function isTruthyDb(value) {
    return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
  }

  function isTransferAiVerified(t) {
    const reason = String(t?.transferencia_verified_reason || t?.verified_reason || '').toLowerCase();
    return isTruthyDb(t?.transferencia_ai_verificada)
      || isTruthyDb(t?.transferencia_procesado)
      || reason.includes('automat')
      || reason.includes(' por ia')
      || reason.includes('desde whatsapp');
  }

  function transferAiLabel(t) {
    if (isTransferAiVerified(t)) return { text: 'IA', className: 'ai-check ok', title: 'Comprobante verificado automaticamente por IA' };
    if (t?.comprobante_transferencia_id) return { text: 'Rev.', className: 'ai-check warn', title: 'Comprobante cargado sin verificacion automatica de IA' };
    return { text: '—', className: 'ai-check muted', title: 'Sin comprobante asociado' };
  }

  function updateTransferResumen(total, pendientes, iaVerificadas) {
    $('#transferResumen').textContent = total
      ? `${total} transferencias (${pendientes} pendientes · ${iaVerificadas} IA)`
      : 'Sin transferencias en el rango';
  }

  function renderTransferRow(t, index) {
    const ai = transferAiLabel(t);
    return `
      <tr data-id="${t.id}">
        <td class="numeric">${index + 1}</td>
        <td class="numeric">
          <input type="checkbox" data-action="toggle-transfer" data-pedido-id="${t.id}" ${t.pagado ? 'checked' : ''}>
        </td>
        <td class="numeric">
          <span class="${ai.className}" title="${esc(ai.title)}">${esc(ai.text)}</span>
        </td>
        <td class="numeric">
          <a href="${waLink(t.telefono)}" target="_blank" rel="noopener" class="wa-btn" title="WhatsApp">
            ${waIcon}
          </a>
        </td>
        <td>#${t.id}</td>
        <td>${esc(t.cliente || '')}</td>
        <td class="numeric" style="color:#fff">${money(t.monto)}</td>
      </tr>
    `;
  }

  async function loadEfectivoData(from, to) {
    try {
      const url = buildEntregadosUrl(from, to, 'efectivo');
      const res = await api(url);
      const list = Array.isArray(res) ? res : (Array.isArray(res?.rows) ? res.rows : []);
      const total = list.reduce((a, t) => a + num(t.monto), 0);
      $('#kpiEfectivo').textContent = money(total);
    } catch (e) {
      if (typeof isAuthRedirectError === 'function' && isAuthRedirectError(e)) throw e;
      console.error(e);
      $('#kpiEfectivo').textContent = money(0);
    }
  }

  function buildMediosPagoUrl(from, to) {
    const base = '/api/reportes/medios-pago';
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const choferId = document.querySelector('#fFilChofer')?.value;
    if (choferId) params.set('chofer_id', choferId);

    const emp = qsEmpresa();
    let url = base;
    if (emp) {
      url += emp;
      const qs = params.toString();
      if (qs) url += '&' + qs;
    } else {
      const qs = params.toString();
      if (qs) url += '?' + qs;
    }
    return url;
  }

  function resetQrMediosPago() {
    if ($('#kpiQrMp')) $('#kpiQrMp').textContent = money(0);
    if ($('#kpiQrMpDetalle')) $('#kpiQrMpDetalle').textContent = 'QR: 0 aprobados / 0 pendientes';
    if ($('#qrPayApproved')) $('#qrPayApproved').textContent = '—';
    if ($('#qrPayPending')) $('#qrPayPending').textContent = '—';
    if ($('#qrPayRate')) $('#qrPayRate').textContent = '—';
  }

  async function loadMediosPagoData(from, to) {
    try {
      const res = await api(buildMediosPagoUrl(from, to));
      const qr = res?.qr || {};
      const aprobado = num(qr.aprobado);
      const pendiente = num(qr.pendiente);
      const total = num(qr.total);
      const aprobados = num(qr.aprobados);
      const pendientes = num(qr.pendientes);
      const cantidad = num(qr.cantidad);
      const tasa = cantidad ? (aprobados / cantidad) * 100 : 0;

      if ($('#kpiQrMp')) $('#kpiQrMp').textContent = money(aprobado);
      if ($('#kpiQrMpDetalle')) $('#kpiQrMpDetalle').textContent = `QR: ${aprobados} aprobados / ${pendientes} pendientes`;
      if ($('#qrPayApproved')) $('#qrPayApproved').textContent = `${aprobados} · ${money(aprobado)}`;
      if ($('#qrPayPending')) $('#qrPayPending').textContent = `${pendientes} · ${money(pendiente)}`;
      if ($('#qrPayRate')) {
        $('#qrPayRate').textContent = cantidad ? `${tasa.toFixed(1).replace('.', ',')}% · ${money(total)}` : 'Sin pagos QR';
        $('#qrPayRate').className = tasa >= 90 ? 'ok' : (tasa >= 70 ? 'warning-text' : (cantidad ? 'bad' : ''));
      }
    } catch (e) {
      if (typeof isAuthRedirectError === 'function' && isAuthRedirectError(e)) throw e;
      console.error(e);
      resetQrMediosPago();
    }
  }

  function getTransfersForModal() {
    const list = window.__transfers || [];
    return window.__onlyPendTransfers ? list.filter(t => !t.pagado) : list;
  }

  function closeTransferModal() {
    const modal = document.getElementById('transferModal');
    if (!modal) return;
    if (typeof modal.close === 'function') modal.close();
    else modal.removeAttribute('open');
  }

  function waLink(tel) {
    return `https://wa.me/${String(tel).replace(/\D/g, '')}?text=Por Favor, Adjuntar Transferencia de Pago 👆🏻🙏🏻.`;
  }

  function renderTransferModal() {
    const list = getTransfersForModal();
    const tb = $('#transferList');
    const modal = document.getElementById('transferModal');
    if (!tb || !modal) return;

    const btnOnly = $('#btnOnlyPend');
    if (btnOnly) {
      btnOnly.textContent = window.__onlyPendTransfers ? 'Mostrar todas' : 'Mostrar solo pendientes';
      btnOnly.onclick = () => {
        window.__onlyPendTransfers = !window.__onlyPendTransfers;
        renderTransferModal();
      };
    }

    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:1rem">No hay transferencias para mostrar.</td></tr>';
    } else {
      tb.innerHTML = list.map(renderTransferRow).join('');
    }

    if (typeof modal.showModal === 'function' && !modal.open) {
      modal.showModal();
    } else {
      modal.setAttribute('open', '');
    }
  }

  async function togglePagoPedido(pedidoId, checkbox) {
    const nuevoEstado = checkbox.checked;
    const estadoPrevio = !nuevoEstado;
    checkbox.disabled = true;

    try {
      const res = await api(`/api/pedidos/${pedidoId}/toggle-pago`, {
        method: 'POST',
        body: { marcado: nuevoEstado }
      });

      if (!res || res.error || res.ok !== true) {
        throw new Error(res?.error || 'No se pudo actualizar');
      }

      showToast(nuevoEstado ? 'Transferencia marcada como PAGADA ✅' : 'Transferencia marcada como NO pagada ⚠️');

      const list = window.__transfers || [];
      const idx = list.findIndex(x => Number(x.id) === Number(pedidoId));
      if (idx >= 0) list[idx].pagado = !!nuevoEstado;

      const totalAll = list.reduce((a, t) => a + num(t.monto), 0);
      const totalPaid = list.reduce((a, t) => a + (t.pagado ? num(t.monto) : 0), 0);
      const pend = list.filter(t => !t.pagado).length;
      const aiVerified = list.filter(isTransferAiVerified).length;

      window.__transfers_total = totalPaid;
      window.__transfers_total_all = totalAll;
      window.__transfers_pend = pend;

      $('#kpiTransferencia').textContent = money(totalPaid);
      updateTransferResumen(list.length, pend, aiVerified);

      if (window.__onlyPendTransfers) renderTransferModal();
    } catch (e) {
      if (!(typeof isAuthRedirectError === 'function' && isAuthRedirectError(e))) {
        console.error(e);
        alert('No se pudo actualizar el estado del pago.');
      }
      checkbox.checked = estadoPrevio;
      if (typeof isAuthRedirectError === 'function' && isAuthRedirectError(e)) throw e;
    } finally {
      checkbox.disabled = false;
    }
  }

  function showToast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show';
    setTimeout(() => { t.className = 'toast'; }, 3000);
  }

  function initEstadisticasTransferencias() {
    const closeTransferBtn = $('#btnCloseTransferModal');
    if (closeTransferBtn) closeTransferBtn.onclick = closeTransferModal;

    const transferList = $('#transferList');
    if (transferList && !transferList.dataset.boundToggle) {
      transferList.addEventListener('change', async ev => {
        const checkbox = ev.target.closest('input[data-action="toggle-transfer"]');
        if (!checkbox) return;
        const pedidoId = Number(checkbox.getAttribute('data-pedido-id'));
        if (!pedidoId) return;
        await togglePagoPedido(pedidoId, checkbox);
      });
      transferList.dataset.boundToggle = '1';
    }
  }

  window.buildEntregadosUrl = buildEntregadosUrl;
  window.buildMediosPagoUrl = buildMediosPagoUrl;
  window.loadTransferenciasData = loadTransferenciasData;
  window.loadEfectivoData = loadEfectivoData;
  window.loadMediosPagoData = loadMediosPagoData;
  window.resetQrMediosPago = resetQrMediosPago;
  window.openTransferModal = renderTransferModal;
  window.closeTransferModal = closeTransferModal;
  window.togglePagoPedido = togglePagoPedido;
  window.showToast = showToast;
  window.waLink = waLink;
  window.initEstadisticasTransferencias = initEstadisticasTransferencias;
})();
