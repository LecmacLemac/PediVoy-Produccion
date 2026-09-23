import { wait } from './sessionUtils.js';
import {
  claimWppOutboxRows,
  ensureWppDeliverySchema,
  finishWppOutboxClaim,
  releaseWppOutboxClaim,
  resolveWhatsappTarget,
  startWppOutboxDelivery,
} from './delivery.js';

export function createOutboxProcessor({
  ENABLE_WPP,
  query,
  lidByPhone,
  safeErrorString,
  getClient,
  getIsReady,
  getIsShuttingDown,
  requestRestart,
  withActiveClient,
}) {
  if (typeof withActiveClient !== 'function') {
    throw new TypeError('withActiveClient is required for General outbox processing');
  }
  let isProcessing = false;
  let schemaReady = false;

  async function ensureSchema() {
    if (schemaReady) return;
    await ensureWppDeliverySchema(query);
    schemaReady = true;
  }

  async function releaseRemaining(rows, startIndex, token) {
    for (const remaining of rows.slice(startIndex)) {
      await releaseWppOutboxClaim({
        query, id: remaining.id, owner: token.ownerId, epoch: token.epoch, error: null,
      });
    }
  }

  async function useActiveClient(token, fn) {
    return withActiveClient(({ client, ownerId: activeOwnerId, epoch: activeEpoch }) => {
      if (activeOwnerId !== token.ownerId || String(activeEpoch) !== String(token.epoch)) {
        throw Object.assign(new Error('General ownership token changed'), { code: 'WPP_NOT_OWNER' });
      }
      return fn(client);
    });
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
            claim_epoch = NULL,
            claim_until = NULL
        WHERE status = 'pending'
          AND (transport_origin = 'general'
            OR (transport_origin IS NULL AND empresa_id IS NULL))
          AND (claim_until IS NULL OR claim_until < NOW())
          AND created_at < NOW() - INTERVAL '1 day'
        RETURNING id
      `);

      if (cleanupResult.length > 0) {
        console.log(`[WPP CLEANUP] ✅ Limpiados ${cleanupResult.length} mensajes viejos (>1 día)`);
      }

      const claimToken = await withActiveClient(({ ownerId, epoch }) => {
        if (!ownerId || epoch === null || epoch === undefined) {
          throw Object.assign(new Error('General ownership token is unavailable'), { code: 'WPP_NOT_OWNER' });
        }
        return Object.freeze({ ownerId, epoch });
      });
      const rows = await claimWppOutboxRows({
        query,
        owner: claimToken.ownerId,
        epoch: claimToken.epoch,
        limit: 3,
        whereSql: `
          AND o.created_at > NOW() - INTERVAL '1 day'
          AND (o.transport_origin = 'general'
            OR (o.transport_origin IS NULL AND o.empresa_id IS NULL))
        `,
      });

      if (!rows.length) return;
      console.log(`[DEBUG OUTBOX] Procesando ${rows.length} mensajes pendientes...`);

      for (const [index, row] of rows.entries()) {
        if (!getIsReady() || !getClient() || getIsShuttingDown()) {
          await releaseWppOutboxClaim({
            query,
            id: row.id,
            owner: claimToken.ownerId,
            epoch: claimToken.epoch,
            error: 'WhatsApp general pausado antes del envío',
          });
          await releaseRemaining(rows, index + 1, claimToken);
          console.warn('[WPP OUTBOX] WPP no está listo durante el lote. Se liberaron los claims restantes.');
          break;
        }

        let transportInvoked = false;
        try {
          const raw = String(row.telefono || '').trim();
          const isFullJid = /^[^\s@]+@(c\.us|lid)$/i.test(raw);
          const digits = isFullJid ? '' : raw.replace(/\D+/g, '');
          const normalizedDigits = digits.length === 10 ? `549${digits}` : digits;
          const cachedLid = normalizedDigits ? lidByPhone.get(normalizedDigits.slice(-10)) : null;
          const chatId = await useActiveClient(
            claimToken,
            client => resolveWhatsappTarget(client, isFullJid ? raw : (cachedLid || raw)),
          );

          try {
            const chat = await useActiveClient(claimToken, async client => {
              let timeoutId;
              try {
                return await Promise.race([
                  client.getChatById(chatId).catch(() => null),
                  new Promise(resolve => { timeoutId = setTimeout(() => resolve(null), 4000); }),
                ]);
              } finally {
                if (timeoutId) clearTimeout(timeoutId);
              }
            });
            if (!chat) console.warn(`[WPP OUTBOX] Chat no encontrado/timeout: ${chatId}, continuando con envío directo`);
          } catch (error) {
            if (error?.code === 'WPP_NOT_OWNER') throw error;
          }

          console.log(`[DEBUG OUTBOX] Enviando ID:${row.id} a ${chatId}...`);
          await startWppOutboxDelivery({
            query,
            id: row.id,
            owner: claimToken.ownerId,
            epoch: claimToken.epoch,
          });
          await useActiveClient(claimToken, async client => {
            let timeoutId;
            try {
              transportInvoked = true;
              const transport = client.sendMessage(chatId, row.mensaje);
              return await Promise.race([
                transport,
                new Promise((_, reject) => {
                  timeoutId = setTimeout(() => {
                    const error = new Error('Timeout enviando a WPP');
                    error.code = 'WPP_SEND_TIMEOUT';
                    reject(error);
                  }, 8000);
                }),
              ]);
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
            }
          });

          await finishWppOutboxClaim({
            query,
            id: row.id,
            owner: claimToken.ownerId,
            epoch: claimToken.epoch,
            status: 'sent',
            sent: true,
          });
          console.log(`[DEBUG OUTBOX] ✅ Mensaje ID:${row.id} enviado con éxito.`);
          await wait(index > 0 && index % 3 === 0 ? 1500 : 700);
        } catch (err) {
          const errorMessage = String(err?.message || err);
          const errorLower = errorMessage.toLowerCase();
          console.error(`[WPP OUTBOX] Error ID:${row.id} tel:${row.telefono}:`, errorMessage);

          if (!transportInvoked) {
            const invalidTarget = errorLower.includes('telefono_invalido') || errorLower.includes('jid_invalido');
            if (invalidTarget) {
              await finishWppOutboxClaim({
                query,
                id: row.id,
                owner: claimToken.ownerId,
                epoch: claimToken.epoch,
                status: 'error',
                error: 'Número de teléfono inválido',
              });
            } else {
              await releaseWppOutboxClaim({
                query,
                id: row.id,
                owner: claimToken.ownerId,
                epoch: claimToken.epoch,
                error: 'Reintento por error previo al envío',
              });
            }
            if (err?.code === 'WPP_NOT_OWNER') {
              await releaseRemaining(rows, index + 1, claimToken);
              break;
            }
            continue;
          }

          const isFrameDetached = errorLower.includes('detached frame') || errorLower.includes('frame detached');
          const isTransientBrowserError = [
            'execution context was destroyed', 'runtime.callfunctionon', 'target closed', 'session closed',
            'protocol error', "reading 'getchat'", 'reading "getchat"',
          ].some(value => errorLower.includes(value));
          const isSeenBug = errorMessage.includes('markedUnread') || errorLower.includes('sendseen');
          const unknownError = err?.code === 'WPP_SEND_TIMEOUT'
            ? 'Resultado de envío desconocido por timeout; requiere revisión manual'
            : 'Resultado de envío desconocido; requiere revisión manual';

          await finishWppOutboxClaim({
            query,
            id: row.id,
            owner: claimToken.ownerId,
            epoch: claimToken.epoch,
            status: isSeenBug ? 'sent' : 'error',
            sent: isSeenBug,
            error: isSeenBug ? 'Bug sendSeen (marcado como enviado)' : safeErrorString(unknownError),
          });
          await releaseRemaining(rows, index + 1, claimToken);
          if (isFrameDetached || isTransientBrowserError) await requestRestart();
          break;
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
