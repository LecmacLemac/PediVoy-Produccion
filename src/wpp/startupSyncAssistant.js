import { runStartupSyncAssistant } from './companyRuntime.js';

const devToolsPortFile = process.argv[2];

try {
  const resumed = await runStartupSyncAssistant({ devToolsPortFile });
  if (typeof process.send === 'function') process.send({ type: 'startup-sync-assistant', resumed });
  process.exit(resumed ? 0 : 1);
} catch (error) {
  if (typeof process.send === 'function') {
    process.send({
      type: 'startup-sync-assistant',
      resumed: false,
      error: error?.message || String(error),
    });
  }
  process.exit(1);
}
