const repartidorViewScroll = Object.create(null);

function showRepartidorSection(sec, { moveFocus = false } = {}) {
  const target = document.getElementById('sec-' + sec);
  if (!target) return;
  const current = Array.from($$('main > section')).find(section => !section.hidden);
  if (current === target) return;
  if (current) repartidorViewScroll[current.id] = window.scrollY;
  $$('.nav-link').forEach(link => {
    if (link.dataset.sec === sec) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $$('main > section').forEach(section => { section.hidden = section !== target; });
  $('#menuPanel')?.classList.remove('show');
  $('#menuToggle')?.setAttribute('aria-expanded', 'false');
  requestAnimationFrame(() => {
    if (moveFocus) target.querySelector('[data-view-target]')?.focus({ preventScroll: true });
    window.scrollTo({ top: repartidorViewScroll[target.id] || 0, behavior: 'instant' });
    if (sec === 'mapa') renderMap({ preserveViewport: !!map });
  });
  if (sec === 'gastos') gInit();
  if (sec === 'stock') loadStockRepartidor();
  if (sec === 'resumen') calcResumen();
  if (sec === 'transf') loadTransf();
  if (sec === 'evidencias') loadEvidenciasEntrega();
}

function initRepartidorShellUI() {
  if (initRepartidorShellUI._ready) return;
  initRepartidorShellUI._ready = true;

  const btn = $('#menuToggle');
  const panel = $('#menuPanel');
  if (btn && panel) {
    btn.onclick = () => btn.setAttribute('aria-expanded', String(panel.classList.toggle('show')));
  }

  $$('.nav-link').forEach(l => l.onclick = async (e) => {
    e.preventDefault();
    if(l.id === 'logout') {
      try { await authFetch('/api/logout', { method: 'POST' }); } catch {}
      location.href='login.html';
      return;
    }

    const sec = l.dataset.sec;
    if (!sec) {
      const href = l.getAttribute('href');
      if (href) location.href = href;
      return;
    }
    
    showRepartidorSection(sec);
  });

  $$('[data-view-target]').forEach(button => {
    button.addEventListener('click', () => showRepartidorSection(button.dataset.viewTarget, { moveFocus: true }));
  });

  const evDateFrom = document.getElementById('evDateFrom');
  const evDateTo = document.getElementById('evDateTo');
  if (evDateFrom) evDateFrom.addEventListener('change', loadEvidenciasEntrega);
  if (evDateTo) evDateTo.addEventListener('change', loadEvidenciasEntrega);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      schedulePedidosRefresh();
      return;
    }
    schedulePedidosRefresh(2_000);
  });

  window.addEventListener('online', () => {
    schedulePedidosRefresh(2_000);
  });

  window.addEventListener('offline', () => {
    schedulePedidosRefresh();
  });

  window.addEventListener('beforeunload', () => {
    stopPedidosAutoRefresh();
  });
}

// --- AUTO-REFRESH PEDIDOS (inteligente) ---
const pedidosRefreshState = {
  baseMs: 45_000,
  hiddenMs: 120_000,
  offlineMs: 180_000,
  timer: null,
  inFlight: false,
  stopped: false,
};

function isMapaVisible() {
  const secMapa = document.getElementById('sec-mapa');
  return !!(secMapa && !secMapa.hidden);
}

function getPedidosRefreshDelay() {
  if (pedidosRefreshState.stopped) return null;
  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) return pedidosRefreshState.offlineMs;
  if (document.hidden) return pedidosRefreshState.hiddenMs;
  return pedidosRefreshState.baseMs;
}

function schedulePedidosRefresh(nextMs = null) {
  if (pedidosRefreshState.timer) {
    clearTimeout(pedidosRefreshState.timer);
    pedidosRefreshState.timer = null;
  }

  const delay = nextMs ?? getPedidosRefreshDelay();
  if (!delay) return;

  pedidosRefreshState.timer = setTimeout(runPedidosRefresh, delay);
}

async function runPedidosRefresh() {
  if (pedidosRefreshState.stopped || pedidosRefreshState.inFlight) {
    schedulePedidosRefresh();
    return;
  }

  pedidosRefreshState.inFlight = true;
  try {
    await loadPedidos();
    if (isMapaVisible()) renderMap();
  } catch (e) {
    console.warn('Auto-refresh de pedidos falló', e);
  } finally {
    pedidosRefreshState.inFlight = false;
    schedulePedidosRefresh();
  }
}

function startPedidosAutoRefresh() {
  pedidosRefreshState.stopped = false;
  schedulePedidosRefresh(pedidosRefreshState.baseMs);
}

function stopPedidosAutoRefresh() {
  pedidosRefreshState.stopped = true;
  if (pedidosRefreshState.timer) {
    clearTimeout(pedidosRefreshState.timer);
    pedidosRefreshState.timer = null;
  }
}


