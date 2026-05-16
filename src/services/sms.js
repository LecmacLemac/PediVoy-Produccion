function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

function normalizeArPhone(v) {
  const d = digitsOnly(v);
  if (!d) return '';
  if (d.length === 10) return `549${d}`;
  return d;
}

export async function sendSmsViaIfttt({ phone, message }) {
  const webhookUrl = String(process.env.IFTTT_SMS_WEBHOOK_URL || '').trim();
  if (!webhookUrl) return { ok: false, skipped: true, reason: 'missing_webhook_url' };

  const phoneNorm = normalizeArPhone(phone);
  const msg = String(message || '').trim();
  if (!phoneNorm || !msg) return { ok: false, skipped: true, reason: 'missing_phone_or_message' };

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value1: phoneNorm, value2: msg }),
    });

    const text = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      body: text,
      phone: phoneNorm,
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e),
      phone: phoneNorm,
    };
  }
}
