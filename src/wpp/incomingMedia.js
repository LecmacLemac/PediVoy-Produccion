const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function downloadMediaWithRetry(msg, { attempts = 3, delayMs = 1500 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const media = await msg.downloadMedia();
      if (media?.data) {
        if (attempt > 1) {
          console.log('[WPP MEDIA] Descarga recuperada en reintento', { attempt });
        }
        return media;
      }

      console.warn('[WPP MEDIA] downloadMedia sin datos', {
        attempt,
        messageId: msg.id?._serialized || null,
        type: msg.type || null,
        hasMedia: !!msg.hasMedia,
      });
    } catch (err) {
      lastError = err;
      console.error('[WPP MEDIA] Error descargando', {
        attempt,
        message: err?.message || String(err),
        name: err?.name || null,
        stack: err?.stack || null,
        messageId: msg.id?._serialized || null,
        type: msg.type || null,
        hasMedia: !!msg.hasMedia,
      });
    }

    if (attempt < attempts) await wait(delayMs);
  }

  if (lastError) {
    console.warn('[WPP MEDIA] downloadMedia agotó reintentos', {
      message: lastError?.message || String(lastError),
      messageId: msg.id?._serialized || null,
    });
  }

  return null;
}

export function createIncomingMediaHandler({ query, lidByPhone, handleIncomingComprobanteFromBotPg }) {
  return async function handleIncomingMediaMessage(msg) {
    console.log(`[DEBUG WPP] Evento 'message' detectado en server.js desde: ${msg.from}`);
    try {
      if (msg.from === 'status@broadcast' || msg.isStatus) return;
      if (msg.from.includes('@g.us')) return;
      if (msg.fromMe || msg.id?.fromMe) return;

      const t = String(msg.type || '').toLowerCase();
      const isMedia = msg.hasMedia || t === 'image' || t === 'document';

      console.log('[WPP IN]', {
        from: msg.from,
        type: t,
        hasMedia: !!msg.hasMedia,
        isMedia,
        id: msg.id?._serialized || null,
      });

      if (!isMedia) return;

      const rawFromDigits = String(msg.from || '').replace(/\D/g, '');
      let telefonoLimpio = rawFromDigits;

      if (String(msg.from || '').includes('@lid')) {
        try {
          const contact = await msg.getContact();
          const contactDigits = String(contact?.number || contact?.id?.user || '').replace(/\D/g, '');
          if (contactDigits) telefonoLimpio = contactDigits;
          const key10 = String(telefonoLimpio || '').replace(/\D/g, '').slice(-10);
          if (key10 && String(msg.from || '').includes('@lid')) {
            lidByPhone.set(key10, String(msg.from));
          }
          console.log('[WPP MEDIA] Resolución @lid', {
            from: msg.from,
            rawFromDigits,
            contactDigits: contactDigits || null,
            usado: telefonoLimpio || null,
            lidCacheKey: key10 || null,
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

      const media = await downloadMediaWithRetry(msg);

      if (!media) {
        console.warn('[WPP MEDIA] downloadMedia devolvió null');
        return;
      }

      const buffer = Buffer.from(media.data, 'base64');
      console.log('[WPP MEDIA] Archivo descargado', {
        mimetype: media.mimetype,
        filename: media.filename || null,
        bytes: buffer.length,
      });

      const result = await handleIncomingComprobanteFromBotPg({
        type: t,
        telefono: telefonoLimpio,
        telefono_jid: msg.from,
        buffer,
        base64: media.data,
        mimetype: media.mimetype,
        filename: media.filename || msg.body?.slice(0, 20) || 'archivo',
      });

      console.log('[WPP MEDIA] Resultado pipeline comprobante', {
        from: msg.from,
        ok: !!result?.ok,
        reason: result?.reason || null,
        error: result?.error || null,
        id: result?.id || null,
        pedido_id: result?.pedido_id || null,
      });

      console.log(`[AUDIT COMPROBANTE] jid=${String(msg.from || '-')} tel=${String(telefonoLimpio || '-')} pedido=${String(result?.pedido_id ?? '-')} comp=${String(result?.id ?? '-')} ok=${result?.ok ? 1 : 0}`);
    } catch (e) {
      console.error('[WPP SERVER] Error global mensaje:', e);
    }
  };
}
