import { wait } from './sessionUtils.js';

export function createOutboxProcessor({ ENABLE_WPP, query, lidByPhone, safeErrorString, getClient, getIsReady, getIsShuttingDown, reiniciarWhatsApp }) {
  let isProcessing = false;
  let processingStartedAt = 0;

  async function processOutbox() {
    if (!ENABLE_WPP || !getIsReady() || isProcessing || !getClient()) return;

    isProcessing = true;
    processingStartedAt = Date.now();

    try {
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

      const rows = await query(`
        SELECT id, telefono, mensaje
        FROM wpp_outbox
        WHERE status = 'pending'
          AND created_at > NOW() - INTERVAL '1 day'
        ORDER BY id ASC
        LIMIT 3
      `);

      if (!rows.length) return;

      console.log(`[DEBUG OUTBOX] Procesando ${rows.length} mensajes pendientes...`);

      for (const row of rows) {
        let chatId = null;
        let errorMessage = null;

        if (!getIsReady() || !getClient() || getIsShuttingDown()) {
          console.warn('[WPP OUTBOX] WPP no está listo durante el lote. Se pausa el procesamiento.');
          break;
        }

        try {
          let rawPhone = String(row.telefono || '').trim();
          if (rawPhone.includes('@')) rawPhone = rawPhone.split('@')[0];

          const numeroBase = rawPhone.replace(/\D+/g, '');
          if (!numeroBase) throw new Error('telefono_invalido');

          let phoneToUse = numeroBase;
          if (phoneToUse.length === 10) {
            phoneToUse = `549${phoneToUse}`;
          }

          const key10 = phoneToUse.slice(-10);
          const cachedLid = lidByPhone.get(key10);
          chatId = cachedLid || `${phoneToUse}@c.us`;
          if (cachedLid) {
            console.log(`[WPP OUTBOX] Usando chat @lid cacheado para ${key10}: ${chatId}`);
          }

          try {
            const client = getClient();
            const chatPromise = client.getChatById(chatId).catch(() => null);
            const chatTimeout = new Promise((resolve) => setTimeout(() => resolve(null), 4000));
            const chat = await Promise.race([chatPromise, chatTimeout]);
            if (!chat) {
              console.warn(`[WPP OUTBOX] Chat no encontrado/timeout: ${chatId}, continuando con envío directo`);
            }
          } catch {}

          console.log(`[DEBUG OUTBOX] Enviando ID:${row.id} a ${chatId}...`);
          const client = getClient();
          const sendPromise = client.sendMessage(chatId, row.mensaje);
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout enviando a WPP')), 8000));

          await Promise.race([sendPromise, timeoutPromise]);
          console.log(`[DEBUG OUTBOX] ✅ Mensaje ID:${row.id} enviado con éxito.`);

          await query(
            `UPDATE wpp_outbox
             SET status = 'sent',
                 sent_at = NOW(),
                 error = NULL
             WHERE id = $1`,
            [row.id]
          );

          const index = rows.indexOf(row);
          if (index > 0 && index % 3 === 0) {
            console.log('[WPP OUTBOX] Pausa anti-flood: 1.5 segundos...');
            await wait(1500);
          } else {
            await wait(700);
          }
        } catch (err) {
          errorMessage = String(err && err.message ? err.message : err);
          const errorLower = errorMessage.toLowerCase();

          const isConnectionError =
            errorLower.includes('not connected') ||
            errorLower.includes('disconnected') ||
            errorLower.includes('closed') ||
            errorLower.includes('websocket');

          const isFrameDetached =
            errorLower.includes('detached frame') ||
            errorLower.includes('frame detached');

          const isTransientBrowserError =
            errorLower.includes('execution context was destroyed') ||
            errorLower.includes('runtime.callfunctionon') ||
            errorLower.includes('target closed') ||
            errorLower.includes('session closed') ||
            errorLower.includes('protocol error');

          const isPhoneError =
            errorLower.includes('invalid') ||
            errorLower.includes('phone') ||
            errorLower.includes('number') ||
            errorLower.includes('chat_no_encontrado') ||
            errorLower.includes('telefono_invalido');

          const isSeenBug = errorMessage.includes('markedUnread') || errorLower.includes('sendseen');

          console.error(`[WPP OUTBOX] Error ID:${row.id} tel:${row.telefono}:`, errorMessage);

          const errorSafe = safeErrorString(errorMessage);
          let statusToSet = 'error';
          let finalError = errorSafe;

          if (isFrameDetached || isTransientBrowserError) {
            console.error('[WPP OUTBOX] ⚠️ Contexto Puppeteer inestable. Se reintentará el mensaje tras reinicio/reconexión.');
            await query(
              `UPDATE wpp_outbox
               SET status = 'pending',
                   error = $1
               WHERE id = $2`,
              ['Reintento por reconexión WPP', row.id]
            );
            await reiniciarWhatsApp();
            break;
          } else if (isConnectionError) {
            await query(
              `UPDATE wpp_outbox
               SET status = 'pending',
                   error = $1
               WHERE id = $2`,
              ['WhatsApp reconectando', row.id]
            );
            console.error('[WPP OUTBOX] ❌ WhatsApp desconectado, se mantiene pending para reintento.');
            break;
          } else if (isSeenBug) {
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
            console.error(`[WPP OUTBOX] Error genérico ID:${row.id}: ${errorMessage}`);
            await query(
              `UPDATE wpp_outbox
               SET status = $1,
                   error = $2
               WHERE id = $3`,
              [statusToSet, errorSafe, row.id]
            );
          }

          await wait(1500);
        }
      }
    } catch (e) {
      console.error('[WPP OUTBOX] Error general en processOutbox:', e);
    } finally {
      isProcessing = false;
      processingStartedAt = 0;
    }
  }

  return {
    processOutbox,
    getProcessingState() {
      return { isProcessing, processingStartedAt };
    },
    releaseWatchdogIfStuck(maxMs = 45000) {
      if (isProcessing && processingStartedAt && (Date.now() - processingStartedAt > maxMs)) {
        console.warn(`[WPP OUTBOX] Watchdog liberó lock de procesamiento (>${Math.floor(maxMs / 1000)}s).`);
        isProcessing = false;
        processingStartedAt = 0;
      }
    },
  };
}
