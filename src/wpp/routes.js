import { WPP_SESSION_ID } from './sessionUtils.js';

const COUNTER_FIELDS = [
  'epoch',
  'reset_requested_seq',
  'reset_started_seq',
  'reset_applied_seq',
  'reset_failed_seq',
];

function serializeClusterStatus(status) {
  if (!status) return null;
  const result = {
    owner_id: status.owner_id ?? null,
    epoch: status.epoch ?? null,
    state: status.state ?? 'standby',
    heartbeat_at: status.heartbeat_at ?? null,
    operation: status.operation ?? null,
    last_error: status.last_error ?? null,
    reset_requested_seq: status.reset_requested_seq ?? 0,
    reset_started_seq: status.reset_started_seq ?? 0,
    reset_applied_seq: status.reset_applied_seq ?? 0,
    reset_failed_seq: status.reset_failed_seq ?? 0,
  };
  for (const field of COUNTER_FIELDS) {
    if (result[field] !== null) result[field] = String(result[field]);
  }
  if (result.heartbeat_at instanceof Date) result.heartbeat_at = result.heartbeat_at.toISOString();
  return result;
}

function localSnapshot(supervisor, state) {
  const snapshot = typeof supervisor?.snapshot === 'function' ? supervisor.snapshot() : null;
  return {
    role: snapshot?.isOwner === true ? 'owner' : 'standby',
    state: snapshot?.state ?? 'standby',
    generation: snapshot?.generation ?? 0,
    ready: Boolean(snapshot?.ready ?? state.isReadyWpp),
    gate_open: Boolean(snapshot?.gateOpen ?? snapshot?.gate),
  };
}

function serializeResetSequence(sequence) {
  const validBigInt = typeof sequence === 'bigint' && sequence > 0n;
  const validNumber = typeof sequence === 'number'
    && Number.isSafeInteger(sequence)
    && sequence > 0;
  if (!validBigInt && !validNumber) throw new TypeError('Invalid reset sequence');
  return String(sequence);
}

function serializeResetOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object' || typeof outcome.accepted !== 'boolean') {
    throw new TypeError('Invalid reset outcome');
  }
  const sequence = serializeResetSequence(outcome.sequence);
  return { accepted: outcome.accepted, sequence };
}

export function registerWppRoutes(app, deps) {
  const {
    ENABLE_WPP,
    WPP_QR_ONLY = false,
    qrcode,
    withAuth,
    isSuper,
    getState,
    repository,
    supervisor,
  } = deps;

  const RESET_COOLDOWN_MS = 15000;

  app.get('/api/whatsapp/status', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Solo SUPER ADMIN' });
    if (typeof repository?.getClusterStatus !== 'function') {
      return res.status(503).json({ error: 'Control global de WhatsApp no disponible' });
    }

    try {
      const state = getState();
      const persisted = await repository.getClusterStatus();
      if (!persisted) return res.status(503).json({ error: 'Estado global de WhatsApp no disponible' });
      const cluster = serializeClusterStatus(persisted);
      const local = localSnapshot(supervisor, state);
      const connected = persisted.state === 'ready';
      return res.json({
        ok: true,
        enabled: Boolean(ENABLE_WPP),
        qr_only: Boolean(WPP_QR_ONLY),
        connected,
        ready: connected,
        initializing: ['starting', 'initializing'].includes(persisted.state),
        shutting_down: persisted.state === 'shutting_down',
        has_qr: Boolean(persisted.qr_code),
        reset_in_progress: persisted.state === 'resetting' || persisted.operation === 'reset',
        session_id: WPP_SESSION_ID,
        cluster,
        local,
        message: ENABLE_WPP
          ? (connected
              ? 'WhatsApp general conectado.'
              : (persisted.qr_code ? 'QR general disponible para escanear.' : 'WhatsApp general inicializando o esperando QR.'))
          : 'WhatsApp general deshabilitado. En local levantá con ENABLE_WPP=1.',
      });
    } catch (error) {
      console.error('[WPP SERVER] Error leyendo estado global:', error);
      return res.status(503).json({ error: 'Estado global de WhatsApp no disponible' });
    }
  });

  app.get('/api/whatsapp/qr', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).send('<h1>⛔ Acceso Denegado</h1>');
    if (!ENABLE_WPP) {
      return res
        .status(503)
        .send('<h2>WhatsApp general deshabilitado</h2><p>En local levantá el server con ENABLE_WPP=1 npm start o npm run start:qr.</p>');
    }

    if (typeof repository?.getClusterStatus !== 'function') {
      return res.status(503).send('<h2>Estado global de WhatsApp no disponible</h2>');
    }

    let persisted;
    try {
      persisted = await repository.getClusterStatus();
    } catch (error) {
      console.error('[WPP SERVER] Error leyendo QR global:', error);
      return res.status(503).send('<h2>Estado global de WhatsApp no disponible</h2>');
    }
    if (!persisted) return res.status(503).send('<h2>Estado global de WhatsApp no disponible</h2>');
    if (persisted.state === 'ready') {
      return res.send(`<h2 style="color:green">Conectado ✅${WPP_QR_ONLY ? ' · modo solo QR' : ''}</h2>`);
    }
    if (!persisted.qr_code) {
      const msg = ['starting', 'initializing'].includes(persisted.state)
        ? 'Inicializando WhatsApp general...'
        : 'Cargando QR... espera la consola';
      return res.send(`<h2>${msg}</h2><p>${WPP_QR_ONLY ? 'Modo solo QR activo.' : 'Worker general activo.'}</p>`);
    }

    try {
      const url = await qrcode.toDataURL(persisted.qr_code);
      res.send(`<img src="${url}" />`);
    } catch {
      res.status(500).send('Error QR');
    }
  });

  app.post('/api/whatsapp/reset', withAuth, async (req, res) => {
    if (!ENABLE_WPP) return res.status(503).json({ error: 'WhatsApp deshabilitado en este entorno' });
    if (!isSuper(req)) return res.status(403).json({ error: 'Solo SUPER ADMIN puede resetear la sesión de WhatsApp' });
    if (typeof repository?.requestReset !== 'function') {
      return res.status(503).json({ error: 'Control global de WhatsApp no disponible' });
    }

    try {
      const outcome = serializeResetOutcome(await repository.requestReset({
        requestedBy: String(req.user?.uid ?? 'unknown'),
        cooldownMs: RESET_COOLDOWN_MS,
      }));
      if (!outcome.accepted) {
        return res.status(202).json({
          ok: true,
          accepted: false,
          skipped: true,
          reason: 'cooldown',
          reset_seq: outcome.sequence,
          sequence: outcome.sequence,
        });
      }
      return res.status(202).json({
        ok: true,
        accepted: true,
        request_id: outcome.sequence,
        reset_seq: outcome.sequence,
        sequence: outcome.sequence,
      });
    } catch (error) {
      console.error('[WPP SERVER] Error solicitando reset global:', error);
      return res.status(503).json({ error: 'No se pudo solicitar el reset de WhatsApp' });
    }
  });
}
