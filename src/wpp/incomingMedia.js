const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function inferSerializedMessageId(msg) {
  const id = msg?.id || msg?._data?.id;
  if (!id || typeof id !== 'object') return null;
  if (id._serialized) return id._serialized;
  if (!id.id) return null;

  const fromMe = typeof id.fromMe === 'boolean' ? id.fromMe : !!msg?.fromMe;
  const remote = typeof id.remote === 'string'
    ? id.remote
    : id.remote?._serialized || msg?.from || msg?._data?.from;

  if (!remote) return null;

  const participant = typeof id.participant === 'string'
    ? id.participant
    : id.participant?._serialized || null;

  return participant
    ? `${fromMe}_${remote}_${id.id}_${participant}`
    : `${fromMe}_${remote}_${id.id}`;
}

function ensureSerializedMessageId(msg) {
  const serialized = inferSerializedMessageId(msg);
  if (!serialized) return null;

  if (msg.id && typeof msg.id === 'object' && !msg.id._serialized) {
    msg.id._serialized = serialized;
    console.log('[WPP MEDIA] messageId reconstruido');
  }

  return serialized;
}

async function downloadMediaWithRetry(msg, { attempts = 3, delayMs = 1500, useTransport = fn => fn() } = {}) {
  let lastError = null;
  ensureSerializedMessageId(msg);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const media = await useTransport(() => msg.downloadMedia());
      if (media?.data) {
        if (attempt > 1) {
          console.log('[WPP MEDIA] Descarga recuperada en reintento', { attempt });
        }
        return media;
      }

      console.warn('[WPP MEDIA] downloadMedia sin datos', {
        attempt,
        type: msg.type || null,
        hasMedia: !!msg.hasMedia,
      });
    } catch (err) {
      if (err?.code === 'WPP_NOT_OWNER') throw err;
      lastError = err;
      console.error('[WPP MEDIA] Error descargando', {
        attempt,
        message: err?.message || String(err),
        name: err?.name || null,
        stack: err?.stack || null,
        type: msg.type || null,
        hasMedia: !!msg.hasMedia,
      });
    }

    if (attempt < attempts) await wait(delayMs);
  }

  if (lastError) {
    console.warn('[WPP MEDIA] downloadMedia agotó reintentos', {
      message: lastError?.message || String(lastError),
    });
  }

  return null;
}

async function resolveRecentTransferEmpresaId({ query, telSuffix }) {
  const rows = await query(
    `SELECT DISTINCT ON (p.empresa_id) p.empresa_id
       FROM pedidos p
       JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      WHERE pe.telefono_normalizado LIKE '%' || $1
        AND LOWER(COALESCE(p.metodo_pago, '')) = 'transferencia'
        AND p.estado IN ('pendiente', 'en_ruta', 'en_camino', 'entregado')
      ORDER BY p.empresa_id, p.id DESC
      LIMIT 2`,
    [telSuffix]
  );
  const unique = [...new Set(rows.map(row => Number(row.empresa_id)).filter(Boolean))];
  return unique.length === 1 ? unique[0] : null;
}

function phoneFromPnJid(value) {
  const raw = String(value || '').trim();
  if (!raw.toLowerCase().endsWith('@c.us')) return null;
  const digits = raw.slice(0, -5).replace(/\D+/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

async function resolvePhoneForLid({ lid, withActiveClient, msg, timeoutMs = 8000 }) {
  if (typeof withActiveClient === 'function') {
    try {
      const rows = await withActiveClient(async ({ client } = {}) => {
        if (typeof client?.getContactLidAndPhone !== 'function') return [];
        let timeoutId;
        try {
          return await Promise.race([
            client.getContactLidAndPhone([lid]),
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error('lid_resolution_timeout')), timeoutMs);
            }),
          ]);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      });
      const mapping = rows?.[0];
      const phone = String(mapping?.lid || '') === lid ? phoneFromPnJid(mapping?.pn) : null;
      if (phone) return phone;
    } catch (error) {
      if (error?.code === 'WPP_NOT_OWNER') throw error;
    }
  }

  try {
    const contact = await (typeof withActiveClient === 'function'
      ? withActiveClient(() => msg.getContact())
      : msg.getContact());
    return phoneFromPnJid(contact?.id?._serialized);
  } catch (error) {
    if (error?.code === 'WPP_NOT_OWNER') throw error;
    return null;
  }
}

