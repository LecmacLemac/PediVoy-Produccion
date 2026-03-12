// src/wpp/whatsappWeb.js
// WhatsApp Web (integrado) - extraído mecánicamente desde server.js

import { handleIncomingComprobanteFromBotPg } from '../transferenciasPipeline.js';

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

  // Candados para evitar dobles reset accidentales
  let isResetInProgress = false;
  let lastResetAt = 0;
  const RESET_COOLDOWN_MS = 15000;

  if (ENABLE_WPP) {
    console.log('[WPP SERVER] WhatsApp habilitado. Inicializando cliente...');

    // Configuración especial para Render
    const isRender = process.env.RENDER === 'true';
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
                          (isRender ? '/usr/bin/chromium' : null);

    console.log(`[WPP SERVER] Usando ejecutable: ${executablePath || 'default'}`);
    console.log(`[WPP SERVER] En Render: ${isRender}`);

    wppClient = new Client({
      authStrategy: new LocalAuth({
        clientId: 'server_session_hidro'
      }),
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.x.html',
      },
      puppeteer: {
        headless: "new",  // Usar el nuevo headless mode
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=VizDisplayCompositor',
          '--window-size=1920,1080',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--use-gl=egl',
          '--disable-software-rasterizer',
          '--ignore-certificate-errors',
          '--ignore-certificate-errors-spki-list'
        ],
        executablePath: executablePath,
        ignoreHTTPSErrors: true,
        timeout: 60000  // Aumentar timeout para Render
      }
    });

    // --- Eventos base de conexión --- //
    wppClient.on('qr', (qr) => {
      lastQr = qr;
      isConnected = false;
      isReadyWpp = false;
      console.log('[WPP SERVER] QR RECIBIDO. Escanea para conectar.');
    });

    wppClient.on('authenticated', async () => {
      isConnected = true;
      isReadyWpp = false;
      lastQr = null;
      console.log('[WPP SERVER] Autenticado ✅');

      // Forzamos el inicio de handlers aquí por si 'ready' no llega
      if (!wppHandlersStarted) {
        wppHandlersStarted = true;
        try {
          console.log('[WPP SERVER] Iniciando handlers preventivamente (authenticated)...');
          await handlers.start(wppClient);
          console.log('[WPP SERVER] Handlers iniciados preventivamente.');
        } catch (e) {
          wppHandlersStarted = false;
          console.error('[WPP SERVER] Error en handlers preventivos:', e);
        }
      }
    });

    wppClient.on('auth_failure', (msg) => {
      console.error('[WPP SERVER] Falla de auth:', msg);
      // Intentar reiniciar si falla la autenticación
      setTimeout(() => {
        if (wppClient) {
          console.log('[WPP SERVER] Reintentando después de auth failure...');
          wppClient.initialize().catch(console.error);
        }
      }, 5000);
    });

    // 👇 Debug extra para ver qué pasa en Render
    wppClient.on('change_state', (state) => {
      console.log('[WPP SERVER] Estado cliente WPP:', state);
    });

    wppClient.on('loading_screen', (percent, message) => {
      console.log('[WPP SERVER] Cargando WhatsApp Web:', percent, '% -', message);
    });

    wppClient.on('error', (err) => {
      console.error('[WPP SERVER] ERROR cliente WPP:', err);

      // Reiniciar en caso de errores críticos
      if (err.message && (
        err.message.includes('closed') ||
        err.message.includes('disconnected') ||
        err.message.includes('Protocol error')
      )) {
        console.log('[WPP SERVER] Error crítico detectado, reiniciando en 10 segundos...');
        setTimeout(reiniciarWhatsApp, 10000);
      }
    });

    wppClient.on('ready', async () => {
      isConnected = true;
      isReadyWpp = true;
      lastQr = null;
      console.log('[WPP SERVER] CLIENTE LISTO (READY) ✅');

      // Iniciar handlers en READY para asegurar que el cliente puede recibir mensajes
      if (!wppHandlersStarted) {
        wppHandlersStarted = true;
        try {
          console.log('[WPP SERVER] Iniciando handlers de texto...');
          await handlers.start(wppClient);
          console.log('[WPP SERVER] Handlers de texto iniciados correctamente.');
        } catch (e) {
          wppHandlersStarted = false;
          console.error('[WPP SERVER] Error iniciando handlers:', e);
        }
      } else {
        console.log('[WPP SERVER] Handlers ya estaban iniciados.');
      }

      // ──────────────────────────────────────────────
      // PARCHE: desactivar WWebJS.sendSeen en el navegador
      // para evitar el bug "markedUnread" de whatsapp-web.js
      // ──────────────────────────────────────────────
      try {
        const page = wppClient.pupPage;

        if (page && (typeof page.evaluate === 'function' || typeof page.evaluateOnNewDocument === 'function')) {
          // 1) Parche para esta sesión actual
          if (typeof page.evaluate === 'function') {
            await page.evaluate(() => {
              try {
                if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                  window.WWebJS.sendSeen = async () => {
                    // sendSeen desactivado intencionalmente para evitar bug markedUnread
                  };
                }
              } catch (e) {
                // ignorar errores dentro del contexto del navegador
              }
            });
          }

          // 2) Parche futuro: si whatsapp-web.js reinyecta scripts,
          //    esto ayuda a que ya arranquen con sendSeen no-op.
          if (typeof page.evaluateOnNewDocument === 'function') {
            await page.evaluateOnNewDocument(() => {
              try {
                if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                  window.WWebJS.sendSeen = async () => {
                    // sendSeen desactivado intencionalmente para evitar bug markedUnread
                  };
                }
              } catch (e) {
                // ignorar errores dentro del contexto del navegador
              }
            });
          }

          console.log('[WPP SERVER] Parche WWebJS.sendSeen aplicado (no-op).');
        } else {
          console.warn('[WPP SERVER] No se encontró pupPage para parchear sendSeen.');
        }
      } catch (e) {
        console.warn('[WPP SERVER] No se pudo parchear WWebJS.sendSeen:', e);
      }

      // 👇 Ya NO iniciamos handlers acá.
      // Se inician en "authenticated" para que el bot funcione
      // aunque "ready" nunca llegue a dispararse.
    });

    wppClient.on('disconnected', (reason) => {
      isConnected = false;
      isReadyWpp = false;
      console.log('[WPP SERVER] Desconectado. Razón:', reason);

      // Intentar reconectar automáticamente
      setTimeout(() => {
        if (wppClient) {
          console.log('[WPP SERVER] Intentando reconectar después de desconexión...');
          wppClient.initialize().catch(console.error);
        }
      }, 10000);
    });

    // 2. LISTENER DE MEDIA (Transferencias)
    wppClient.on('message', async (msg) => {
      console.log(`[DEBUG WPP] Evento 'message' detectado en server.js desde: ${msg.from}`);
      try {
        // 🛑 FIX CRÍTICO: Ignorar Estados/Historias de WhatsApp
        if (msg.from === 'status@broadcast' || msg.isStatus) {
          return;
        }

        // 1. Solo chats individuales
        if (msg.from.includes('@g.us')) {
          return;
        }

        // 2. Filtramos mensajes propios
        if (msg.fromMe || msg.id?.fromMe) return;

        const t = String(msg.type || '').toLowerCase();
        // Detectar si es imagen o documento (PDF)
        const isMedia = (msg.hasMedia || t === 'image' || t === 'document');

        console.log('[WPP IN]', {
          from: msg.from,
          type: t,
          hasMedia: !!msg.hasMedia,
          isMedia,
          id: msg.id?._serialized || null
        });

        if (isMedia) {
          const rawFromDigits = String(msg.from || '').replace(/\D/g, '');
          let telefonoLimpio = rawFromDigits;

          if (String(msg.from || '').includes('@lid')) {
            try {
              const contact = await msg.getContact();
              const contactDigits = String(contact?.number || contact?.id?.user || '').replace(/\D/g, '');
              if (contactDigits) telefonoLimpio = contactDigits;
              console.log('[WPP MEDIA] Resolución @lid', {
                from: msg.from,
                rawFromDigits,
                contactDigits: contactDigits || null,
                usado: telefonoLimpio || null
              });
            } catch (e) {
              console.warn('[WPP MEDIA] No se pudo resolver número para @lid:', e?.message || e);
            }
          }

          const clienteQuery = await query(
            `SELECT id FROM puntos_entrega
             WHERE telefono_normalizado LIKE '%' || $1
             LIMIT 1`,
            [telefonoLimpio.slice(-10)]
          );

          if (clienteQuery.length === 0) {
            console.log(`[WPP MEDIA] Ignorado: El número ${msg.from} no es un cliente registrado.`);
            return;
          }

          console.log(`[WPP MEDIA] Recibido archivo de cliente registrado: ${msg.from} tipo=${t}`);

          const media = await msg.downloadMedia().catch(err => {
            console.error('[WPP MEDIA] Error descargando:', err.message);
            return null;
          });

          if (!media) {
            console.warn('[WPP MEDIA] downloadMedia devolvió null');
            return;
          }

          const buffer = Buffer.from(media.data, 'base64');
          console.log('[WPP MEDIA] Archivo descargado', {
            mimetype: media.mimetype,
            filename: media.filename || null,
            bytes: buffer.length
          });

          const result = await handleIncomingComprobanteFromBotPg({
            type: t,
            telefono: msg.from,
            buffer: buffer,
            base64: media.data,
            mimetype: media.mimetype,
            filename: media.filename || msg.body?.slice(0, 20) || 'archivo'
          });

          console.log('[WPP MEDIA] Resultado pipeline comprobante', {
            from: msg.from,
            ok: !!result?.ok,
            reason: result?.reason || null,
            error: result?.error || null,
            id: result?.id || null
          });
        }
      } catch (e) {
        console.error('[WPP SERVER] Error global mensaje:', e);
      }
    });

    // Función mejorada de reinicio para Render
    async function reiniciarWhatsAppParaRender() {
      if (!wppClient) return;

      try {
        console.log('[WPP RENDER] Reiniciando WhatsApp para Render...');

        // Resetear flags
        isConnected = false;
        isReadyWpp = false;
        lastQr = null;
        wppHandlersStarted = false;

        // Cerrar sesión limpia
        try {
          await wppClient.destroy();
        } catch (e) {
          console.warn('[WPP RENDER] Error al destruir cliente:', e.message);
        }

        // Esperar para evitar flood
        await new Promise(r => setTimeout(r, 5000));

        // Re-inicializar
        await wppClient.initialize();

        console.log('[WPP RENDER] WhatsApp reinicializado exitosamente.');

      } catch (e) {
        console.error('[WPP RENDER] Error en reinicio:', e);
        // Intentar nuevamente en 30 segundos si falla
        setTimeout(reiniciarWhatsAppParaRender, 30000);
      }
    }

    // Inicializar cliente WPP con mejor manejo de errores para Render
    const initWhatsApp = async () => {
      try {
        console.log('[WPP SERVER] Cliente WhatsApp inicializando...');
        await wppClient.initialize();
        console.log('[WPP SERVER] Cliente WhatsApp inicializado exitosamente.');
      } catch (err) {
        console.error('[WPP SERVER] Error inicializando cliente WhatsApp:', err);

        // En Render, reintentar después de un tiempo
        if (isRender) {
          console.log('[WPP RENDER] Reintentando inicialización en 15 segundos...');
          setTimeout(initWhatsApp, 15000);
        }
      }
    };

    // Iniciar con retraso para dar tiempo al servidor
    setTimeout(initWhatsApp, 3000);

  } else {
    console.log('[WPP SERVER] WhatsApp deshabilitado en este entorno (ENABLE_WPP=0)');
  }

  // Endpoint para ver el QR
  app.get('/api/whatsapp/qr', withAuth, async (req, res) => {
    // 1. Validación de seguridad
    if (!isSuper(req)) {
      return res.status(403).send('<h1>⛔ Acceso Denegado</h1>');
    }

    if (!ENABLE_WPP) {
      return res.status(503).send('WhatsApp deshabilitado en este entorno');
    }

    if (isConnected) return res.send('<h2 style="color:green">Conectado ✅</h2>');
    if (!lastQr) return res.send('<h2>Cargando QR... espera la consola</h2>');

    try {
      const url = await qrcode.toDataURL(lastQr);
      res.send(`<img src="${url}" />`);
    } catch {
      res.status(500).send('Error QR');
    }
  });

  // RESET DE SESIÓN WHATSAPP (+ limpieza de cola para evitar spam)
  app.post('/api/whatsapp/reset', withAuth, async (req, res) => {
    if (!ENABLE_WPP) {
      return res.status(503).json({ error: 'WhatsApp deshabilitado en este entorno' });
    }

    // Solo super admin por seguridad
    if (!isSuper(req)) {
      return res.status(403).json({ error: 'Solo SUPER ADMIN puede resetear la sesión de WhatsApp' });
    }

    // Evitar doble click / retrys / llamadas en paralelo
    if (isResetInProgress) {
      return res.status(202).json({ ok: true, skipped: true, reason: 'reset_in_progress' });
    }

    const now = Date.now();
    if (now - lastResetAt < RESET_COOLDOWN_MS) {
      return res.status(202).json({ ok: true, skipped: true, reason: 'cooldown' });
    }

    isResetInProgress = true;
    lastResetAt = now;

    try {
      console.log('[WPP SERVER] Reset de sesión solicitado por', req.user?.id || 'unknown');

      // 0) LIMPIAR COLA: descartar todos los pendientes para que no salgan masivamente
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

      // 1) Intentar logout (si está conectado)
      try {
        if (wppClient) {
          await wppClient.logout();
        }
      } catch (e) {
        console.warn('[WPP SERVER] Error en logout (puede no estar logueado):', e.message);
      }

      // 2) Borrar carpeta de sesión de LocalAuth (coincide con clientId: 'server_session_hidro')
      try {
        const sessionDir = path.join(__dirname, '.wwebjs_auth', 'server_session_hidro');
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log('[WPP SERVER] Carpeta de sesión eliminada:', sessionDir);
      } catch (e) {
        console.warn('[WPP SERVER] No se pudo borrar carpeta de sesión:', e.message);
      }

      // 3) Resetear flags y re-inicializar para que dispare un nuevo QR
      lastQr = null;
      isConnected = false;
      isReadyWpp = false;

      try {
        if (wppClient) {
          await wppClient.initialize();
        }
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

      // Esperar 5 segundos
      await new Promise(r => setTimeout(r, 5000));

      // Re-inicializar
      await wppClient.initialize();

      console.log('[WPP] Cliente WhatsApp reinicializado.');

    } catch (e) {
      console.error('[WPP] Error en reinicio de WhatsApp:', e);
    }
  }

  // Función segura para escapar strings para SQL
  function safeErrorString(err) {
    if (!err) return null;
    const str = String(err)
      .replace(/'/g, "''")  // Escapar comillas simples para PostgreSQL
      .replace(/\\/g, "\\\\")  // Escapar backslashes
      .slice(0, 200);
    return str;
  }

  // --------------------------------------------------
  // PROCESADOR DE COLA WHATSAPP (Outbox Loop) CORREGIDO
  // --------------------------------------------------

  let isProcessing = false; // 🔒 Semáforo para evitar superposición

  async function processOutbox() {
    // 👇 AHORA chequeamos isReadyWpp en lugar de solo isConnected
    if (!ENABLE_WPP || !isReadyWpp || isProcessing || !wppClient) return;

    isProcessing = true;

    try {
      // ========== LIMPIEZA AUTOMÁTICA: MENSAJES > 1 DÍA ==========
      const cleanupResult = await query(`
        UPDATE wpp_outbox
        SET status = 'skipped',
            error = 'Caducado - Más de 1 día en cola'
        WHERE status = 'pending'
          AND created_at < NOW() - INTERVAL '1 day'
        RETURNING id
      `);

      if (cleanupResult.length > 0) {
        console.log(`[WPP CLEANUP] ✅ Limpiados ${cleanupResult.length} mensajes viejos (>1 día)`);
      }
      // ===========================================================

      const rows = await query(`
        SELECT id, telefono, mensaje
        FROM wpp_outbox
        WHERE status = 'pending'
          AND created_at > NOW() - INTERVAL '1 day'  -- Solo últimos 1 día
        ORDER BY id ASC
        LIMIT 3
      `);

      if (!rows.length) {
        return; // el finally igual va a resetear isProcessing
      }

      console.log(`[DEBUG OUTBOX] Procesando ${rows.length} mensajes pendientes...`);

      for (const row of rows) {
        let chatId = null;
        let errorMessage = null;

        try {
          // -------------------------
          // 1) Normalizar teléfono
          // -------------------------
          let rawPhone = String(row.telefono || '').trim();

          // Por si en algún flujo quedó guardado como "549...@c.us"
          if (rawPhone.includes('@')) {
            rawPhone = rawPhone.split('@')[0];
          }

          const numeroBase = rawPhone.replace(/\D+/g, '');
          if (!numeroBase) {
            throw new Error('telefono_invalido');
          }

          // Verificar formato internacional
          let phoneToUse = numeroBase;
          if (phoneToUse.startsWith('9') && phoneToUse.length === 10) {
            phoneToUse = '549' + phoneToUse; // Argentina
          }

          chatId = `${phoneToUse}@c.us`;

          // -------------------------
          // 2) Validar si el chat existe (opcional)
          // -------------------------
          try {
            const chat = await wppClient.getChatById(chatId).catch(() => null);
            if (!chat) {
              console.warn(`[WPP OUTBOX] Chat no encontrado: ${chatId}, marcando como error`);
              throw new Error('chat_no_encontrado');
            }
          } catch (chatErr) {
            // Continuamos igual, WhatsApp puede crear el chat al enviar
          }

          // -------------------------
          // 3) Enviar con timeout
          // -------------------------
          console.log(`[DEBUG OUTBOX] Enviando ID:${row.id} a ${chatId}...`);
          const sendPromise = wppClient.sendMessage(chatId, row.mensaje);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout enviando a WPP')), 8000)
          );

          await Promise.race([sendPromise, timeoutPromise]);
          console.log(`[DEBUG OUTBOX] ✅ Mensaje ID:${row.id} enviado con éxito.`);

          // Si no explota, marcamos como enviado
          await query(
            `UPDATE wpp_outbox
             SET status = 'sent',
                 sent_at = NOW(),
                 error = NULL
             WHERE id = $1`,
            [row.id]
          );

          // -------------------------
          // 4) Pausa inteligente anti-flood
          // -------------------------
          const index = rows.indexOf(row);
          if (index > 0 && index % 3 === 0) {
            console.log('[WPP OUTBOX] Pausa anti-flood: 1.5 segundos...');
            await new Promise(r => setTimeout(r, 1500));
          } else {
            await new Promise(r => setTimeout(r, 700)); // Pausa normal
          }

        } catch (err) {
          errorMessage = String(err && err.message ? err.message : err);
          const errorLower = errorMessage.toLowerCase();

          // Detectar errores críticos
          const isConnectionError =
            errorLower.includes('not connected') ||
            errorLower.includes('disconnected') ||
            errorLower.includes('closed') ||
            errorLower.includes('websocket');

          const isFrameDetached =
            errorLower.includes('detached frame') ||
            errorLower.includes('frame detached');

          const isPhoneError =
            errorLower.includes('invalid') ||
            errorLower.includes('phone') ||
            errorLower.includes('number') ||
            errorLower.includes('chat_no_encontrado') ||
            errorLower.includes('telefono_invalido');

          // BUG conocido de whatsapp-web.js
          const isSeenBug =
            errorMessage.includes('markedUnread') ||
            errorLower.includes('sendseen');

          console.error(`[WPP OUTBOX] Error ID:${row.id} tel:${row.telefono}:`, errorMessage);

          // Preparar mensaje de error seguro
          const errorSafe = safeErrorString(errorMessage);
          let statusToSet = 'error';
          let finalError = errorSafe;

          if (isFrameDetached) {
            // ERROR CRÍTICO: Frame detached - WhatsApp necesita reinicio completo
            console.error('[WPP OUTBOX] ❌ Frame detached - WhatsApp necesita reinicio');
            finalError = 'WhatsApp desconectado (frame detached)';
            statusToSet = 'error';

            // Marcar el mensaje como error primero
            await query(
              `UPDATE wpp_outbox
               SET status = $1,
                   error = $2
               WHERE id = $3`,
              [statusToSet, finalError, row.id]
            );

            // Luego reiniciar WhatsApp
            await reiniciarWhatsApp();
            break; // Salir del loop completamente

          } else if (isConnectionError) {
            // Error de conexión
            finalError = 'WhatsApp desconectado';
            statusToSet = 'error';
            await query(
              `UPDATE wpp_outbox
               SET status = $1,
                   error = $2
               WHERE id = $3`,
              [statusToSet, finalError, row.id]
            );
            console.error('[WPP OUTBOX] ❌ WhatsApp desconectado, deteniendo procesamiento...');
            break;

          } else if (isSeenBug) {
            // Bug sendSeen: marcar como enviado pero con advertencia
            console.warn(`[WPP OUTBOX] Bug sendSeen ID:${row.id} -> marcado como enviado`);
            statusToSet = 'sent';
            finalError = 'Bug sendSeen (marcado como enviado)';
            await query(
              `UPDATE wpp_outbox
               SET status = $1,
                   sent_at = COALESCE(sent_at, NOW()),
                   error = $2
               WHERE id = $3`,
              [statusToSet, finalError, row.id]
            );

          } else if (isPhoneError) {
            // Número inválido
            console.error(`[WPP OUTBOX] Número inválido ID:${row.id} -> marcado como error`);
            statusToSet = 'error';
            finalError = 'Número de teléfono inválido';
            await query(
              `UPDATE wpp_outbox
               SET status = $1,
                   error = $2
               WHERE id = $3`,
              [statusToSet, finalError, row.id]
            );

          } else {
            // Error genérico
            console.error(`[WPP OUTBOX] Error genérico ID:${row.id}: ${errorMessage}`);
            statusToSet = 'error';
            await query(
              `UPDATE wpp_outbox
               SET status = $1,
                   error = $2
               WHERE id = $3`,
              [statusToSet, errorSafe, row.id]
            );
          }

          // Pausa más larga después de error
          await new Promise(r => setTimeout(r, 1500));
        }
      }

    } catch (e) {
      console.error('[WPP OUTBOX] Error general en processOutbox:', e);
    } finally {
      isProcessing = false; // Se libera siempre
    }
  }

  // --- PROCESAMIENTO DE COLA (Cada 2.5 segundos cuando esté conectado) ---
  // Evitar doble inicialización: si ya existe cliente WPP, no volver a crearlo.
  if (ENABLE_WPP && !wppClient) {
    console.log('[WPP SERVER] WhatsApp habilitado. Inicializando cliente...');

    // DETECCIÓN DE ENTORNO
    const isRender = process.env.RENDER === 'true';

    // EN RENDER: usar Chromium del sistema
    // EN LOCAL: usar Chrome instalado
    let puppeteerConfig = {
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    };

    if (isRender) {
      console.log('[WPP RENDER] Usando Chromium del sistema...');
      // Render Docker: usar Chromium del sistema o variable explícita
      puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
      puppeteerConfig.args.push(
        '--disable-features=VizDisplayCompositor',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--use-gl=egl',
        '--disable-software-rasterizer'
      );
    } else {
      console.log('[WPP LOCAL] Usando Chrome instalado localmente...');
      // En local, usar Chrome instalado por puppeteer
      puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
    }

    wppClient = new Client({
      authStrategy: new LocalAuth({
        clientId: isRender ? 'server_session_hidro_render' : 'server_session_hidro'
      }),
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.x.html',
      },
      puppeteer: puppeteerConfig
    });

    // --- Eventos base de conexión --- //
    wppClient.on('qr', (qr) => {
      lastQr = qr;
      isConnected = false;
      isReadyWpp = false;
      console.log('[WPP SERVER] QR RECIBIDO. Escanea para conectar.');
    });

    wppClient.on('authenticated', async () => {
      isConnected = true;
      isReadyWpp = false;
      lastQr = null;
      console.log('[WPP SERVER] Autenticado ✅');

      // Forzamos el inicio de handlers aquí por si 'ready' no llega
      if (!wppHandlersStarted) {
        wppHandlersStarted = true;
        try {
          console.log('[WPP SERVER] Iniciando handlers preventivamente (authenticated)...');
          await handlers.start(wppClient);
          console.log('[WPP SERVER] Handlers iniciados preventivamente.');
        } catch (e) {
          wppHandlersStarted = false;
          console.error('[WPP SERVER] Error en handlers preventivos:', e);
        }
      }
    });

    wppClient.on('auth_failure', (msg) => {
      console.error('[WPP SERVER] Falla de auth:', msg);
    });

    // 👇 Debug extra para ver qué pasa en Render
    wppClient.on('change_state', (state) => {
      console.log('[WPP SERVER] Estado cliente WPP:', state);
    });

    wppClient.on('loading_screen', (percent, message) => {
      console.log('[WPP SERVER] Cargando WhatsApp Web:', percent, '% -', message);
    });

    wppClient.on('error', (err) => {
      console.error('[WPP SERVER] ERROR cliente WPP:', err);
    });

    wppClient.on('ready', async () => {
      isConnected = true;
      isReadyWpp = true;
      lastQr = null;
      console.log('[WPP SERVER] CLIENTE LISTO (READY) ✅');

      // Iniciar handlers en READY para asegurar que el cliente puede recibir mensajes
      if (!wppHandlersStarted) {
        wppHandlersStarted = true;
        try {
          console.log('[WPP SERVER] Iniciando handlers de texto...');
          await handlers.start(wppClient);
          console.log('[WPP SERVER] Handlers de texto iniciados correctamente.');
        } catch (e) {
          wppHandlersStarted = false;
          console.error('[WPP SERVER] Error iniciando handlers:', e);
        }
      } else {
        console.log('[WPP SERVER] Handlers ya estaban iniciados.');
      }

      // ──────────────────────────────────────────────
      // PARCHE: desactivar WWebJS.sendSeen en el navegador
      // para evitar el bug "markedUnread" de whatsapp-web.js
      // ──────────────────────────────────────────────
      try {
        const page = wppClient.pupPage;

        if (page && (typeof page.evaluate === 'function' || typeof page.evaluateOnNewDocument === 'function')) {
          // 1) Parche para esta sesión actual
          if (typeof page.evaluate === 'function') {
            await page.evaluate(() => {
              try {
                if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                  window.WWebJS.sendSeen = async () => {
                    // sendSeen desactivado intencionalmente para evitar bug markedUnread
                  };
                }
              } catch (e) {
                // ignorar errores dentro del contexto del navegador
              }
            });
          }

          // 2) Parche futuro: si whatsapp-web.js reinyecta scripts,
          //    esto ayuda a que ya arranquen con sendSeen no-op.
          if (typeof page.evaluateOnNewDocument === 'function') {
            await page.evaluateOnNewDocument(() => {
              try {
                if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                  window.WWebJS.sendSeen = async () => {
                    // sendSeen desactivado intencionalmente para evitar bug markedUnread
                  };
                }
              } catch (e) {
                // ignorar errores dentro del contexto del navegador
              }
            });
          }

          console.log('[WPP SERVER] Parche WWebJS.sendSeen aplicado (no-op).');
        } else {
          console.warn('[WPP SERVER] No se encontró pupPage para parchear sendSeen.');
        }
      } catch (e) {
        console.warn('[WPP SERVER] No se pudo parchear WWebJS.sendSeen:', e);
      }

      // 👇 Ya NO iniciamos handlers acá.
      // Se inician en "authenticated" para que el bot funcione
      // aunque "ready" nunca llegue a dispararse.
    });

    wppClient.on('disconnected', (reason) => {
      isConnected = false;
      isReadyWpp = false;
      console.log('[WPP SERVER] Desconectado. Razón:', reason);
    });

    // 2. LISTENER DE MEDIA (Transferencias)
    wppClient.on('message', async (msg) => {
      console.log(`[DEBUG WPP] Evento 'message' detectado en server.js desde: ${msg.from}`);
      try {
        // 🛑 FIX CRÍTICO: Ignorar Estados/Historias de WhatsApp
        if (msg.from === 'status@broadcast' || msg.isStatus) {
          return;
        }

        // 1. Solo chats individuales
        if (msg.from.includes('@g.us')) {
          return;
        }

        // 2. Filtramos mensajes propios
        if (msg.fromMe || msg.id?.fromMe) return;

        const t = String(msg.type || '').toLowerCase();
        // Detectar si es imagen o documento (PDF)
        const isMedia = (msg.hasMedia || t === 'image' || t === 'document');

        console.log('[WPP IN]', {
          from: msg.from,
          type: t,
          hasMedia: !!msg.hasMedia,
          isMedia,
          id: msg.id?._serialized || null
        });

        if (isMedia) {
          const rawFromDigits = String(msg.from || '').replace(/\D/g, '');
          let telefonoLimpio = rawFromDigits;

          if (String(msg.from || '').includes('@lid')) {
            try {
              const contact = await msg.getContact();
              const contactDigits = String(contact?.number || contact?.id?.user || '').replace(/\D/g, '');
              if (contactDigits) telefonoLimpio = contactDigits;
              console.log('[WPP MEDIA] Resolución @lid', {
                from: msg.from,
                rawFromDigits,
                contactDigits: contactDigits || null,
                usado: telefonoLimpio || null
              });
            } catch (e) {
              console.warn('[WPP MEDIA] No se pudo resolver número para @lid:', e?.message || e);
            }
          }

          const clienteQuery = await query(
            `SELECT id FROM puntos_entrega 
             WHERE telefono_normalizado LIKE '%' || $1 
             LIMIT 1`,
            [telefonoLimpio.slice(-10)]
          );

          if (clienteQuery.length === 0) {
            console.log(`[WPP MEDIA] Ignorado: El número ${msg.from} no es un cliente registrado.`);
            return;
          }

          console.log(`[WPP MEDIA] Recibido archivo de cliente registrado: ${msg.from} tipo=${t}`);

          const media = await msg.downloadMedia().catch(err => {
            console.error('[WPP MEDIA] Error descargando:', err.message);
            return null;
          });

          if (!media) {
            console.warn('[WPP MEDIA] downloadMedia devolvió null');
            return;
          }

          const buffer = Buffer.from(media.data, 'base64');
          console.log('[WPP MEDIA] Archivo descargado', {
            mimetype: media.mimetype,
            filename: media.filename || null,
            bytes: buffer.length
          });

          const result = await handleIncomingComprobanteFromBotPg({
            type: t,
            telefono: msg.from,
            buffer: buffer,
            base64: media.data,
            mimetype: media.mimetype,
            filename: media.filename || msg.body?.slice(0, 20) || 'archivo'
          });

          console.log('[WPP MEDIA] Resultado pipeline comprobante', {
            from: msg.from,
            ok: !!result?.ok,
            reason: result?.reason || null,
            error: result?.error || null,
            id: result?.id || null
          });
        }
      } catch (e) {
        console.error('[WPP SERVER] Error global mensaje:', e);
      }
    });
  
    // Inicializar cliente WPP con catch para no tumbar el servidor si falla
    wppClient.initialize()
      .then(() => {
        console.log('[WPP SERVER] Cliente WhatsApp inicializando...');
      })
      .catch(err => {
        console.error('[WPP SERVER] Error inicializando cliente WhatsApp:', err);
      });

  } else {
    console.log('[WPP SERVER] WhatsApp deshabilitado en este entorno (ENABLE_WPP=0)');
  }

  // --- PROCESADOR DE COLA WHATSAPP (Outbox Loop) CORREGIDO ---
  if (ENABLE_WPP) {
    // Intervalo más inteligente: procesar solo si está conectado y no procesando
    setInterval(() => {
      if (isReadyWpp && !isProcessing) {
        processOutbox();
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

          console.log(`[WPP STATUS] Ready: ${isReadyWpp}, Processing: ${isProcessing}, Connected: ${isConnected}, Pending: ${pendingCount}`);
        } catch (e) {
          console.log(`[WPP STATUS] Ready: ${isReadyWpp}, Processing: ${isProcessing}, Connected: ${isConnected}`);
        }
      }
    }, 30000); // Cada 30 segundos
  }
  // --- 2. MAYORDOMO IA (Diario a las 09:00 AM) ---

  const ARG_UTC_OFFSET = -3;

  function programarTareaDiaria(horaArgentina, minuto, tarea) {
    const ahora = new Date();
    const proximaEjecucion = new Date(ahora);

    // Convertir hora Argentina -> hora UTC
    // Si AR = UTC-3, entonces UTC = AR + 3
    const diferenciaHoras = -ARG_UTC_OFFSET; // 3
    const horaUTC = (horaArgentina + diferenciaHoras + 24) % 24;

    // Configurar la próxima ejecución en UTC
    proximaEjecucion.setUTCHours(horaUTC, minuto, 0, 0);

    // Si la hora ya pasó hoy (en UTC), programar para mañana
    if (proximaEjecucion <= ahora) {
      proximaEjecucion.setUTCDate(proximaEjecucion.getUTCDate() + 1);
    }

    const tiempoHastaEjecucion = proximaEjecucion.getTime() - ahora.getTime();

    console.log(
      '[CRON] Tarea diaria programada para (ARG):',
      proximaEjecucion.toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires'
      })
    );

    // Esperar hasta la hora indicada, ejecutar y luego repetir cada 24h
    setTimeout(() => {
      tarea();
      setInterval(tarea, 24 * 60 * 60 * 1000);
    }, tiempoHastaEjecucion);
  }

  // --- 3. AUDITORÍA DE LICENCIAS (Diario) ---
  programarTareaDiaria(4, 0, async () => { // Ejecutar a las 04:00 AM
    console.log('[CRON] Verificando licencias vencidas...');

    try {
      // 1. Marcar como 'expired' las que vencieron ayer
      const expired = await query(`
        UPDATE empresas
        SET plan_estado = 'expired'
        WHERE plan_estado = 'active'
          AND plan_vencimiento < NOW()
        RETURNING id
      `);

      if (expired.length > 0) {
        console.log(`[CRON] Se vencieron ${expired.length} licencias hoy (pasaron a estado 'expired').`);
      }

      // 2. ELIMINAR EMPRESAS muertas hace más de 180 días (6 meses)
      const dead = await query(`
        DELETE FROM empresas
        WHERE plan_vencimiento < (NOW() - INTERVAL '180 days')
        RETURNING id, nombre
      `);

      if (dead.length > 0) {
        console.log(`[CRON] 💀 LIMPIEZA TOTAL: Se eliminaron ${dead.length} empresas abandonadas hace >6 meses.`);
        dead.forEach(d => console.log(` - Eliminada: ID ${d.id} (${d.nombre})`));
      } else {
        console.log('[CRON] Limpieza: No hay empresas antiguas para eliminar hoy.');
      }

    } catch (e) {
      console.error('[CRON ERROR] Falló la auditoría de licencias:', e);
    }
  });

  // Iniciar la programación (ej: 09:00 AM)
  programarTareaDiaria(9, 0, () => {
    if (typeof ejecutarReposicionPredictiva !== 'function') return;
    console.log('[CRON] Ejecutando Reposición Predictiva...');
    ejecutarReposicionPredictiva().catch(err => console.error('[CRON ERROR]', err));
  });

  // Campaña por clima (media mañana y tarde)
  programarTareaDiaria(11, 0, () => {
    if (typeof ejecutarCampaniaClima !== 'function') return;
    console.log('[CRON] Ejecutando Campaña por Clima...');
    ejecutarCampaniaClima().catch(err => console.error('[CRON ERROR CLIMA]', err));
  });

  programarTareaDiaria(17, 0, () => {
    if (typeof ejecutarCampaniaClima !== 'function') return;
    console.log('[CRON] Ejecutando Campaña por Clima...');
    ejecutarCampaniaClima().catch(err => console.error('[CRON ERROR CLIMA]', err));
  });

  const requireCronSecret = (req, res) => {
    const cronSecret = String(process.env.CRON_SECRET || '').trim();
    if (!cronSecret) {
      return res.status(503).json({ error: 'cron_secret_not_configured' });
    }
    if (String(req.headers['x-cron-secret'] || '') !== cronSecret) {
      return res.status(403).json({ error: 'forbidden' });
    }
    return null;
  };

  // CRON: Limpieza diaria de puntos de tracking antiguos
  app.post('/internal/cron/cleanup-tracking', async (req, res) => {
    const authError = requireCronSecret(req, res);
    if (authError) return authError;

    try {
      console.log('[CRON CLEANUP] Iniciando limpieza de tracking…');

      const deleted = await query(`
        DELETE FROM pedido_track_points ptk
        USING pedidos p
        WHERE ptk.pedido_id = p.id
          AND p.estado = 'entregado'
          AND ptk."timestamp" < NOW() - INTERVAL '1 day'
        RETURNING ptk.id
      `);

      console.log(`[CRON CLEANUP] Puntos de tracking borrados: ${deleted.length}`);
      return res.json({ ok: true, deleted: deleted.length });
    } catch (err) {
      console.error('cleanup-tracking ERROR', err);
      return res.status(500).json({ error: 'error' });
    }
  });

  // CRON: Limpieza de mensajes viejos de WhatsApp (sent/error/skipped > 7 días)
  app.post('/internal/cron/cleanup-wpp', async (req, res) => {
    const authError = requireCronSecret(req, res);
    if (authError) return authError;

    try {
      console.log('[CRON CLEANUP WPP] Iniciando limpieza de wpp_outbox…');

      const deleted = await query(`
        DELETE FROM wpp_outbox
        WHERE status IN ('sent', 'error', 'skipped')
          AND created_at < NOW() - INTERVAL '7 days'
        RETURNING id
      `);

      const count = deleted.length;

      if (count > 0) {
        console.log(`[CRON CLEANUP WPP] Se borraron ${count} mensajes viejos de WhatsApp.`);
      } else {
        console.log('[CRON CLEANUP WPP] No había mensajes para borrar.');
      }

      return res.json({ ok: true, deleted: count });
    } catch (err) {
      console.error('cleanup-wpp ERROR', err);
      return res.status(500).json({ error: 'error al limpiar wpp' });
    }
  });

}
