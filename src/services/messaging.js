import { query } from '../db.js';

export async function enqueueWppMessage({ phone, message, empresa_id = null }) {
  if (!phone || !message) return;

  let cleanPhone = String(phone).replace(/\D+/g, '');
  const cleanMsg = String(message).trim();

  if (cleanPhone.length === 10) {
    cleanPhone = '549' + cleanPhone;
  }

  try {
    const duplicados = await query(
      `SELECT id FROM wpp_outbox
      WHERE telefono = $1
        AND mensaje = $2
        AND created_at > (NOW() - INTERVAL '5 minutes')
      LIMIT 1`,
      [cleanPhone, cleanMsg]
    );

    if (duplicados.length > 0) return;

    await query(
      `INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, created_at)
      VALUES ($1, $2, $3, 'pending', NOW())`,
      [empresa_id, cleanPhone, cleanMsg]
    );
  } catch (e) {
    console.error('Error en enqueueWppMessage (service):', e);
  }
}
