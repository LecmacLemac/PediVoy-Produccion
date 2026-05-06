import express from 'express';
import { getConfig } from './config.js';
import { endCall, listDevices, openDialer, placeCall, sendHelperBroadcast, unlockSwipe, wakeDevice } from './adb.js';
import { normalizePhone } from './phone.js';

const config = getConfig();
const app = express();
app.use(express.json({ limit: '256kb' }));

function requireAuth(req, res, next) {
  if (!config.authToken) return next();
  const given = String(req.headers['x-bridge-token'] || '');
  if (given !== config.authToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

async function safeDevices() {
  try {
    return await listDevices(config);
  } catch (error) {
    return { error: error.message };
  }
}

app.get('/health', async (_req, res) => {
  const devices = await safeDevices();
  res.json({ ok: true, service: 'pedivoy-android-bridge', devices });
});

app.get('/device', requireAuth, async (_req, res) => {
  try {
    const devices = await listDevices(config);
    res.json({ ok: true, devices, selectedSerial: config.serial || null, mode: config.mode });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/call', requireAuth, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone, config.defaultCountryPrefix);
    const mode = String(req.body?.mode || config.mode || 'helper').trim().toLowerCase();

    await wakeDevice(config).catch(() => null);
    await unlockSwipe(config).catch(() => null);

    let result;
    if (mode === 'helper') result = await sendHelperBroadcast(config, phone);
    else if (mode === 'dial') result = await openDialer(config, phone);
    else result = await placeCall(config, phone).catch(async () => openDialer(config, phone));

    const action = mode === 'helper'
      ? 'helper_broadcast_sent'
      : mode === 'dial'
        ? 'dialer_opened'
        : 'call_started';

    res.json({ ok: true, action, mode, phone, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/hangup', requireAuth, async (_req, res) => {
  try {
    const result = await endCall(config);
    res.json({ ok: true, action: 'call_ended', result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/call-status', requireAuth, async (_req, res) => {
  const devices = await safeDevices();
  res.json({ ok: true, devices, note: 'MVP: el estado detallado de llamada todavía no está implementado.' });
});

app.listen(config.port, () => {
  console.log(`[android-bridge] escuchando en puerto ${config.port}`);
});
