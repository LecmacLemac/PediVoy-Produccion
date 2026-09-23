import { query } from '../db.js';
import { normalizeWhatsappPhone } from '../core/format.js';

export async function enqueueWppMessage({
  phone, message, empresa_id = null, transport_origin = null,
}) {
  if (!phone || !message) return;

  const rawPhone = String(phone).trim();
  const cleanPhone = /^[^\s@]+@(c\.us|lid)$/i.test(rawPhone)
    ? rawPhone
    : normalizeWhatsappPhone(rawPhone);
  const cleanMsg = String(message).trim();

  try {
    const duplicados = await query(
      `SELECT id FROM wpp_outbox
      WHERE telefono = $1
        AND mensaje = $2
        AND empresa_id IS NOT DISTINCT FROM $3
        AND transport_origin IS NOT DISTINCT FROM $4
        AND created_at > (NOW() - INTERVAL '5 minutes')
      LIMIT 1`,
      [cleanPhone, cleanMsg, empresa_id, transport_origin]
    );

    if (duplicados.length > 0) return;

    await query(
      `INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, transport_origin, status, created_at)
      VALUES ($1, $2, $3, $4, 'pending', NOW())`,
      [empresa_id, cleanPhone, cleanMsg, transport_origin]
    );
  } catch (e) {
    console.error('Error en enqueueWppMessage (service):', e);
  }
}
