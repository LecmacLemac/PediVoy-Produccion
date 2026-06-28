(function () {
  async function calcular() {
    const from = $('#fFrom').value;
    const to = $('#fTo').value;
    if (!from || !to) return alert('Fechas requeridas');

    if (typeof updateSummaryStatus === 'function') updateSummaryStatus('Calculando...');
    $('#btnCalcular').disabled = true;
    $('#btnCalcular').textContent = 'Calculando...';
    $('#tbBody').innerHTML = `<tr><td colspan="11" style="text-align:center; padding:2rem">Procesando datos...</td></tr>`;

    try {
      const base = `/api/estadisticas/dashboard${qsEmpresa()}`;
      const sep = base.includes('?') ? '&' : '?';
      const choferId = $('#fFilChofer').value;
      const url = `${base}${sep}from=${from}&to=${to}` + (choferId ? `&chofer_id=${choferId}` : '');

      const res = await api(url);
      if (!res || !res.report) throw new Error('Respuesta del servidor incompleta');

      const rows = res.report || [];
      const products = res.products || [];
      const evolution = res.evolution || [];
      const prev = res.prev || null;

      renderReport(rows, products, evolution, prev);
      const auxResults = await Promise.allSettled([
        loadTransferenciasData(from, to),
        loadEfectivoData(from, to),
        loadMediosPagoData(from, to),
        loadEntregadosStats(from, to),
        loadSlaEntrega(from, to),
        loadCancelacionesMotivo(from, to),
        loadProductosMargen(from, to)
      ]);

      const authFailure = auxResults.find(r => r.status === 'rejected' && isAuthRedirectError(r.reason));
      if (authFailure) throw authFailure.reason;

      const failedAux = auxResults.filter(r => r.status === 'rejected');
      if (failedAux.length) {
        console.warn('Reportes auxiliares incompletos:', failedAux.map(r => r.reason?.message || r.reason));
        if (typeof showToast === 'function') showToast('Dashboard actualizado con algunos reportes auxiliares no disponibles.');
        if (typeof updateSummaryStatus === 'function') updateSummaryStatus('Actualizado con alertas');
      } else if (typeof updateSummaryStatus === 'function') {
        updateSummaryStatus('Actualizado');
      }
    } catch (e) {
      if (isAuthRedirectError(e)) return;
      console.error(e);
      $('#tbBody').innerHTML = `<tr><td colspan="11" class="bad" style="text-align:center">Error: ${e.message}</td></tr>`;
      if (typeof updateSummaryStatus === 'function') updateSummaryStatus('Error al calcular');
    } finally {
      $('#btnCalcular').disabled = false;
      $('#btnCalcular').textContent = 'Calcular Rentabilidad';
    }
  }

  function renderReport(rows, products, evolution, prev = null) {
    if (!rows || !rows.length) {
      $('#tbBody').innerHTML = `<tr><td colspan="11" style="text-align:center; padding:2rem">No hay datos en este período.</td></tr>`;
      const kpis = ['#kpiVentas', '#kpiRent', '#kpiTicket', '#kpiCV', '#kpiCF', '#kpiCP'];
      kpis.forEach(id => $(id).textContent = money(0));
      $('#kpiPedidos').textContent = '0 Pedidos';
      $('#kpiMargen').textContent = 'Margen: 0,00%';
      $('#kpiUnidades').textContent = '0';
      $('#kpiUpp').textContent = 'Promedio: 0 un/ped';
      if (typeof resetQrMediosPago === 'function') resetQrMediosPago();
      if ($('#kpiVentasDelta')) $('#kpiVentasDelta').textContent = '';
      if ($('#kpiRentDelta')) $('#kpiRentDelta').textContent = '';
      if ($('#kpiTicketDelta')) $('#kpiTicketDelta').textContent = '';
      $('#topProductos').innerHTML = `<li class="muted" style="font-size:0.8rem">Sin datos de productos</li>`;
      ['#choferEstrella', '#choferEficiente'].forEach(id => $(id).innerHTML = `<li class="muted">Sin datos</li>`);
      ['#chartVentas', '#chartRent', '#chartMargen', '#chartSerie'].forEach(id => $(id).innerHTML = '');
      resetAdvancedKpis();
      return;
    }

    const sum = k => rows.reduce((a, b) => a + num(b[k]), 0);
    const totV = sum('ventas');
    const totCV = sum('cv');
    const totCF = sum('cf');
    const totCP = sum('cp');
    const totPed = sum('pedidos');
    const totUni = sum('unidades');
    const totR = totV - totCV - totCF - totCP;
    const ticket = (totPed ? totV / totPed : 0);

    $('#kpiVentas').textContent = money(totV);
    $('#kpiRent').textContent = money(totR);
    $('#kpiRent').style.color = totR >= 0 ? 'var(--success)' : 'var(--danger)';
    $('#kpiPedidos').textContent = `${totPed} Pedidos`;
    $('#kpiMargen').textContent = `Margen: ${pct(totV ? (totR / totV * 100) : 0)}`;
    $('#kpiUnidades').textContent = String(totUni);
    $('#kpiUpp').textContent = `Promedio: ${(totPed ? totUni / totPed : 0).toFixed(2)} un/ped`;
    $('#kpiTicket').textContent = money(ticket);

    renderDeltas({ ventas: totV, rent: totR, ticket }, prev);

    $('#kpiCV').textContent = money(totCV);
    $('#kpiCF').textContent = money(totCF);
    $('#kpiCP').textContent = money(totCP);

    rows = rows.slice().sort((a, b) => b.rent - a.rent);
    $('#tbBody').innerHTML = rows.map(r => `
      <tr>
        <td style="font-weight:600; color:#fff">${esc(r.chofer)}</td>
        <td><span class="role-badge">${esc(r.tipo)}</span></td>
        <td class="numeric">${r.pedidos}</td>
        <td class="numeric">${r.unidades}</td>
        <td class="numeric" style="color:var(--warning)">${money(r.cv)}</td>
        <td class="numeric" style="color:#fff; font-weight:bold">${money(r.ventas)}</td>
        <td class="numeric" style="color:var(--danger)">${money(r.cf)}</td>
        <td class="numeric" style="color:var(--muted)">${money(r.cp)}</td>
        <td class="numeric">${money(r.pedidos ? r.ventas / r.pedidos : 0)}</td>
        <td class="numeric ${r.margen >= 0 ? 'ok' : 'bad'}">${pct(r.margen)}</td>
        <td class="numeric ${r.rent >= 0 ? 'ok' : 'bad'}" style="font-weight:bold; font-size:1rem;">${money(r.rent)}</td>
      </tr>
    `).join('');

    $('#tfVentas').textContent = money(totV);
    $('#tfCV').textContent = money(totCV);
    $('#tfCF').textContent = money(totCF);
    $('#tfCP').textContent = money(totCP);
    $('#tfRent').textContent = money(totR);
    $('#tfMargen').textContent = pct(totV ? (totR / totV * 100) : 0);
    $('#tfTicket').textContent = money(totPed ? totV / totPed : 0);

    const estrella = rows[0];
    $('#choferEstrella').innerHTML = estrella
      ? `<li><span>${esc(estrella.chofer)}</span><span class="ok">${money(estrella.rent)}</span></li>`
      : `<li class="muted">Sin datos</li>`;

    const eficiente = rows.slice().sort((a, b) => b.margen - a.margen)[0];
    $('#choferEficiente').innerHTML = eficiente
      ? `<li><span>${esc(eficiente.chofer)}</span><span class="ok">${pct(eficiente.margen)}</span></li>`
      : `<li class="muted">Sin datos</li>`;

    const topProd = (products || []).slice().sort((a, b) => b.cantidad - a.cantidad).slice(0, 5);
    if (!topProd.length) {
      $('#topProductos').innerHTML = `<li class="muted" style="font-size:0.8rem">Sin datos de productos en este rango</li>`;
    } else {
      $('#topProductos').innerHTML = topProd.map(p => `
        <li>
          <span>${esc(p.producto)}</span>
          <span>${p.cantidad} u · ${money(p.ventas)}</span>
        </li>
      `).join('');
    }

    renderCharts(rows, evolution);
  }

  function renderCharts(rows, evolution) {
    const top5 = rows.slice(0, 5);
    const labels = top5.map(r => (r.chofer || '').split(' ')[0] || 'Chofer');
    $('#chartVentas').innerHTML = barSVG(labels, top5.map(r => r.ventas), '#0ea5e9', false);
    $('#chartRent').innerHTML = barSVG(labels, top5.map(r => r.rent), '#10b981', false);
    $('#chartMargen').innerHTML = barSVG(labels, top5.map(r => r.margen), '#f59e0b', true);

    const cont = $('#chartSerie');
    if (!cont) return;
    if (!evolution || !evolution.length) {
      cont.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--muted)">Sin datos de evolución para este rango</div>`;
      return;
    }
    cont.innerHTML = lineSVG(evolution);
  }

  function barSVG(labels, values, color, isPct = false) {
    if (!values.length) return '';
    const h = 260, w = 400, pad = 30;
    const max = Math.max(...values.map(v => Math.abs(v)), 1);
    const innerW = w - pad * 2;
    const bw = innerW / values.length;

    const bars = values.map((v, i) => {
      const val = Number(v) || 0;
      const height = (Math.abs(val) / max) * (h - pad * 2);
      const x = pad + i * bw;
      const y = h - pad - height;
      const labelVal = isPct ? `${val.toFixed(1)}%` : money(val);
      const name = labels[i] || '';
      return `
        <rect x="${x + 4}" y="${y}" width="${bw - 8}" height="${height}" rx="4" fill="${color}" opacity="0.85"></rect>
        <text x="${x + bw / 2}" y="${h - 8}" text-anchor="middle" fill="#94a3b8" font-size="10">${name}</text>
        <text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" fill="#e5e7eb" font-size="10">${labelVal}</text>
      `;
    }).join('');

    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
  }

  function lineSVG(points) {
    const parsed = points.map(p => ({ fecha: new Date(p.fecha), ventas: Number(p.ventas) || 0, rent: Number(p.rent) || 0 }))
      .sort((a, b) => a.fecha - b.fecha);
    if (!parsed.length) return '';

    const w = 800, h = 260, pad = 30;
    const maxVentas = Math.max(...parsed.map(p => p.ventas), 1);
    const maxRent = Math.max(...parsed.map(p => p.rent), 1);
    const maxVal = Math.max(maxVentas, maxRent);
    const scaleX = i => pad + i * ((w - pad * 2) / Math.max(parsed.length - 1, 1));
    const scaleY = v => h - pad - (v / maxVal) * (h - pad * 2);

    const pathVentas = parsed.map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(p.ventas)}`).join(' ');
    const pathRent = parsed.map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(p.rent)}`).join(' ');
    const circlesVentas = parsed.map((p, i) => `<circle cx="${scaleX(i)}" cy="${scaleY(p.ventas)}" r="2"></circle>`).join('');
    const circlesRent = parsed.map((p, i) => `<circle cx="${scaleX(i)}" cy="${scaleY(p.rent)}" r="2"></circle>`).join('');
    const labels = parsed.map((p, i) => {
      const d = p.fecha;
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      return `<text x="${scaleX(i)}" y="${h - 8}" text-anchor="middle" fill="#94a3b8" font-size="9">${dd}/${mm}</text>`;
    }).join('');

    return `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
        <path d="${pathVentas}" fill="none" stroke="#0ea5e9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
        <path d="${pathRent}" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
        ${circlesVentas}
        ${circlesRent}
        ${labels}
      </svg>
    `;
  }

  function trendIcon(diff) {
    if (diff > 0) return '▲';
    if (diff < 0) return '▼';
    return '•';
  }

  function fmtDelta(cur, prev) {
    const d = cur - prev;
    const sign = d >= 0 ? '+' : '';
    if (deltaMode === 'pct') {
      const base = num(prev);
      const pctVal = base ? ((d / Math.abs(base)) * 100) : 0;
      return `${trendIcon(d)} ${sign}${Math.abs(pctVal).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
    }
    return `${trendIcon(d)} ${sign}${money(d)}`;
  }

  function renderDeltas(cur, prev) {
    const vEl = $('#kpiVentasDelta');
    const rEl = $('#kpiRentDelta');
    const tEl = $('#kpiTicketDelta');
    if (!prev) {
      if (vEl) vEl.textContent = '—';
      if (rEl) rEl.textContent = '—';
      if (tEl) tEl.textContent = '—';
      return;
    }

    if (vEl) {
      vEl.textContent = `vs ${prev.from}→${prev.to}: ${fmtDelta(cur.ventas, prev.ventas)}`;
      const dv = cur.ventas - prev.ventas;
      vEl.style.color = dv === 0 ? 'var(--muted)' : (dv > 0 ? 'var(--success)' : 'var(--danger)');
    }
    if (rEl) {
      rEl.textContent = `vs ${prev.from}→${prev.to}: ${fmtDelta(cur.rent, prev.rent)}`;
      const dr = cur.rent - prev.rent;
      rEl.style.color = dr === 0 ? 'var(--muted)' : (dr > 0 ? 'var(--success)' : 'var(--danger)');
    }
    if (tEl) {
      const d = cur.ticket - prev.ticket;
      const sign = d >= 0 ? '+' : '';
      if (deltaMode === 'pct') {
        const pctVal = prev.ticket ? ((d / Math.abs(prev.ticket)) * 100) : 0;
        tEl.textContent = `Ticket vs ant.: ${trendIcon(d)} ${sign}${Math.abs(pctVal).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
      } else {
        tEl.textContent = `Ticket vs ant.: ${trendIcon(d)} ${sign}${money(d)}`;
      }
      tEl.style.color = d === 0 ? 'var(--muted)' : (d > 0 ? 'var(--success)' : 'var(--danger)');
    }
  }

  function exportCSV() {
    try {
      const tbody = document.getElementById('tbBody');
      const table = tbody?.closest('table');
      if (!table) return alert('No hay tabla para exportar.');

      const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
      const rows = [...table.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim()));
      const escCsv = v => `"${String(v).replace(/"/g, '""')}"`;
      const csv = [headers.map(escCsv).join(','), ...rows.map(r => r.map(escCsv).join(','))].join('\n');

      const from = $('#fFrom')?.value || 'from';
      const to = $('#fTo')?.value || 'to';
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `estadisticas_${from}_${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error(e);
      alert('No se pudo exportar el CSV.');
    }
  }

  window.calcular = calcular;
  window.renderReport = renderReport;
  window.renderCharts = renderCharts;
  window.barSVG = barSVG;
  window.lineSVG = lineSVG;
  window.trendIcon = trendIcon;
  window.fmtDelta = fmtDelta;
  window.renderDeltas = renderDeltas;
  window.exportCSV = exportCSV;
})();
