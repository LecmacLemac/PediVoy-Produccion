import { WPP_SESSION_ID, wait } from './sessionUtils.js';

export function registerWppRoutes(app, deps) {
  const {
    ENABLE_WPP,
    qrcode,
    fs,
    path,
    query,
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

  app.get('/api/whatsapp/qr', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).send('<h1>⛔ Acceso Denegado</h1>');
    if (!ENABLE_WPP) return res.status(503).send('WhatsApp deshabilitado en este entorno');

    const { isConnected, lastQr } = getState();
    if (isConnected) return res.send('<h2 style="color:green">Conectado ✅</h2>');
    if (!lastQr) return res.send('<h2>Cargando QR... espera la consola</h2>');

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

      try {
        await query(`
          UPDATE wpp_outbox
          SET status = 'skipped',
              error  = 'Descartado por reset de sesión de WhatsApp'
          WHERE status = 'pending'
        `);
        console.log('[WPP SERVER] Cola wpp_outbox limpiada (pending -> skipped).');
      } catch (e) {
        console.warn('[WPP SERVER] No se pudo limpiar wpp_outbox en reset:', e.message);
      }

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
        const sessionDir = path.join(process.cwd(), '.wwebjs_auth', `session-${WPP_SESSION_ID}`);
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
