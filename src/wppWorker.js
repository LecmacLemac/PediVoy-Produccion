import 'dotenv/config';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import pkg from 'whatsapp-web.js';

const { Client, LocalAuth } = pkg;
const require = createRequire(import.meta.url);
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');

import { pool, query } from './db.js';
import handlers from './handlers.js';
import { handleIncomingComprobanteFromBotPg } from './transferenciasPipeline.js';
import { ensureComprobantesTransferenciaSchema } from './transferenciasServices.js';
import { registerCompanyIncomingMedia } from './wpp/companyIncomingMedia.js';
import { parseEnterpriseId } from './wpp/enterpriseId.js';
import { createWppClientAdapter } from './wpp/clientAdapter.js';
import { createCompanyOwnership } from './wpp/companyOwnership.js';
import { createCompanyLifecycle } from './wpp/companyLifecycle.js';
import { getCompanySessionPaths } from './wpp/companySession.js';
import {
  confirmCompanyRuntime,
  createBackoffRecovery,
  createNonOverlappingTask,
  createPrerequisiteStartup,
  createSingleFlight,
  isRuntimeBridgeError,
  repairCompanyRuntimeBridge,
} from './wpp/companyRuntime.js';
import {
  claimWppOutboxRows,
  ensureWppDeliverySchema,
  finishWppOutboxClaim,
  releaseWppOutboxClaim,
  resolveWhatsappTarget,
} from './wpp/delivery.js';

const EMPRESA_ID = parseEnterpriseId(process.env.EMPRESA_ID);
const WPP_QR_ONLY = process.env.WPP_QR_ONLY === '1';
const sessionPaths = getCompanySessionPaths({ empresaId: EMPRESA_ID });
const OUTBOX_CLAIM_OWNER = `empresa-${EMPRESA_ID}-${process.pid}-${randomUUID()}`;

let lifecycle;
let isReady = false;
let isProcessingOutbox = false;
let isShuttingDown = false;
let lastResetHandledAt = null;
let outboxInterval;
let resetInterval;
let healthInterval;
let ownershipInterval;

