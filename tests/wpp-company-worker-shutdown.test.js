import test from 'node:test';
import assert from 'node:assert/strict';

import { createCompanyWorkerShutdown } from '../src/wpp/companyWorkerShutdown.js';

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

test('worker shutdown stops admission, awaits lifecycle, closes pool, then exits', async () => {
  const lifecycleStopped = deferred();
  const order = [];
  const shutdown = createCompanyWorkerShutdown({
    stopSchedulers: () => { order.push('schedulers-stopped'); },
    shutdownLifecycle: async () => {
      order.push('lifecycle-start');
      await lifecycleStopped.promise;
      order.push('lifecycle-stopped');
      return true;
    },
    closePool: async () => { order.push('pool-closed'); },
    exit: code => { order.push(`exit:${code}`); },
    logger: { error() {} },
  });

  const first = shutdown();
  assert.equal(shutdown(), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['schedulers-stopped', 'lifecycle-start']);

  lifecycleStopped.resolve();
  assert.equal(await first, true);
  assert.deepEqual(order, [
    'schedulers-stopped', 'lifecycle-start', 'lifecycle-stopped', 'pool-closed', 'exit:0',
  ]);
});

test('worker shutdown closes pool and exits nonzero after lifecycle failure', async () => {
  const order = [];
  const shutdown = createCompanyWorkerShutdown({
    stopSchedulers: () => { order.push('schedulers-stopped'); },
    shutdownLifecycle: async () => { order.push('lifecycle-failed'); throw new Error('stop failed'); },
    closePool: async () => { order.push('pool-closed'); },
    exit: code => { order.push(`exit:${code}`); },
    logger: { error() {} },
  });

  assert.equal(await shutdown(), false);
  assert.deepEqual(order, ['schedulers-stopped', 'lifecycle-failed', 'pool-closed', 'exit:1']);
});