export function createIncomingMediaHandler({
  query,
  lidByPhone,
  handleIncomingComprobanteFromBotPg,
  empresaId = null,
  withActiveClient = null,
}) {
  const tenantId = Number(empresaId || 0) || null;
  const useTransport = typeof withActiveClient === 'function'
    ? fn => withActiveClient(() => fn())
    : fn => fn();
  return async function handleIncomingMediaMessage(msg) {
    try {
      if (msg.from === 'status@broadcast' || msg.isStatus) return;
      if (msg.from.includes('@g.us')) return;
      if (msg.fromMe || msg.id?.fromMe) return;

      const t = String(msg.type || '').toLowerCase();
      const isMedia = msg.hasMedia || t === 'image' || t === 'document';

      console.log('[WPP IN]', {
        empresaId: tenantId,
        type: t,
        hasMedia: !!msg.hasMedia,
        isMedia,
      });

      if (!isMedia) return;

      const sourceChatJid = /^[^\s@]+@(c\.us|lid)$/i.test(String(msg.from || '').trim())
        ? String(msg.from).trim()
        : null;
      const rawFromDigits = String(msg.from || '').replace(/\D/g, '');
      let telefonoLimpio = String(msg.from || '').includes('@lid') ? null : (rawFromDigits || null);

      if (String(msg.from || '').includes('@lid')) {
        try {
          const contactDigits = await resolvePhoneForLid({
            lid: String(msg.from), withActiveClient, msg,
          });
          if (contactDigits) telefonoLimpio = contactDigits;
          const key10 = String(telefonoLimpio || '').replace(/\D/g, '').slice(-10);
          if (key10 && String(msg.from || '').includes('@lid')) {
            lidByPhone.set(key10, String(msg.from));
          }
          console.log('[WPP MEDIA] Resolución @lid', {
            empresaId: tenantId,
            resolved: !!contactDigits,
          });
        } catch (e) {
          if (e?.code === 'WPP_NOT_OWNER') throw e;
          console.warn('[WPP MEDIA] No se pudo resolver número para @lid:', e?.message || e);
        }
      }

      const clienteQuery = telefonoLimpio ? await query(
        tenantId
          ? `SELECT id FROM puntos_entrega
             WHERE telefono_normalizado LIKE '%' || $1
               AND empresa_id = $2
             LIMIT 1`
          : `SELECT DISTINCT empresa_id FROM puntos_entrega
             WHERE telefono_normalizado LIKE '%' || $1
             ORDER BY empresa_id
             LIMIT 2`,
        tenantId ? [telefonoLimpio.slice(-10), tenantId] : [telefonoLimpio.slice(-10)]
      ) : [];

      if (clienteQuery.length === 0 && tenantId) {
        console.warn('[WPP MEDIA] Remitente no registrado en empresa; se guarda comprobante pendiente.', {
          empresaId: tenantId,
        });
      } else if (clienteQuery.length === 0 && telefonoLimpio) {
        const fallbackEmpresaId = await resolveRecentTransferEmpresaId({ query, telSuffix: telefonoLimpio.slice(-10) });
        if (fallbackEmpresaId) {
          clienteQuery.push({ empresa_id: fallbackEmpresaId, fallback: 'recent_transfer_order' });
          console.log('[WPP MEDIA] Empresa resuelta por pedido de transferencia reciente.', {
            empresaId: fallbackEmpresaId,
          });
        } else {
          console.warn('[WPP MEDIA] Remitente no registrado; se guarda comprobante pendiente sin empresa.');
        }
      }

      if (!tenantId && clienteQuery.length > 0 && new Set(clienteQuery.map(row => Number(row.empresa_id))).size > 1) {
        if (typeof msg.reply === 'function') {
          await useTransport(() => msg.reply('Tu teléfono pertenece a más de una empresa. Enviá el comprobante al canal de la empresa correspondiente.'));
        }
        return;
      }
      const resolvedEmpresaId = tenantId || Number(clienteQuery[0]?.empresa_id || 0) || null;
      if (!resolvedEmpresaId) {
        console.warn('[WPP MEDIA] No se pudo resolver empresa para el comprobante; se guardará como pendiente global.');
      }

      console.log(`[WPP MEDIA] Recibido archivo de cliente registrado tipo=${t}`);

      const media = await downloadMediaWithRetry(msg, { useTransport });

      if (!media) {
        console.warn('[WPP MEDIA] downloadMedia devolvió null');
        return;
      }

      const maxBytes = Number(process.env.TRANSFERENCIA_MAX_BYTES || 10 * 1024 * 1024);
      const estimatedBytes = Math.floor(String(media.data).length * 3 / 4);
      if (estimatedBytes > maxBytes) {
        console.warn('[WPP MEDIA] Archivo rechazado por tamaño');
        return;
      }
      const buffer = Buffer.from(media.data, 'base64');
      console.log('[WPP MEDIA] Archivo descargado', {
        mimetype: media.mimetype,
        bytes: buffer.length,
      });

      const result = await handleIncomingComprobanteFromBotPg({
        type: t,
        telefono: telefonoLimpio,
        replyJid: sourceChatJid,
        buffer,
        base64: media.data,
        mimetype: media.mimetype,
        filename: media.filename || msg.body?.slice(0, 20) || 'archivo',
        empresaId: resolvedEmpresaId,
        transportOrigin: tenantId ? 'company' : 'general',
        sourceMessageId: ensureSerializedMessageId(msg),
      });

      console.log('[WPP MEDIA] Resultado pipeline comprobante', {
        empresaId: resolvedEmpresaId,
        ok: !!result?.ok,
        reason: result?.reason || null,
        error: result?.error || null,
        id: result?.id || null,
        pedido_id: result?.pedido_id || null,
      });

      console.log(`[AUDIT COMPROBANTE] empresa=${resolvedEmpresaId} pedido=${String(result?.pedido_id ?? '-')} comp=${String(result?.id ?? '-')} ok=${result?.ok ? 1 : 0}`);
    } catch (e) {
      if (e?.code !== 'WPP_NOT_OWNER') {
        console.error('[WPP SERVER] Error procesando media:', e?.message || String(e));
      }
    }
  };
}
