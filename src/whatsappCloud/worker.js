import { randomUUID } from 'node:crypto';

import { pool, query } from '../db.js';
import { decryptSecret } from '../services/facturacionService.js';
import { createWhatsAppCloudConsumer } from './consumer.js';
import { createWhatsAppCloudGraphClient } from './graphClient.js';
import {
  claimNextCloudOutboxRow,
  finishCloudOutboxRow,
  loadDurableCloudConfig,
  markCloudDispatchStarted,
} from './outboxRepository.js';
import { createWhatsAppCloudWorkerRuntime } from './runtime.js';

const owner = `whatsapp-cloud-${process.pid}-${randomUUID()}`;
const graphClient = createWhatsAppCloudGraphClient();
const consumer = createWhatsAppCloudConsumer({
  owner,
  leaseMs: process.env.WHATSAPP_CLOUD_LEASE_MS,
  claimNext: options => claimNextCloudOutboxRow({ query, ...options }),
  loadConfig: options => loadDurableCloudConfig({ query, ...options }),
  startDispatch: options => markCloudDispatchStarted({ query, ...options }),
  finish: options => finishCloudOutboxRow({ query, ...options }),
  decryptToken: decryptSecret,
  graphClient,
  logger: console,
});

const runtime = createWhatsAppCloudWorkerRuntime({
  consumer,
  closePool: () => pool.end(),
  intervalMs: process.env.WHATSAPP_CLOUD_POLL_MS,
  shutdownTimeoutMs: process.env.WHATSAPP_CLOUD_SHUTDOWN_MS,
  keepAlive: true,
  logger: console,
});

runtime.start();
void runtime.tick();
