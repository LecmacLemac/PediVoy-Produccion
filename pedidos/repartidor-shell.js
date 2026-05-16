function initRepartidorShellUI() {
  if (initRepartidorShellUI._ready) return;
  initRepartidorShellUI._ready = true;

  const btn = $('#menuToggle');
  const panel = $('#menuPanel');
  if (btn && panel) {
    btn.onclick = () => panel.classList.toggle('show');
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
    
    $$('.nav-link').forEach(n => n.removeAttribute('aria-current'));
    l.setAttribute('aria-current', 'page');
    $$('main > section').forEach(s => s.hidden = true);
    
    $('#sec-'+sec).hidden = false;
    panel?.classList.remove('show');

    if(sec === 'mapa') setTimeout(renderMap, 200);
    if(sec === 'gastos') gInit();
    if(sec === 'stock') loadStockRepartidor();
    if(sec === 'resumen') calcResumen();
    if(sec === 'transf') loadTransf();
    if(sec === 'evidencias') loadEvidenciasEntrega();
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


