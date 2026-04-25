(function () {
  function calcAdvancedKpis(list) {
    const arr = Array.isArray(list) ? list : [];
    const byClient = new Map();
    const byDay = new Map();
    let paidMonto = 0;
    let totalMonto = 0;

    for (const r of arr) {
      const monto = num(r.monto);
      const key = String(r.telefono || r.cliente || 'sin-id');
      const prevCli = byClient.get(key) || { cliente: r.cliente || 'S/N', pedidos: 0, ventas: 0 };
      prevCli.pedidos += 1;
      prevCli.ventas += monto;
      byClient.set(key, prevCli);

      const day = String(r.fecha).slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + monto);

      totalMonto += monto;
      if (r.pagado) paidMonto += monto;
    }

    const clientes = Array.from(byClient.values());
    const totalClientes = clientes.length;
    const recompraCount = clientes.filter(c => c.pedidos > 1).length;
    const recompraPct = totalClientes ? (recompraCount / totalClientes) * 100 : 0;
    const cobranzaPct = totalMonto ? (paidMonto / totalMonto) * 100 : 0;
    const pendMonto = Math.max(0, totalMonto - paidMonto);
    const diasActivos = byDay.size;
    const promDia = diasActivos ? (totalMonto / diasActivos) : 0;
    const topCliente = clientes.sort((a, b) => b.ventas - a.ventas)[0] || null;

    return {
      totalClientes,
      recompraCount,
      recompraPct,
      cobranzaPct,
      pendMonto,
      diasActivos,
      promDia,
      topCliente,
    };
  }

  function resetAdvancedKpis() {
    if ($('#kpiClientesUnicos')) $('#kpiClientesUnicos').textContent = '0';
    if ($('#kpiClientesTop')) $('#kpiClientesTop').textContent = 'Top cliente: —';
    if ($('#kpiRecompra')) $('#kpiRecompra').textContent = '0,0%';
    if ($('#kpiRecompraDetalle')) $('#kpiRecompraDetalle').textContent = '0 de 0 clientes repiten';
    if ($('#kpiCobranza')) $('#kpiCobranza').textContent = '0,0%';
    if ($('#kpiCobranzaPend')) $('#kpiCobranzaPend').textContent = 'Pendiente: $ 0,00';
    if ($('#kpiDiasActivos')) $('#kpiDiasActivos').textContent = '0';
    if ($('#kpiPromDia')) $('#kpiPromDia').textContent = 'Promedio diario: $ 0,00';
    ['#kpiClientesDelta', '#kpiRecompraDelta', '#kpiCobranzaDelta', '#kpiPromDiaDelta'].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.textContent = 'vs ant.: —';
      el.style.color = 'var(--muted)';
    });
  }

  function previousRange(from, to) {
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
    const oneDayMs = 24 * 60 * 60 * 1000;
    const spanDays = Math.floor((end - start) / oneDayMs) + 1;
    const prevEnd = new Date(start.getTime() - oneDayMs);
    const prevStart = new Date(prevEnd.getTime() - (spanDays - 1) * oneDayMs);
    return { from: dateISO(prevStart), to: dateISO(prevEnd) };
  }

  function renderAdvancedKpisFromEntregados(list, prevList = null) {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) {
      resetAdvancedKpis();
      return;
    }

    const cur = calcAdvancedKpis(arr);
    const prev = Array.isArray(prevList) && prevList.length ? calcAdvancedKpis(prevList) : null;

    if ($('#kpiClientesUnicos')) $('#kpiClientesUnicos').textContent = String(cur.totalClientes);
    if ($('#kpiClientesTop')) {
      $('#kpiClientesTop').textContent = cur.topCliente
        ? `Top cliente: ${cur.topCliente.cliente} · ${money(cur.topCliente.ventas)}`
        : 'Top cliente: —';
    }
    if ($('#kpiRecompra')) $('#kpiRecompra').textContent = `${cur.recompraPct.toFixed(1).replace('.', ',')}%`;
    if ($('#kpiRecompraDetalle')) $('#kpiRecompraDetalle').textContent = `${cur.recompraCount} de ${cur.totalClientes} clientes repiten`;
    if ($('#kpiCobranza')) $('#kpiCobranza').textContent = `${cur.cobranzaPct.toFixed(1).replace('.', ',')}%`;
    if ($('#kpiCobranzaPend')) $('#kpiCobranzaPend').textContent = `Pendiente: ${money(cur.pendMonto)}`;
    if ($('#kpiDiasActivos')) $('#kpiDiasActivos').textContent = String(cur.diasActivos);
    if ($('#kpiPromDia')) $('#kpiPromDia').textContent = `Promedio diario: ${money(cur.promDia)}`;

    const setDelta = (id, diff, asMoney = false, suffix = '') => {
      const el = $(id);
      if (!el) return;
      if (!prev) {
        el.textContent = 'vs ant.: —';
        el.style.color = 'var(--muted)';
        return;
      }
      const sign = diff >= 0 ? '+' : '';
      const icon = trendIcon(diff);
      if (asMoney && deltaMode === 'pct') {
        const base = id === '#kpiPromDiaDelta' ? prev.promDia : 0;
        const pctVal = base ? ((diff / Math.abs(base)) * 100) : 0;
        el.textContent = `vs ant.: ${icon} ${sign}${Math.abs(pctVal).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
      } else {
        el.textContent = asMoney
          ? `vs ant.: ${icon} ${sign}${money(diff)}`
          : `vs ant.: ${icon} ${sign}${diff.toFixed(1).replace('.', ',')}${suffix}`;
      }
      el.style.color = diff === 0 ? 'var(--muted)' : (diff > 0 ? 'var(--success)' : 'var(--danger)');
    };

    setDelta('#kpiClientesDelta', cur.totalClientes - prev.totalClientes, false, '');
    setDelta('#kpiRecompraDelta', cur.recompraPct - prev.recompraPct, false, ' pp');
    setDelta('#kpiCobranzaDelta', cur.cobranzaPct - prev.cobranzaPct, false, ' pp');
    setDelta('#kpiPromDiaDelta', cur.promDia - prev.promDia, true);
  }

  async function loadEntregadosStats(from, to) {
    const topClientesEl = $('#topClientes');
    const rowsEl = $('#ventasDiaRows');
    const paidEl = $('#payPaid');
    const pendEl = $('#payPend');
    const pctEl = $('#payPct');

    try {
      const url = buildEntregadosUrl(from, to, null);
      const res = await api(url);
      const list = Array.isArray(res) ? res : (Array.isArray(res?.rows) ? res.rows : []);

      let prevList = null;
      const prevRange = previousRange(from, to);
      if (prevRange) {
        try {
          const prevUrl = buildEntregadosUrl(prevRange.from, prevRange.to, null);
          const prevRes = await api(prevUrl);
          prevList = Array.isArray(prevRes) ? prevRes : (Array.isArray(prevRes?.rows) ? prevRes.rows : []);
        } catch (e) {
          if (typeof isAuthRedirectError === 'function' && isAuthRedirectError(e)) throw e;
          prevList = null;
        }
      }

      renderAdvancedKpisFromEntregados(list, prevList);

      let paidMonto = 0, pendMonto = 0, paidCount = 0, pendCount = 0;
      for (const r of list) {
        const monto = num(r.monto);
        if (r.pagado) { paidMonto += monto; paidCount += 1; }
        else { pendMonto += monto; pendCount += 1; }
      }
      const totalCount = paidCount + pendCount;
      const paidPct = totalCount ? (paidCount / totalCount * 100) : 0;

      if (paidEl) paidEl.textContent = `${paidCount} · ${money(paidMonto)}`;
      if (pendEl) pendEl.textContent = `${pendCount} · ${money(pendMonto)}`;
      if (pctEl) pctEl.textContent = `${paidPct.toFixed(1)}%`;

      const mapCli = new Map();
      for (const r of list) {
        const key = String(r.telefono || r.cliente || 'sin-id');
        const cur = mapCli.get(key) || {
          cliente: r.cliente || 'S/N',
          telefono: r.telefono || '',
          pedidos: 0,
          ventas: 0,
          pagados: 0,
        };
        cur.pedidos += 1;
        cur.ventas += num(r.monto);
        if (r.pagado) cur.pagados += 1;
        mapCli.set(key, cur);
      }
      const top = Array.from(mapCli.values()).sort((a, b) => b.ventas - a.ventas).slice(0, 8);

      if (topClientesEl) {
        if (!top.length) topClientesEl.innerHTML = `<li class="muted">Sin datos</li>`;
        else {
          topClientesEl.innerHTML = top.map(c => {
            const paidp = c.pedidos ? (c.pagados / c.pedidos * 100) : 0;
            const tel = String(c.telefono || '').replace(/\D/g, '');
            const wa = tel
              ? `<a class="wa-btn ok" href="https://wa.me/${tel}" target="_blank" rel="noopener">${waIcon}</a>`
              : `<span class="wa-btn">${waIcon}</span>`;
            return `
              <li>
                <span style="display:flex; align-items:center; gap:8px; min-width:0;">
                  ${wa}
                  <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(c.cliente)}</span>
                </span>
                <span>${money(c.ventas)} · ${c.pedidos}p · ${paidp.toFixed(0)}%</span>
              </li>
            `;
          }).join('');
        }
      }

      const byDay = new Map();
      for (const r of list) {
        const day = String(r.fecha).slice(0, 10);
        const prev = byDay.get(day) || { fecha: day, pedidos: 0, ventas: 0, paid: 0, total: 0 };
        prev.pedidos += 1;
        prev.ventas += num(r.monto);
        prev.total += 1;
        if (r.pagado) prev.paid += 1;
        byDay.set(day, prev);
      }
      const days = Array.from(byDay.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));

      if (rowsEl) {
        if (!days.length) {
          rowsEl.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:1rem; color:var(--muted)">Sin datos</td></tr>`;
        } else {
          rowsEl.innerHTML = days.map(d => {
            const pp = d.total ? (d.paid / d.total * 100) : 0;
            return `
              <tr>
                <td>${d.fecha}</td>
                <td class="numeric">${d.pedidos}</td>
                <td class="numeric">${money(d.ventas)}</td>
                <td class="numeric">${pp.toFixed(0)}%</td>
              </tr>
            `;
          }).join('');
        }
      }
    } catch (e) {
      if (!(typeof isAuthRedirectError === 'function' && isAuthRedirectError(e))) {
        console.error('Error loadEntregadosStats', e);
      }
      resetAdvancedKpis();
      if (topClientesEl) topClientesEl.innerHTML = `<li class="muted">Error</li>`;
      if (rowsEl) rowsEl.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:1rem; color:var(--muted)">Error</td></tr>`;
      if (paidEl) paidEl.textContent = '—';
      if (pendEl) pendEl.textContent = '—';
      if (pctEl) pctEl.textContent = '—';
      if (typeof isAuthRedirectError === 'function' && isAuthRedirectError(e)) throw e;
    }
  }

  function fmtMinutes(min) {
    const m = Math.max(0, Math.round(num(min)));
    if (!m) return '0 min';
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (!h) return `${r} min`;
    return `${h}h ${r}m`;
  }

  async function loadSlaEntrega(from, to) {
    const pctEl = $('#slaPct');
    const avgEl = $('#slaAvg');
    const p90El = $('#slaP90');
    try {
      const base = '/api/reportes/sla-entrega' + qsEmpresa();
      const sep = base.includes('?') ? '&' : '?';
      const choferId = $('#fFilChofer')?.value;
      const url = `${base}${sep}from=${from}&to=${to}` + (choferId ? `&chofer_id=${choferId}` : '');
      const res = await api(url);

      const pctv = num(res?.pct_en_sla);
      if (pctEl) {
        pctEl.textContent = `${pctv.toFixed(1).replace('.', ',')}% (${num(res?.en_sla)}/${num(res?.total)})`;
        pctEl.className = pctv >= 90 ? 'ok' : (pctv >= 75 ? '' : 'bad');
      }
      if (avgEl) avgEl.textContent = fmtMinutes(res?.demora_prom_min);
      if (p90El) p90El.textContent = fmtMinutes(res?.demora_p90_min);
    } catch (e) {
      if (pctEl) pctEl.textContent = '—';
      if (avgEl) avgEl.textContent = '—';
      if (p90El) p90El.textContent = '—';
      if (typeof isAuthRedirectError === 'function' && isAuthRedirectError(e)) throw e;
    }
  }

  async function loadCancelacionesMotivo(from, to) {
    const el = $('#cancelMotivos');
    if (!el) return;
    try {
      const base = '/api/reportes/cancelaciones-motivo' + qsEmpresa();
      const sep = base.includes('?') ? '&' : '?';
      const choferId = $('#fFilChofer')?.value;
      const url = `${base}${sep}from=${from}&to=${to}` + (choferId ? `&chofer_id=${choferId}` : '');
      const res = await api(url);
      const total = num(res?.total);
      const motivos = Array.isArray(res?.motivos) ? res.motivos : [];

      if (!motivos.length) {
        el.innerHTML = `<li><span style="color:var(--muted)">Sin cancelaciones en el período</span></li>`;
        return;
      }

      el.innerHTML = motivos.slice(0, 6).map(m => {
        const c = num(m.cantidad);
        const pctv = total ? (c / total * 100) : 0;
        return `<li><span>${esc(m.motivo)}</span><span>${c} · ${pctv.toFixed(1).replace('.', ',')}%</span></li>`;
      }).join('');
    } catch (e) {
      el.innerHTML = `<li><span style="color:var(--muted)">No disponible</span></li>`;
      if (typeof isAuthRedirectError === 'function' && isAuthRedirectError(e)) throw e;
    }
  }

  async function loadProductosMargen(from, to) {
    const el = $('#productosMargen');
    if (!el) return;
    try {
      const base = '/api/reportes/productos-margen' + qsEmpresa();
      const sep = base.includes('?') ? '&' : '?';
      const choferId = $('#fFilChofer')?.value;
      const url = `${base}${sep}from=${from}&to=${to}` + (choferId ? `&chofer_id=${choferId}` : '');
      const res = await api(url);
      const top = Array.isArray(res?.top) ? res.top : [];
      const bottom = Array.isArray(res?.bottom) ? res.bottom : [];

      if (!top.length && !bottom.length) {
        el.innerHTML = `<li><span style="color:var(--muted)">Sin datos de margen</span></li>`;
        return;
      }

      const best = top[0];
      const worst = bottom[0];
      const rows = [];
      if (best) rows.push(`<li><span>⭐ ${esc(best.producto)}</span><span class="ok">${money(best.margen)} · ${pct(best.margen_pct)}</span></li>`);
      if (worst) rows.push(`<li><span>⚠️ ${esc(worst.producto)}</span><span class="bad">${money(worst.margen)} · ${pct(worst.margen_pct)}</span></li>`);
      top.slice(1, 4).forEach(p => rows.push(`<li><span>${esc(p.producto)}</span><span>${money(p.margen)}</span></li>`));
      el.innerHTML = rows.join('');
    } catch (e) {
      el.innerHTML = `<li><span style="color:var(--muted)">No disponible</span></li>`;
      if (typeof isAuthRedirectError === 'function' && isAuthRedirectError(e)) throw e;
    }
  }

  window.calcAdvancedKpis = calcAdvancedKpis;
  window.resetAdvancedKpis = resetAdvancedKpis;
  window.previousRange = previousRange;
  window.renderAdvancedKpisFromEntregados = renderAdvancedKpisFromEntregados;
  window.loadEntregadosStats = loadEntregadosStats;
  window.fmtMinutes = fmtMinutes;
  window.loadSlaEntrega = loadSlaEntrega;
  window.loadCancelacionesMotivo = loadCancelacionesMotivo;
  window.loadProductosMargen = loadProductosMargen;
})();
