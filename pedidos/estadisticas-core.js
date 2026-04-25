(function () {
  const API_BASE = '';
  const authFetch = (url, opts = {}) => {
    const { headers = {}, ...rest } = opts;
    return fetch(url, { ...rest, headers, credentials: 'include' });
  };

  let isSuper = false;
  let empresaId = null;
  let choferes = [];
  let productosByName = new Map();
  let authRedirectInProgress = false;

  window.__transfers = window.__transfers || [];
  window.__transfers_total = window.__transfers_total || 0;
  window.__transfers_total_all = window.__transfers_total_all || 0;
  window.__transfers_pend = window.__transfers_pend || 0;
  window.__onlyPendTransfers = window.__onlyPendTransfers || false;

  function redirectToLogin() {
    if (authRedirectInProgress) return;
    authRedirectInProgress = true;
    location.href = 'login.html';
  }

  function isAuthRedirectError(err) {
    return !!(err && (err.code === 'AUTH_REDIRECT' || err.redirectedToLogin));
  }

  async function api(path, opts = {}) {
    const { headers = {}, body, ...rest } = opts;
    const fullUrl = path.startsWith('http') ? path : (API_BASE + path);

    try {
      const r = await authFetch(fullUrl, {
        ...rest,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: body ? JSON.stringify(body) : undefined
      });

      if (r.status === 401) {
        const e = new Error('AUTH_REDIRECT');
        e.code = 'AUTH_REDIRECT';
        e.status = 401;
        e.redirectedToLogin = true;
        redirectToLogin();
        throw e;
      }

      const text = await r.text();
      try {
        return JSON.parse(text);
      } catch {
        console.error(`ERROR DE API: Respuesta no JSON en ${fullUrl}`, text);
        throw new Error(`Error ${r.status}: respuesta inválida del servidor`);
      }
    } catch (e) {
      if (isAuthRedirectError(e)) throw e;
      console.error('Fetch falló completamente:', e);
      throw e;
    }
  }

  function qsEmpresa() {
    const selectedId = isSuper ? document.querySelector('#empSel')?.value : null;
    const idAUsar = selectedId || empresaId;
    return idAUsar ? `?empresa_id=${idAUsar}` : '';
  }

  async function loadChoferes() {
    try {
      const list = await api('/api/choferes' + qsEmpresa());
      choferes = Array.isArray(list) ? list : [];
      const sel = document.querySelector('#fFilChofer');
      if (!sel) return;
      sel.innerHTML = '<option value="">Todos</option>' + choferes.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('');
    } catch (e) {
      if (isAuthRedirectError(e)) throw e;
      console.warn('Error cargando choferes', e);
    }
  }

  async function loadProductosMap() {
    try {
      const rows = await api('/api/productos' + qsEmpresa());
      productosByName = new Map();
      (Array.isArray(rows) ? rows : []).forEach(p => {
        if (p.nombre) productosByName.set(p.nombre.toLowerCase().trim(), p.id);
      });
    } catch (e) {
      if (isAuthRedirectError(e)) throw e;
      console.warn('Error cargando productos', e);
    }
  }

  async function initEstadisticasCore() {
    try {
      const meResp = await api('/api/me');
      const u = meResp?.user || meResp;
      if (!u || !u.empresa_id) throw new Error('Sesión inválida');

      isSuper = String(u.role || '').toUpperCase() === 'SUPER';
      empresaId = Number(u.empresa_id);

      let empresas = [];
      try {
        const empresasResp = await api('/api/empresas');
        empresas = Array.isArray(empresasResp) ? empresasResp : [];
      } catch (e) {
        if (isAuthRedirectError(e)) throw e;
        console.warn('Error empresas', e);
      }

      const sel = document.querySelector('#empSel');
      if (sel) {
        if (empresas.length > 0) {
          sel.innerHTML = empresas.map(e => `
            <option value="${e.id}" ${Number(e.id) === Number(empresaId) ? 'selected' : ''}>
              ID: ${e.id} - ${e.nombre}
            </option>
          `).join('');
        } else {
          sel.innerHTML = '<option value="">Sin acceso a empresas</option>';
        }

        sel.onchange = async () => {
          if (!isSuper) return;
          if (typeof showToast === 'function') showToast('Cambiando contexto de Empresa...');
          const nombreEmp = sel.options[sel.selectedIndex]?.text || `ID ${sel.value}`;
          const rolePill = document.querySelector('#rolePill');
          if (rolePill) rolePill.textContent = `${u.role} · ${nombreEmp}`;
          await loadChoferes();
          await loadProductosMap();
          const tbBody = document.querySelector('#tbBody');
          if (tbBody) tbBody.innerHTML = '<tr><td colspan="11" style="text-align:center; padding:2rem; color:var(--muted)">Empresa cambiada. Presione "Calcular" para actualizar.</td></tr>';
        };
      }

      const empWrap = document.querySelector('#empWrap');
      if (empWrap) empWrap.hidden = !isSuper;

      const selectedTxt = document.querySelector('#empSel')?.options?.[document.querySelector('#empSel')?.selectedIndex || 0]?.text || `ID ${empresaId}`;
      const rolePill = document.querySelector('#rolePill');
      if (rolePill) rolePill.textContent = `${u.role || 'USER'} · ${selectedTxt}`;

      await loadChoferes();
      await loadProductosMap();

      const today = new Date();
      const toEl = document.querySelector('#fTo');
      const fromEl = document.querySelector('#fFrom');
      if (toEl) toEl.value = dateISO(today);
      if (fromEl) {
        const fromDate = new Date(today);
        fromDate.setDate(fromDate.getDate() - 30);
        fromEl.value = dateISO(fromDate);
      }

      document.querySelector('#btnCalcular').onclick = calcular;
      document.querySelector('#btnExport').onclick = exportCSV;
      const btnVerTransfer = document.querySelector('#btnVerTransfer');
      if (btnVerTransfer) btnVerTransfer.onclick = openTransferModal;

      const deltaModeEl = document.querySelector('#deltaMode');
      if (deltaModeEl) {
        deltaMode = deltaModeEl.value || 'abs';
        deltaModeEl.onchange = () => {
          deltaMode = deltaModeEl.value || 'abs';
          calcular();
        };
      }

      if (window.initEstadisticasTransferencias) {
        window.initEstadisticasTransferencias();
      }

      const hoySel = document.querySelector('#fHoy');
      if (hoySel) {
        hoySel.onchange = () => {
          if (hoySel.value === '1') setHoyRange();
        };
      }

      const clearHoy = () => {
        if (hoySel && hoySel.value === '1') hoySel.value = '0';
      };
      if (fromEl) fromEl.addEventListener('change', clearHoy);
      if (toEl) toEl.addEventListener('change', clearHoy);

      const logoutEl = document.getElementById('logout');
      if (logoutEl) {
        logoutEl.addEventListener('click', async (e) => {
          e.preventDefault();
          try { await authFetch('/api/logout', { method: 'POST' }); } catch {}
          location.href = 'login.html';
        });
      }
    } catch (e) {
      if (isAuthRedirectError(e)) return;
      console.error('Error init:', e);
    }
  }

  window.authFetch = authFetch;
  window.api = api;
  window.qsEmpresa = qsEmpresa;
  window.isAuthRedirectError = isAuthRedirectError;
  window.redirectToLogin = redirectToLogin;
  window.loadChoferes = loadChoferes;
  window.loadProductosMap = loadProductosMap;
  window.initEstadisticasCore = initEstadisticasCore;
  window.__estadisticasCore = {
    get isSuper() { return isSuper; },
    get empresaId() { return empresaId; },
    get choferes() { return choferes; },
    get productosByName() { return productosByName; }
  };
})();
