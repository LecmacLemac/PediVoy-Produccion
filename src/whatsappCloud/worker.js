import { randomUUID } from 'node:crypto';

import { pool, query, runWithSensitiveDbQueries } from '../db.js';
import { createWhatsAppContextResolver } from '../handlers.js';
import { decryptSecret } from '../services/facturacionService.js';

import { enqueueWppOutboxCorrelatedReply } from '../wpp/enqueue.js';
import { createCloudInboundBotAdapter } from './botAdapter.js';
import { createWhatsAppCloudCombinedConsumer } from './combinedConsumer.js';
import { createWhatsAppCloudConsumer } from './consumer.js';
import { createWhatsAppCloudGraphClient } from './graphClient.js';
import { createWhatsAppCloudInboundConsumer } from './inboundConsumer.js';
import { createWhatsAppCloudMediaClient } from './mediaClient.js';
import { createWhatsAppCloudReceiptProcessor } from './receiptProcessor.js';
import {
  claimNextCloudInboundEvent,
  finishCloudInboundEvent,
  loadActiveCloudInboundTenant,
  renewCloudInboundProcessingLease,
  scheduleCloudInboundRetry,
  startCloudInboundProcessing,
} from './inboundRepository.js';
import {
  claimNextCloudOutboxRow,
  finishCloudOutboxRow,
  loadDurableCloudConfig,
  markCloudDispatchStarted,
} from './outboxRepository.js';
import { createWhatsAppCloudWorkerRuntime } from './runtime.js';

const owner = `whatsapp-cloud-${process.pid}-${randomUUID()}`;
const graphClient = createWhatsAppCloudGraphClient();
const outboundConsumer = createWhatsAppCloudConsumer({
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

const sensitiveQuery = (sql, params = []) => query(sql, params, { sensitive: true });
const botAdapter = createCloudInboundBotAdapter({
  enqueueReply: input => enqueueWppOutboxCorrelatedReply(input, pool),
  contextResolver: createWhatsAppContextResolver(sensitiveQuery),
  logger: console,
});
const receiptProcessor = createWhatsAppCloudReceiptProcessor({
  loadTenant: options => loadActiveCloudInboundTenant({ query: sensitiveQuery, ...options }),
  decryptToken: decryptSecret,
  mediaClient: createWhatsAppCloudMediaClient(),
  enqueueReply: input => enqueueWppOutboxCorrelatedReply(input, pool),
});
const inboundConsumer = createWhatsAppCloudInboundConsumer({
  owner,
  leaseMs: process.env.WHATSAPP_CLOUD_LEASE_MS,
  claimNext: options => claimNextCloudInboundEvent({ query: sensitiveQuery, ...options }),
  loadTenant: options => loadActiveCloudInboundTenant({ query: sensitiveQuery, ...options }),
  startProcessing: options => startCloudInboundProcessing({ query: sensitiveQuery, ...options }),
  renewLease: options => renewCloudInboundProcessingLease({ query: sensitiveQuery, ...options }),
  finish: options => finishCloudInboundEvent({ query: sensitiveQuery, ...options }),
  scheduleRetry: options => scheduleCloudInboundRetry({ query: sensitiveQuery, ...options }),
  processBotMessage: botAdapter.process,
  prepareReceipt: input => runWithSensitiveDbQueries(() => receiptProcessor.prepare(input)),
  processReceipt: input => runWithSensitiveDbQueries(() => receiptProcessor.processPrepared(input)),
  logger: console,
});
const combinedConsumer = createWhatsAppCloudCombinedConsumer({
  inbound: inboundConsumer,
  outbound: outboundConsumer,
  logger: console,
});

const runtime = createWhatsAppCloudWorkerRuntime({
  consumer: combinedConsumer,
  closePool: () => pool.end(),
  intervalMs: process.env.WHATSAPP_CLOUD_POLL_MS,
  shutdownTimeoutMs: process.env.WHATSAPP_CLOUD_SHUTDOWN_MS,
  keepAlive: true,
  logger: console,
});

runtime.start();
void runtime.tick();
