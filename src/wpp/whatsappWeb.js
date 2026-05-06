// src/wpp/whatsappWeb.js
// WhatsApp Web (integrado) - extraído mecánicamente desde server.js

import { handleIncomingComprobanteFromBotPg } from '../transferenciasPipeline.js';
import { createIncomingMediaHandler } from './incomingMedia.js';
import { createOutboxProcessor } from './outboxProcessor.js';
import { createWppClientLifecycle } from './clientLifecycle.js';
import { registerWppRoutes } from './routes.js';
import { registerWppCronAndRoutes } from './cronRoutes.js';
import { WPP_SESSION_ID, limpiarLocksSesion as clearWppSessionLocks, safeErrorString, wait } from './sessionUtils.js';

export function registerWhatsAppWeb(app, deps) {
  const {
    ENABLE_WPP,
    Client,
    LocalAuth,
    qrcode,
    fs,
    path,
    __dirname,
    query,
    pool,
    handlers,
    enqueueWppMessage,
    checkLicencia,

    // estrategias (cron)
    ejecutarReposicionPredictiva,
    ejecutarCampaniaClima,
    ejecutarCampaniaBaseImportadaAuto,

    // auth helpers (usados en endpoints /api/whatsapp/*)
    withAuth,
    isSuper,
  } = deps || {};

  if (!app) throw new Error('registerWhatsAppWeb: falta app');
  if (typeof query !== 'function') throw new Error('registerWhatsAppWeb: falta query(fn)');

  // --------------------------------------------------
  // WHATSAPP WEB (Integrado)
  // --------------------------------------------------

  let lastQr = null;
  let isConnected = false;    // Para mostrar estado en /api/whatsapp/qr
  let isReadyWpp = false;     // 💡 Solo true cuando el cliente está realmente READY (outbox)
  let wppClient = null;
  let wppHandlersStarted = false;
  let isInitializingWpp = false;
  let isShuttingDownWpp = false;
  let initRetryTimer = null;

  const getState = () => ({
    lastQr,
    isConnected,
    isReadyWpp,
    wppClient,
    wppHandlersStarted,
    isInitializingWpp,
    isShuttingDownWpp,
    initRetryTimer,
  });

  const setState = (patch = {}) => {
    if ('lastQr' in patch) lastQr = patch.lastQr;
    if ('isConnected' in patch) isConnected = patch.isConnected;
    if ('isReadyWpp' in patch) isReadyWpp = patch.isReadyWpp;
    if ('wppClient' in patch) wppClient = patch.wppClient;
    if ('wppHandlersStarted' in patch) wppHandlersStarted = patch.wppHandlersStarted;
    if ('isInitializingWpp' in patch) isInitializingWpp = patch.isInitializingWpp;
    if ('isShuttingDownWpp' in patch) isShuttingDownWpp = patch.isShuttingDownWpp;
    if ('initRetryTimer' in patch) initRetryTimer = patch.initRetryTimer;
  };
  let initWhatsApp = async () => {
    console.warn('[WPP SERVER] initWhatsApp todavía no fue configurado.');
  };
  // Mapeo en memoria para resolver envíos cuando WhatsApp usa @lid
  const lidByPhone = new Map(); // key: últimos 10 dígitos, value: jid @lid

  const limpiarLocksSesion = () => clearWppSessionLocks({ fs, path, sessionId: WPP_SESSION_ID });

  const handleIncomingMediaMessage = createIncomingMediaHandler({
    query,
    lidByPhone,
    handleIncomingComprobanteFromBotPg,
  });

  const scheduleInitWhatsApp = (delayMs = 0) => {
    if (!ENABLE_WPP || !wppClient || isShuttingDownWpp) return;
    if (initRetryTimer) clearTimeout(initRetryTimer);
    initRetryTimer = setTimeout(() => {
      initRetryTimer = null;
      initWhatsApp().catch((err) => {
        console.error('[WPP SERVER] Error inesperado en init programado:', err);
      });
    }, delayMs);
  };

  if (ENABLE_WPP) {
    const { wppClient: createdClient, isRender } = createWppClientLifecycle({
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
    });

    wppClient = createdClient;

    initWhatsApp = async () => {
      if (!wppClient) return;
      if (isInitializingWpp) {
        console.log('[WPP SERVER] Inicialización WPP ya en curso. Se evita doble intento.');
        return;
      }

      isInitializingWpp = true;
      try {
        console.log('[WPP SERVER] Cliente WhatsApp inicializando...');
        await wppClient.initialize();
        console.log('[WPP SERVER] Cliente WhatsApp inicializado exitosamente.');
      } catch (err) {
        console.error('[WPP SERVER] Error inicializando cliente WhatsApp:', err);

        const msg = String(err?.message || '').toLowerCase();
        if (msg.includes('browser is already running')) {
          console.warn('[WPP SERVER] Detectado lock de navegador en sesión WPP. Limpiando locks y reintentando...');
          limpiarLocksSesion();
          scheduleInitWhatsApp(8000);
          return;
        }

        if (msg.includes('auth timeout')) {
          console.warn('[WPP SERVER] Auth timeout detectado. Reintentando inicialización en 15 segundos...');
          scheduleInitWhatsApp(15000);
          return;
        }

        if (isRender) {
          console.log('[WPP RENDER] Reintentando inicialización en 15 segundos...');
          scheduleInitWhatsApp(15000);
        }
      } finally {
        isInitializingWpp = false;
      }
    };

    scheduleInitWhatsApp(3000);

    const gracefulShutdownWpp = async (signal) => {
      if (!wppClient) return;
      try {
        isShuttingDownWpp = true;
        console.log(`[WPP SERVER] Apagado controlado por ${signal}. Cerrando cliente WPP...`);
        if (initRetryTimer) {
          clearTimeout(initRetryTimer);
          initRetryTimer = null;
        }
        await wppClient.destroy();
      } catch (e) {
        console.warn('[WPP SERVER] Error cerrando cliente WPP en shutdown:', e.message);
      }
    };

    process.once('SIGTERM', () => { gracefulShutdownWpp('SIGTERM'); });
    process.once('SIGINT', () => { gracefulShutdownWpp('SIGINT'); });
  } else {
    console.log('[WPP SERVER] WhatsApp deshabilitado en este entorno (ENABLE_WPP=0)');
  }

  registerWppRoutes(app, {
    ENABLE_WPP,
    qrcode,
    fs,
    path,
    query,
    withAuth,
    isSuper,
    getState,
    setState,
    getClient: () => wppClient,
    initWhatsApp,
    limpiarLocksSesion,
  });


  // --------------------------------------------------
  // FUNCIONES AUXILIARES PARA WHATSAPP
  // --------------------------------------------------

  // Función para reiniciar WhatsApp cuando hay errores graves
  async function reiniciarWhatsApp() {
    if (!wppClient) return;

    try {
      console.log('[WPP] Reiniciando cliente WhatsApp por error grave...');

      // Desconectar primero
      try {
        await wppClient.destroy();
      } catch (e) {
        console.warn('[WPP] Error al destruir cliente:', e.message);
      }

      // Resetear flags
      isConnected = false;
      isReadyWpp = false;
      lastQr = null;
      wppHandlersStarted = false;
      isShuttingDownWpp = false;

      // Esperar 5 segundos
      await wait(5000);

      // Re-inicializar con la misma rutina centralizada
      await initWhatsApp();

      console.log('[WPP] Cliente WhatsApp reinicializado.');

    } catch (e) {
      console.error('[WPP] Error en reinicio de WhatsApp:', e);
    }
  }

  // --------------------------------------------------
  // PROCESADOR DE COLA WHATSAPP (Outbox Loop) CORREGIDO
  // --------------------------------------------------

  const outboxProcessor = createOutboxProcessor({
    ENABLE_WPP,
    query,
    lidByPhone,
    safeErrorString,
    getClient: () => wppClient,
    getIsReady: () => isReadyWpp,
    getIsShuttingDown: () => isShuttingDownWpp,
    reiniciarWhatsApp,
  });


  // --- PROCESADOR DE COLA WHATSAPP (Outbox Loop) CORREGIDO ---
  if (ENABLE_WPP) {
    // Intervalo más inteligente: procesar solo si está conectado y no procesando
    setInterval(() => {
      outboxProcessor.releaseWatchdogIfStuck(45000);

      const { isProcessing } = outboxProcessor.getProcessingState();
      if (isReadyWpp && !isProcessing) {
        outboxProcessor.processOutbox();
      }
    }, 2500);

    // Log de estado periódico con métricas
    setInterval(async () => {
      if (ENABLE_WPP) {
        try {
          const pendingResult = await query(
            'SELECT COUNT(*) as count FROM wpp_outbox WHERE status = $1',
            ['pending']
          );
          const pendingCount = pendingResult[0]?.count || 0;

          const { isProcessing } = outboxProcessor.getProcessingState();
          console.log(`[WPP STATUS] Ready: ${isReadyWpp}, Processing: ${isProcessing}, Connected: ${isConnected}, Pending: ${pendingCount}`);
        } catch (e) {
          const { isProcessing } = outboxProcessor.getProcessingState();
          console.log(`[WPP STATUS] Ready: ${isReadyWpp}, Processing: ${isProcessing}, Connected: ${isConnected}`);
        }
      }
    }, 30000); // Cada 30 segundos
  }
  registerWppCronAndRoutes(app, {
    query,
    ejecutarReposicionPredictiva,
    ejecutarCampaniaClima,
    ejecutarCampaniaBaseImportadaAuto,
  });

}
