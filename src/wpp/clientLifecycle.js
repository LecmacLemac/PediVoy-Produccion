import { WPP_SESSION_ID, getWppSessionBasePath } from './sessionUtils.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ExposeStore } = require('whatsapp-web.js/src/util/Injected/Store');
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
const InterfaceController = require('whatsapp-web.js/src/util/InterfaceController');
const { ClientInfo } = require('whatsapp-web.js/src/structures');

export function createWppClientLifecycle({
  ENABLE_WPP,
  WPP_QR_ONLY = false,
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

  console.log(`[WPP SERVER] WhatsApp habilitado${WPP_QR_ONLY ? ' en modo solo QR' : ''}. Inicializando cliente...`);

  const isRender = process.env.RENDER === 'true';
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (isRender ? '/usr/bin/chromium' : null);
  const sessionBasePath = getWppSessionBasePath({ path });

  console.log(`[WPP SERVER] Usando ejecutable: ${executablePath || 'default'}`);
  console.log(`[WPP SERVER] En Render: ${isRender}`);
  console.log(`[WPP SERVER] Sesión LocalAuth en: ${sessionBasePath}`);

  const wppClient = new Client({
    authStrategy: new LocalAuth({ clientId: WPP_SESSION_ID, dataPath: sessionBasePath }),
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

  const startTextHandlersOnce = async (reason) => {
    if (WPP_QR_ONLY || getState().wppHandlersStarted) return;

    setState({ wppHandlersStarted: true });
    try {
      console.log(`[WPP SERVER] Iniciando handlers de texto (${reason})...`);
      await handlers.start(wppClient);
      console.log('[WPP SERVER] Handlers de texto iniciados correctamente.');
    } catch (e) {
      setState({ wppHandlersStarted: false });
      console.error('[WPP SERVER] Error iniciando handlers:', e);
    }
  };

  const isWhatsappRuntimeReady = async () => {
    try {
      const page = wppClient?.pupPage;
      if (!page || typeof page.evaluate !== 'function') return false;
      return Boolean(await page.evaluate(() => {
        try {
          return Boolean(window?.Store?.Chat && window?.Store?.Msg && window?.WWebJS);
        } catch {
          return false;
        }
      }));
    } catch {
      return false;
    }
  };

  let reinjectInProgress = false;

  const finishAuthenticatedRuntime = async () => {
    const page = wppClient?.pupPage;
    if (!page || typeof page.evaluate !== 'function') return false;

    const state = await page.evaluate(() => {
      try {
        return {
          synced: Boolean(window.AuthStore?.AppState?.hasSynced),
          store: Boolean(window.Store),
          wwebjs: Boolean(window.WWebJS),
        };
      } catch {
        return { synced: false, store: false, wwebjs: false };
      }
    });

    if (!state.synced) return false;

    if (!state.store) {
      await page.evaluate(ExposeStore);
    }

    let hasStore = false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30000) {
      hasStore = Boolean(await page.evaluate(() => {
        try {
          return Boolean(window.Store?.Chat && window.Store?.Msg && window.Store?.Conn);
        } catch {
          return false;
        }
      }));
      if (hasStore) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (!hasStore) return false;

    wppClient.info = new ClientInfo(wppClient, await page.evaluate(() => ({
      ...window.Store.Conn.serialize(),
      wid: window.Store.User.getMaybeMePnUser() || window.Store.User.getMaybeMeLidUser(),
    })));
    wppClient.interface = new InterfaceController(wppClient);
    await page.evaluate(LoadUtils);

    if (typeof wppClient.attachEventListeners === 'function') {
      await wppClient.attachEventListeners();
    }

    return isWhatsappRuntimeReady();
  };

  const reinjectAuthenticatedSession = async () => {
    if (reinjectInProgress) return;
    reinjectInProgress = true;
    try {
      console.warn('[WPP SERVER] WhatsApp Web está conectado pero falta WWebJS; reinyectando runtime...');
      await wppClient.inject();
      await wppClient.pupPage?.evaluate(() => {
        try {
          if (window.AuthStore?.AppState?.hasSynced && typeof window.onAppStateHasSyncedEvent === 'function') {
            window.onAppStateHasSyncedEvent();
          }
        } catch {}
      });
      if (!(await isWhatsappRuntimeReady())) {
        console.warn('[WPP SERVER] Completando runtime WWebJS desde sesión ya sincronizada...');
        await finishAuthenticatedRuntime();
      }
    } catch (e) {
      console.warn('[WPP SERVER] No se pudo reinyectar runtime WWebJS:', e?.message || e);
    } finally {
      reinjectInProgress = false;
    }
  };

  const promoteAuthenticatedToReadyIfNeeded = () => {
    setTimeout(async () => {
      const state = getState();
      if (WPP_QR_ONLY || state.isReadyWpp || !state.isConnected || state.isShuttingDownWpp) return;

      const runtimeReady = await isWhatsappRuntimeReady();
      if (!runtimeReady) {
        console.warn('[WPP SERVER] READY no llegó y runtime WWebJS aún no está operativo; se vuelve a chequear en breve.');
        await reinjectAuthenticatedSession();
        promoteAuthenticatedToReadyIfNeeded();
        return;
      }

      console.warn('[WPP SERVER] READY no llegó después de autenticación; runtime WWebJS operativo, se habilita modo operativo.');
      setState({ isReadyWpp: true, lastQr: null });
      await startTextHandlersOnce('authenticated-fallback');
    }, 8000);
  };

  wppClient.on('qr', (qr) => {
    setState({ lastQr: qr, isConnected: false, isReadyWpp: false });
    console.log('[WPP SERVER] QR RECIBIDO. Escanea para conectar.');
  });

  wppClient.on('authenticated', async () => {
    setState({ isConnected: true, isReadyWpp: false, lastQr: null });
    console.log('[WPP SERVER] Autenticado ✅');
    promoteAuthenticatedToReadyIfNeeded();
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

    if (!WPP_QR_ONLY && !getState().wppHandlersStarted) {
      await startTextHandlersOnce('ready');
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

  if (!WPP_QR_ONLY) {
    wppClient.on('message', handleIncomingMediaMessage);
  } else {
    console.log('[WPP SERVER] Modo solo QR activo: no se atienden mensajes entrantes.');
  }

  return { wppClient, isRender };
}
