import { randomUUID } from 'crypto';
import { wait } from './sessionUtils.js';
import { buildEmpresaWppFallbackCondition } from './fallbackPolicy.js';
import {
  claimWppOutboxRows,
  ensureWppDeliverySchema,
  finishWppOutboxClaim,
  releaseWppOutboxClaim,
  resolveWhatsappTarget,
} from './delivery.js';

export function createOutboxProcessor({
  ENABLE_WPP,
  query,
  lidByPhone,
  safeErrorString,
  getClient,
  getIsReady,
  getIsShuttingDown,
  reiniciarWhatsApp,
  claimOwner = `general-${process.pid}-${randomUUID()}`,
}) {
  let isProcessing = false;
  let schemaReady = false;

  async function ensureSchema() {
    if (schemaReady) return;
    await ensureWppDeliverySchema(query);
    schemaReady = true;
  }

  async function releaseRemaining(rows, startIndex) {
    for (const remaining of rows.slice(startIndex)) {
      await releaseWppOutboxClaim({ query, id: remaining.id, owner: claimOwner, error: null });
    }
  }

  async function processOutbox() {
    if (!ENABLE_WPP || !getIsReady() || isProcessing || !getClient()) return;

    isProcessing = true;

    try {
      await ensureSchema();
      const cleanupResult = await query(`
        UPDATE wpp_outbox
        SET status = 'skipped',
            error = 'Caducado - Más de 1 día en cola',
            claim_owner = NULL,
            claim_until = NULL
        WHERE status = 'pending'
          AND (claim_until IS NULL OR claim_until < NOW())
          AND created_at < NOW() - INTERVAL '1 day'
        RETURNING id
      `);

      if (cleanupResult.length > 0) {
        console.log(`[WPP CLEANUP] ✅ Limpiados ${cleanupResult.length} mensajes viejos (>1 día)`);
      }

      const rows = await claimWppOutboxRows({
        query,
        owner: claimOwner,
        limit: 3,
        whereSql: `
          AND o.created_at > NOW() - INTERVAL '1 day'
          ${buildEmpresaWppFallbackCondition()}
        `,
      });

      if (!rows.length) return;
      console.log(`[DEBUG OUTBOX] Procesando ${rows.length} mensajes pendientes...`);

      for (const [index, row] of rows.entries()) {
        if (!getIsReady() || !getClient() || getIsShuttingDown()) {
          await releaseWppOutboxClaim({
            query,
            id: row.id,
            owner: claimOwner,
            error: 'WhatsApp general pausado antes del envío',
          });
          await releaseRemaining(rows, index + 1);
          console.warn('[WPP OUTBOX] WPP no está listo durante el lote. Se liberaron los claims restantes.');
          break;
        }

        let sendStarted = false;
        try {
          const raw = String(row.telefono || '').trim();
          const digits = raw.includes('@') ? raw.split('@')[0].replace(/\D+/g, '') : raw.replace(/\D+/g, '');
          const normalizedDigits = digits.length === 10 ? `549${digits}` : digits;
          const cachedLid = normalizedDigits ? lidByPhone.get(normalizedDigits.slice(-10)) : null;
          const client = getClient();
          const chatId = await resolveWhatsappTarget(client, cachedLid || raw);

          try {
            const chatPromise = client.getChatById(chatId).catch(() => null);
            const chatTimeout = new Promise(resolve => setTimeout(() => resolve(null), 4000));
            const chat = await Promise.race([chatPromise, chatTimeout]);
            if (!chat) console.warn(`[WPP OUTBOX] Chat no encontrado/timeout: ${chatId}, continuando con envío directo`);
          } catch {}

          console.log(`[DEBUG OUTBOX] Enviando ID:${row.id} a ${chatId}...`);
          sendStarted = true;
          const sendPromise = client.sendMessage(chatId, row.mensaje);
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => {
            const error = new Error('Timeout enviando a WPP');
            error.code = 'WPP_SEND_TIMEOUT';
            reject(error);
          }, 8000));
          await Promise.race([sendPromise, timeoutPromise]);

          await finishWppOutboxClaim({ query, id: row.id, owner: claimOwner, status: 'sent', sent: true });
          console.log(`[DEBUG OUTBOX] ✅ Mensaje ID:${row.id} enviado con éxito.`);
          await wait(index > 0 && index % 3 === 0 ? 1500 : 700);
        } catch (err) {
          const errorMessage = String(err?.message || err);
          const errorLower = errorMessage.toLowerCase();
          console.error(`[WPP OUTBOX] Error ID:${row.id} tel:${row.telefono}:`, errorMessage);

          if (!sendStarted) {
            const invalidTarget = errorLower.includes('telefono_invalido') || errorLower.includes('jid_invalido');
            if (invalidTarget) {
              await finishWppOutboxClaim({
                query, id: row.id, owner: claimOwner, status: 'error', error: 'Número de teléfono inválido',
              });
            } else {
              await releaseWppOutboxClaim({
                query, id: row.id, owner: claimOwner, error: 'Reintento por error previo al envío',
              });
            }
            continue;
          }

          if (err?.code === 'WPP_SEND_TIMEOUT') {
            await finishWppOutboxClaim({
              query,
              id: row.id,
              owner: claimOwner,
              status: 'error',
              error: 'Resultado de envío desconocido por timeout; requiere revisión manual',
            });
            await releaseRemaining(rows, index + 1);
            break;
          }

          const isConnectionError = ['not connected', 'disconnected', 'closed', 'websocket'].some(value => errorLower.includes(value));
          const isFrameDetached = errorLower.includes('detached frame') || errorLower.includes('frame detached');
          const isTransientBrowserError = [
            'execution context was destroyed', 'runtime.callfunctionon', 'target closed', 'session closed',
            'protocol error', "reading 'getchat'", 'reading "getchat"',
          ].some(value => errorLower.includes(value));
          const isPhoneError = ['invalid', 'phone', 'number', 'chat_no_encontrado', 'telefono_invalido'].some(value => errorLower.includes(value));
          const isSeenBug = errorMessage.includes('markedUnread') || errorLower.includes('sendseen');

          if (isFrameDetached || isTransientBrowserError) {
            await releaseWppOutboxClaim({ query, id: row.id, owner: claimOwner, error: 'Reintento por reconexión WPP' });
            await releaseRemaining(rows, index + 1);
            await reiniciarWhatsApp();
            break;
          }
          if (isConnectionError) {
            await releaseWppOutboxClaim({ query, id: row.id, owner: claimOwner, error: 'WhatsApp reconectando' });
            await releaseRemaining(rows, index + 1);
            break;
          }
          if (isSeenBug) {
            await finishWppOutboxClaim({
              query, id: row.id, owner: claimOwner, status: 'sent', sent: true,
              error: 'Bug sendSeen (marcado como enviado)',
            });
          } else if (isPhoneError) {
            await finishWppOutboxClaim({
              query, id: row.id, owner: claimOwner, status: 'error', error: 'Número de teléfono inválido',
            });
          } else {
            await finishWppOutboxClaim({
              query, id: row.id, owner: claimOwner, status: 'error', error: safeErrorString(errorMessage),
            });
          }
          await wait(1500);
        }
      }
    } catch (e) {
      console.error('[WPP OUTBOX] Error general en processOutbox:', e);
    } finally {
      isProcessing = false;
    }
  }

  return {
    processOutbox,
    getProcessingState() {
      return { isProcessing };
    },
  };
}
