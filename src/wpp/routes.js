import { WPP_SESSION_ID, getWppSessionDir, wait } from './sessionUtils.js';

export function registerWppRoutes(app, deps) {
  const {
    ENABLE_WPP,
    WPP_QR_ONLY = false,
    qrcode,
    fs,
    path,
    withAuth,
    isSuper,
    getState,
    setState,
    getClient,
    initWhatsApp,
    limpiarLocksSesion,
  } = deps;

  let isResetInProgress = false;
  let lastResetAt = 0;
  const RESET_COOLDOWN_MS = 15000;

  app.get('/api/whatsapp/status', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Solo SUPER ADMIN' });

    const state = getState();
    return res.json({
      ok: true,
      enabled: Boolean(ENABLE_WPP),
      qr_only: Boolean(WPP_QR_ONLY),
      connected: Boolean(state.isConnected),
      ready: Boolean(state.isReadyWpp),
      initializing: Boolean(state.isInitializingWpp),
      shutting_down: Boolean(state.isShuttingDownWpp),
      has_qr: Boolean(state.lastQr),
      reset_in_progress: Boolean(isResetInProgress),
      session_id: WPP_SESSION_ID,
      message: ENABLE_WPP
        ? (state.isConnected
            ? 'WhatsApp general conectado.'
            : (state.lastQr ? 'QR general disponible para escanear.' : 'WhatsApp general inicializando o esperando QR.'))
        : 'WhatsApp general deshabilitado. En local levantá con ENABLE_WPP=1.',
    });
  });

  app.get('/api/whatsapp/qr', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).send('<h1>⛔ Acceso Denegado</h1>');
    if (!ENABLE_WPP) {
      return res
        .status(503)
        .send('<h2>WhatsApp general deshabilitado</h2><p>En local levantá el server con ENABLE_WPP=1 npm start o npm run start:qr.</p>');
    }

    const { isConnected, isInitializingWpp, lastQr } = getState();
    if (isConnected) {
      return res.send(`<h2 style="color:green">Conectado ✅${WPP_QR_ONLY ? ' · modo solo QR' : ''}</h2>`);
    }
    if (!lastQr) {
      const msg = isInitializingWpp
        ? 'Inicializando WhatsApp general...'
        : 'Cargando QR... espera la consola';
      return res.send(`<h2>${msg}</h2><p>${WPP_QR_ONLY ? 'Modo solo QR activo.' : 'Worker general activo.'}</p>`);
    }

    try {
      const url = await qrcode.toDataURL(lastQr);
      res.send(`<img src="${url}" />`);
    } catch {
      res.status(500).send('Error QR');
    }
  });

  app.post('/api/whatsapp/reset', withAuth, async (req, res) => {
    if (!ENABLE_WPP) return res.status(503).json({ error: 'WhatsApp deshabilitado en este entorno' });
    if (!isSuper(req)) return res.status(403).json({ error: 'Solo SUPER ADMIN puede resetear la sesión de WhatsApp' });
    if (isResetInProgress) return res.status(202).json({ ok: true, skipped: true, reason: 'reset_in_progress' });

    const now = Date.now();
    if (now - lastResetAt < RESET_COOLDOWN_MS) {
      return res.status(202).json({ ok: true, skipped: true, reason: 'cooldown' });
    }

    isResetInProgress = true;
    lastResetAt = now;

    try {
      console.log('[WPP SERVER] Reset de sesión solicitado por', req.user?.id || 'unknown');
      console.log('[WPP SERVER] Los mensajes pendientes se preservan para reintento tras reconexión.');

      try {
        const client = getClient();
        if (client) {
          await client.destroy();
          console.log('[WPP SERVER] Cliente WPP destruido para reset seguro.');
        }
      } catch (e) {
        console.warn('[WPP SERVER] Error destruyendo cliente WPP en reset:', e.message);
      }

      await wait(1500);

      try {
        const sessionDir = getWppSessionDir({ path, sessionId: WPP_SESSION_ID });
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log('[WPP SERVER] Carpeta de sesión eliminada:', sessionDir);
      } catch (e) {
        console.warn('[WPP SERVER] No se pudo borrar carpeta de sesión:', e.message);
      }

      limpiarLocksSesion();

      setState({
        lastQr: null,
        isConnected: false,
        isReadyWpp: false,
        wppHandlersStarted: false,
      });

      try {
        if (getClient()) await initWhatsApp();
      } catch (e) {
        console.warn('[WPP SERVER] Error re-inicializando cliente WPP:', e.message);
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error('[WPP SERVER] Error general en reset de sesión:', e);
      return res.status(500).json({ error: 'No se pudo resetear la sesión de WhatsApp' });
    } finally {
      isResetInProgress = false;
    }
  });
}
