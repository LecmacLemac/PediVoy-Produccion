import { WPP_SESSION_ID, getWppSessionBasePath } from './sessionUtils.js';

export function createWppClientLifecycle({
  ENABLE_WPP,
  Client,
  LocalAuth,
  handlers,
  path,
  handleIncomingMediaMessage,
  limpiarLocksSesion,
  scheduleInitWhatsApp,
  reiniciarWhatsApp,
  getState,
  setState,
}) {
  if (!ENABLE_WPP) return { wppClient: null, isRender: false };

  console.log('[WPP SERVER] WhatsApp habilitado. Inicializando cliente...');

  const isRender = process.env.RENDER === 'true';
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (isRender ? '/usr/bin/chromium' : null);
  const sessionBasePath = getWppSessionBasePath({ path });

  console.log(`[WPP SERVER] Usando ejecutable: ${executablePath || 'default'}`);
  console.log(`[WPP SERVER] En Render: ${isRender}`);
  console.log(`[WPP SERVER] Sesión LocalAuth en: ${sessionBasePath}`);

  const wppClient = new Client({
    authStrategy: new LocalAuth({ clientId: WPP_SESSION_ID, dataPath: sessionBasePath }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.x.html',
    },
    puppeteer: {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=VizDisplayCompositor',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-software-rasterizer',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
      ],
      executablePath,
      ignoreHTTPSErrors: true,
      timeout: 60000,
    },
  });

  wppClient.on('qr', (qr) => {
    setState({ lastQr: qr, isConnected: false, isReadyWpp: false });
    console.log('[WPP SERVER] QR RECIBIDO. Escanea para conectar.');
  });

  wppClient.on('authenticated', async () => {
    setState({ isConnected: true, isReadyWpp: false, lastQr: null });
    console.log('[WPP SERVER] Autenticado ✅');

    if (!getState().wppHandlersStarted) {
      setState({ wppHandlersStarted: true });
      try {
        console.log('[WPP SERVER] Iniciando handlers preventivamente (authenticated)...');
        await handlers.start(wppClient);
        console.log('[WPP SERVER] Handlers iniciados preventivamente.');
      } catch (e) {
        setState({ wppHandlersStarted: false });
        console.error('[WPP SERVER] Error en handlers preventivos:', e);
      }
    }
  });

  wppClient.on('auth_failure', (msg) => {
    if (getState().isShuttingDownWpp) return;
    setState({ isConnected: false, isReadyWpp: false, wppHandlersStarted: false });
    console.error('[WPP SERVER] Falla de auth:', msg);
    console.log('[WPP SERVER] Reintentando después de auth failure...');
    scheduleInitWhatsApp(5000);
  });

  wppClient.on('change_state', (state) => {
    console.log('[WPP SERVER] Estado cliente WPP:', state);
  });

  wppClient.on('loading_screen', (percent, message) => {
    console.log('[WPP SERVER] Cargando WhatsApp Web:', percent, '% -', message);
  });

  wppClient.on('error', (err) => {
    console.error('[WPP SERVER] ERROR cliente WPP:', err);
    if (err.message && (err.message.includes('closed') || err.message.includes('disconnected') || err.message.includes('Protocol error'))) {
      console.log('[WPP SERVER] Error crítico detectado, reiniciando en 10 segundos...');
      setTimeout(reiniciarWhatsApp, 10000);
    }
  });

  wppClient.on('ready', async () => {
    setState({ isConnected: true, isReadyWpp: true, lastQr: null });
    console.log('[WPP SERVER] CLIENTE LISTO (READY) ✅');

    if (!getState().wppHandlersStarted) {
      setState({ wppHandlersStarted: true });
      try {
        console.log('[WPP SERVER] Iniciando handlers de texto...');
        await handlers.start(wppClient);
        console.log('[WPP SERVER] Handlers de texto iniciados correctamente.');
      } catch (e) {
        setState({ wppHandlersStarted: false });
        console.error('[WPP SERVER] Error iniciando handlers:', e);
      }
    } else {
      console.log('[WPP SERVER] Handlers ya estaban iniciados.');
    }

    try {
      const page = wppClient.pupPage;
      if (page && (typeof page.evaluate === 'function' || typeof page.evaluateOnNewDocument === 'function')) {
        if (typeof page.evaluate === 'function') {
          await page.evaluate(() => {
            try {
              if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                window.WWebJS.sendSeen = async () => {};
              }
            } catch {}
          });
        }

        if (typeof page.evaluateOnNewDocument === 'function') {
          await page.evaluateOnNewDocument(() => {
            try {
              if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                window.WWebJS.sendSeen = async () => {};
              }
            } catch {}
          });
        }

        console.log('[WPP SERVER] Parche WWebJS.sendSeen aplicado (no-op).');
      } else {
        console.warn('[WPP SERVER] No se encontró pupPage para parchear sendSeen.');
      }
    } catch (e) {
      console.warn('[WPP SERVER] No se pudo parchear WWebJS.sendSeen:', e);
    }
  });

  wppClient.on('disconnected', (reason) => {
    setState({ isConnected: false, isReadyWpp: false, wppHandlersStarted: false });
    console.log('[WPP SERVER] Desconectado. Razón:', reason);
    if (getState().isShuttingDownWpp) return;
    console.log('[WPP SERVER] Intentando reconectar después de desconexión...');
    scheduleInitWhatsApp(10000);
  });

  wppClient.on('message', handleIncomingMediaMessage);

  return { wppClient, isRender };
}