async function ensureEmpresaWhatsappSchema() {
  await query(`
    ALTER TABLE empresas
      ADD COLUMN IF NOT EXISTS wpp_qr_code TEXT,
      ADD COLUMN IF NOT EXISTS wpp_status TEXT DEFAULT 'disconnected',
      ADD COLUMN IF NOT EXISTS wpp_reset_requested_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);
  await ensureWppDeliverySchema(query);
  await ensureComprobantesTransferenciaSchema(query);
}

async function persistStatus(status, { qrCode = null, heartbeat = false } = {}) {
  if (!ownership.isOwner) return false;
  await query(
    `UPDATE empresas
        SET wpp_status = $1,
            wpp_qr_code = $2,
            wpp_heartbeat_at = CASE WHEN $3::boolean THEN NOW() ELSE NULL END,
            updated_at = NOW()
      WHERE id = $4`,
    [status, qrCode, heartbeat, EMPRESA_ID],
  );
  return true;
}

function createManagedCompanyClient({ generation }) {
  const isRender = process.env.RENDER === 'true';
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (isRender ? '/usr/bin/chromium' : undefined);
  const rawClient = new Client({
    authStrategy: new LocalAuth({
      clientId: `empresa_${EMPRESA_ID}`,
      dataPath: sessionPaths.dataPath,
    }),
    puppeteer: {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=VizDisplayCompositor',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-software-rasterizer',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
      ],
      executablePath,
      ignoreHTTPSErrors: true,
      timeout: 60000,
    },
  });
  const adapter = createWppClientAdapter({ rawClient });
  let managedClient;

  const current = () => lifecycle?.isCurrent(managedClient, generation) === true;

  rawClient.on('qr', async qr => {
    if (!current()) return;
    isReady = false;
    try {
      await ownership.heartbeat();
      if (!current()) return;
      await persistStatus('awaiting_scan', { qrCode: qr });
      console.log(`[Empresa ${EMPRESA_ID}] Nuevo QR generado. Esperando escaneo...`);
    } catch (error) {
      console.error(`[Empresa ${EMPRESA_ID}] No se pudo persistir QR:`, error.message);
    }
  });

  rawClient.on('ready', async () => {
    if (!current()) return;
    isReady = false;
    try {
      await ownership.heartbeat();
      if (!current()) return;
      await persistStatus('connected', { heartbeat: true });
      if (!current()) return;
      isReady = true;
      console.log(`[Empresa ${EMPRESA_ID}] ¡Conexión exitosa! El worker está operativo.`);
    } catch (error) {
      console.error(`[Empresa ${EMPRESA_ID}] No se pudo persistir estado connected:`, error.message);
      workerRecovery.trigger('persist_connected_failed');
    }
  });

  async function unavailable(event, detail) {
    if (!current()) return;
    isReady = false;
    console.warn(`[Empresa ${EMPRESA_ID}] ${event}:`, detail);
    try {
      await ownership.heartbeat();
      if (current()) await persistStatus('disconnected');
    } catch (error) {
      console.error(`[Empresa ${EMPRESA_ID}] No se pudo persistir desconexión:`, error.message);
    }
    if (current()) workerRecovery.trigger(event);
  }

  rawClient.on('auth_failure', detail => { void unavailable('auth_failure', detail); });
  rawClient.on('disconnected', detail => { void unavailable('disconnected', detail); });

  managedClient = new Proxy({
    async initialize() {
      await persistStatus('initializing');
      let assistant = null;
      try {
        assistant = fork(
          new URL('./wpp/startupSyncAssistant.js', import.meta.url),
          [sessionPaths.devToolsActivePortFile],
          { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
        );
        assistant.on('message', message => {
          if (message?.type === 'startup-sync-assistant' && message.resumed) {
            console.log(`[Empresa ${EMPRESA_ID}] Inicialización reanudada por asistente DevTools independiente.`);
          }
        });
        assistant.on('error', error => {
          console.warn(`[Empresa ${EMPRESA_ID}] Asistente DevTools no pudo iniciar:`, error.message);
        });
        return await adapter.initialize();
      } finally {
        if (assistant?.connected) assistant.disconnect();
        if (assistant && assistant.exitCode === null) assistant.kill('SIGTERM');
      }
    },
    destroy: () => adapter.destroy(),
    confirmStopped: () => adapter.confirmStopped(),
    forceStop: () => adapter.forceStop(),
    removeAllListeners: () => adapter.removeAllListeners(),
    async sendMessage(...args) {
      await ownership.heartbeat();
      if (!current()) throw Object.assign(new Error('WhatsApp Empresa generation is not active'), { code: 'WPP_COMPANY_NOT_OWNER' });
      return adapter.sendMessage(...args);
    },
  }, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      const value = adapter[property];
      return typeof value === 'function' ? value.bind(adapter) : value;
    },
  });

  if (!WPP_QR_ONLY) {
    handlers.start(managedClient, { empresaId: Number(EMPRESA_ID) });
    registerCompanyIncomingMedia(managedClient, {
      empresaId: Number(EMPRESA_ID),
      query,
      handleIncomingComprobanteFromBotPg,
    });
  } else {
    console.log(`[Empresa ${EMPRESA_ID}] Modo solo QR activo: no se atienden mensajes entrantes.`);
  }

  return managedClient;
}

const ownership = createCompanyOwnership({
  pool,
  empresaId: Number(EMPRESA_ID),
  ownerId: OUTBOX_CLAIM_OWNER,
  onOwnershipLost: error => {
    isReady = false;
    console.error(`[Empresa ${EMPRESA_ID}] Ownership PostgreSQL perdido:`, error.message);
    void lifecycle?.ownershipLost(error);
  },
});

lifecycle = createCompanyLifecycle({
  ownership,
  clientFactory: { create: createManagedCompanyClient },
  deleteSession: async () => {
    fs.rmSync(sessionPaths.sessionDir, { recursive: true, force: true });
  },
});

async function loadResetMarker() {
  const rows = await query('SELECT wpp_reset_requested_at FROM empresas WHERE id = $1 LIMIT 1', [EMPRESA_ID]);
  return rows[0]?.wpp_reset_requested_at ? new Date(rows[0].wpp_reset_requested_at).toISOString() : null;
}

const recoverCompanyRuntime = createSingleFlight(async reason => {
  if (isShuttingDown || !ownership.isOwner) return false;
  isReady = false;
  console.warn(`[Empresa ${EMPRESA_ID}] Runtime WhatsApp no operativo (${reason}). Intentando recuperar bridge...`);

  try {
    const repaired = await lifecycle.withActiveClient(async ({ client }) => {
      const result = await repairCompanyRuntimeBridge(client, LoadUtils);
      if (!result.healthy) return result;
      await persistStatus('connected', { heartbeat: true });
      return result;
    });
    if (repaired.healthy) {
      isReady = true;
      console.log(`[Empresa ${EMPRESA_ID}] Bridge WWebJS reinyectado sin reiniciar sesión.`);
      return true;
    }
    await lifecycle.restart(reason);
    return true;
  } catch (error) {
    console.error(`[Empresa ${EMPRESA_ID}] Error recuperando runtime WhatsApp:`, error.message);
    await persistStatus('disconnected').catch(() => {});
    return false;
  }
});

const workerRecovery = createBackoffRecovery({
  task: async reason => recoverCompanyRuntime(reason),
  onError: (error, state) => {
    console.error(`[Empresa ${EMPRESA_ID}] Recuperación falló (intento ${state.attempt + 1}):`, error.message);
  },
});

const workerStartup = createPrerequisiteStartup({
  ensurePrerequisites: ensureEmpresaWhatsappSchema,
  start: async () => {
    const started = await lifecycle.start();
    if (!started) {
      console.log(`[Empresa ${EMPRESA_ID}] Otro worker posee la sesión; quedando en standby.`);
      return false;
    }
    const pendingReset = await loadResetMarker();
    if (pendingReset) await applyResetMarker(pendingReset);
    return true;
  },
  onError: (error, state) => {
    console.error(`[Empresa ${EMPRESA_ID}] Startup falló (intento ${state.attempt + 1}):`, error.message);
  },
});

async function persistWorkerHeartbeat() {
  if (!isReady || !ownership.isOwner) return;
  await ownership.heartbeat();
  await query(
    "UPDATE empresas SET wpp_heartbeat_at = NOW() WHERE id = $1 AND wpp_status = 'connected'",
    [EMPRESA_ID],
  );
}

async function checkCompanyRuntimeHealth() {
  if (!isReady || !ownership.isOwner || isShuttingDown) return;
  const health = await lifecycle.withActiveClient(({ client }) => confirmCompanyRuntime(client));
  if (health.healthy) {
    await persistWorkerHeartbeat();
    return;
  }
  await recoverCompanyRuntime(health.reason);
}

const checkCompanyRuntimeHealthTick = createNonOverlappingTask(checkCompanyRuntimeHealth);

async function applyResetMarker(marker) {
  isReady = false;
  await lifecycle.reset(marker);
  await query(
    `UPDATE empresas
        SET wpp_reset_requested_at = NULL,
            updated_at = NOW()
      WHERE id = $1
        AND wpp_reset_requested_at = $2::timestamptz`,
    [EMPRESA_ID, marker],
  );
  lastResetHandledAt = marker;
}

async function checkResetRequest() {
  if (!workerStartup.getState().started || !ownership.isOwner || isShuttingDown) return;
  try {
    const marker = await loadResetMarker();
    if (!marker || marker === lastResetHandledAt) return;
    await applyResetMarker(marker);
  } catch (error) {
    console.error(`[Empresa ${EMPRESA_ID}] Error reseteando cliente:`, error.message);
    await persistStatus('disconnected').catch(() => {});
  }
}

function isConnectionSendError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return ['not connected', 'disconnected', 'closed', 'websocket', 'target closed', 'session closed',
    'protocol error', 'execution context was destroyed'].some(fragment => message.includes(fragment));
}

function isInvalidPhoneError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return ['telefono_invalido', 'invalid', 'phone', 'number'].some(fragment => message.includes(fragment));
}

async function processOutbox() {
  if (WPP_QR_ONLY || !isReady || !ownership.isOwner || isProcessingOutbox || isShuttingDown) return;
  isProcessingOutbox = true;
  try {
    await lifecycle.withActiveClient(async ({ client }) => {
      const filas = await claimWppOutboxRows({
        query,
        owner: OUTBOX_CLAIM_OWNER,
        limit: 5,
        whereSql: 'AND o.empresa_id = $4',
        whereParams: [EMPRESA_ID],
      });

      for (const [index, fila] of filas.entries()) {
        let sendStarted = false;
        try {
          await ownership.heartbeat();
          const target = await resolveWhatsappTarget(client, fila.telefono);
          await ownership.heartbeat();
          sendStarted = true;
          await client.sendMessage(target, fila.mensaje);
          await finishWppOutboxClaim({ query, id: fila.id, owner: OUTBOX_CLAIM_OWNER, status: 'sent', sent: true });
          await persistWorkerHeartbeat();
          console.log(`[Empresa ${EMPRESA_ID}] Mensaje enviado a ${fila.telefono}`);
        } catch (error) {
          console.error(`[Empresa ${EMPRESA_ID}] Error al enviar ID ${fila.id}:`, error.message);
          if (!sendStarted && isInvalidPhoneError(error)) {
            await finishWppOutboxClaim({
              query, id: fila.id, owner: OUTBOX_CLAIM_OWNER, status: 'error', error: 'Número de teléfono inválido',
            });
            continue;
          }
          await releaseWppOutboxClaim({
            query,
            id: fila.id,
            owner: OUTBOX_CLAIM_OWNER,
            error: isRuntimeBridgeError(error)
              ? 'Runtime WhatsApp empresa no disponible; reinicializando worker'
              : (isConnectionSendError(error)
                ? 'Fallback a WhatsApp general: conexión de empresa no disponible'
                : 'Reintento por error temporal en WhatsApp empresa'),
          });
          if (isRuntimeBridgeError(error) || isConnectionSendError(error)) {
            for (const remaining of filas.slice(index + 1)) {
              await releaseWppOutboxClaim({ query, id: remaining.id, owner: OUTBOX_CLAIM_OWNER, error: null });
            }
            workerRecovery.trigger(isRuntimeBridgeError(error) ? 'runtime_bridge_send_error' : 'connection_send_error');
            break;
          }
        }
      }
    });
  } catch (error) {
    console.error(`[Empresa ${EMPRESA_ID}] Error procesando outbox:`, error.message);
  } finally {
    isProcessingOutbox = false;
  }
}

async function shutdownWorker() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  isReady = false;
  clearInterval(outboxInterval);
  clearInterval(resetInterval);
  clearInterval(healthInterval);
  clearInterval(ownershipInterval);
  workerStartup.stop();
  workerRecovery.stop();
  try {
    await lifecycle.shutdown();
  } catch (error) {
    console.error(`[Empresa ${EMPRESA_ID}] Shutdown no confirmado:`, error.message);
    process.exitCode = 1;
  }
}

console.log(`[Empresa ${EMPRESA_ID}] Iniciando cliente de WhatsApp${WPP_QR_ONLY ? ' en modo solo QR' : ''}...`);
outboxInterval = setInterval(() => { void processOutbox(); }, 5000);
resetInterval = setInterval(() => { void checkResetRequest(); }, 5000);
healthInterval = setInterval(() => {
  checkCompanyRuntimeHealthTick().catch(error => {
    console.warn(`[Empresa ${EMPRESA_ID}] Error en health-check WhatsApp:`, error?.message || error);
  });
}, 15000);
ownershipInterval = setInterval(() => {
  if (!ownership.isOwner || isShuttingDown) return;
  ownership.heartbeat().catch(() => {});
}, 5000);

process.once('SIGTERM', () => { void shutdownWorker(); });
process.once('SIGINT', () => { void shutdownWorker(); });
void workerStartup.trigger('startup');
