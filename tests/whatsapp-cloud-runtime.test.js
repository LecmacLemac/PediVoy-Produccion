import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { createWhatsAppCloudWorkerRuntime } from '../src/whatsappCloud/runtime.js';

test('runtime Cloud agenda proceso separado y cierre por señal drena, cierra pool y sale', async () => {
  const events = [];
  const handlers = new Map();
  let intervalCallback;
  const deadlineHandle = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };
  const clearedDeadlines = [];
  const consumer = {
    async processOnce() { events.push('process'); return { outcome: 'idle' }; },
    async shutdown({ timeoutMs }) { events.push(`shutdown:${timeoutMs}`); return true; },
  };
  const runtime = createWhatsAppCloudWorkerRuntime({
    consumer,
    intervalMs: 250,
    shutdownTimeoutMs: 900,
    closePool: async () => events.push('pool:end'),
    onSignal: (signal, handler) => handlers.set(signal, handler),
    setIntervalImpl: callback => { intervalCallback = callback; return 77; },
    clearIntervalImpl: id => events.push(`clear:${id}`),
    setTimeoutImpl: () => deadlineHandle,
    clearTimeoutImpl: handle => clearedDeadlines.push(handle),
    exit: code => events.push(`exit:${code}`),
    logger: { info() {}, warn() {}, error() {} },
  });

  runtime.start();
  assert.equal(typeof intervalCallback, 'function');
  assert.equal(typeof handlers.get('SIGTERM'), 'function');
  assert.equal(typeof handlers.get('SIGINT'), 'function');
  await intervalCallback();
  const shutdown = handlers.get('SIGTERM')();
  assert.strictEqual(runtime.shutdown(), shutdown);
  await shutdown;

  assert.deepEqual(events, ['process', 'clear:77', 'shutdown:900', 'pool:end', 'exit:0']);
  assert.equal(deadlineHandle.unrefCalls, 0);
  assert.deepEqual(clearedDeadlines, [deadlineHandle]);
});

test('el intervalo principal standalone conserva una referencia activa', () => {
  let unrefCalls = 0;
  const intervalHandle = { unref() { unrefCalls += 1; } };
  const runtime = createWhatsAppCloudWorkerRuntime({
    consumer: {
      async processOnce() { return { outcome: 'idle' }; },
      async shutdown() { return true; },
    },
    closePool: async () => {},
    onSignal() {},
    setIntervalImpl: () => intervalHandle,
    clearIntervalImpl() {},
    exit() {},
    keepAlive: true,
    logger: { info() {}, warn() {}, error() {} },
  });

  runtime.start();

  assert.equal(unrefCalls, 0);
});

test('shutdown false y closePool colgado respetan un único deadline global', async () => {
  const exits = [];
  let closeCalls = 0;
  const runtime = createWhatsAppCloudWorkerRuntime({
    consumer: {
      async processOnce() { return { outcome: 'idle' }; },
      async shutdown() { return false; },
    },
    shutdownTimeoutMs: 100,
    closePool: async () => {
      closeCalls += 1;
      await new Promise(() => {});
    },
    onSignal() {},
    setIntervalImpl: () => 1,
    clearIntervalImpl() {},
    exit: code => exits.push(code),
    logger: { info() {}, warn() {}, error() {} },
  });

  const startedAt = Date.now();
  let guard;
  let result;
  try {
    result = await Promise.race([
      runtime.shutdown(),
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('shutdown excedió 500ms')), 500); }),
    ]);
  } finally {
    clearTimeout(guard);
  }
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result, false);
  assert.equal(closeCalls, 1);
  assert.deepEqual(exits, [1]);
  assert.ok(elapsedMs >= 75, `shutdown terminó demasiado pronto: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 450, `shutdown excedió deadline global: ${elapsedMs}ms`);
});

test('shutdown lento consume el deadline y closePool no lo extiende', async () => {
  const exits = [];
  let closeCalls = 0;
  const runtime = createWhatsAppCloudWorkerRuntime({
    consumer: {
      async processOnce() { return { outcome: 'idle' }; },
      async shutdown() { await new Promise(() => {}); },
    },
    shutdownTimeoutMs: 100,
    closePool: async () => {
      closeCalls += 1;
      await new Promise(() => {});
    },
    onSignal() {},
    setIntervalImpl: () => 1,
    clearIntervalImpl() {},
    exit: code => exits.push(code),
    logger: { info() {}, warn() {}, error() {} },
  });

  const startedAt = Date.now();
  const keepAlive = setTimeout(() => {}, 500);
  let result;
  try {
    result = await runtime.shutdown();
  } finally {
    clearTimeout(keepAlive);
  }
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result, false);
  assert.equal(closeCalls, 1);
  assert.deepEqual(exits, [1]);
  assert.ok(elapsedMs >= 75, `shutdown terminó demasiado pronto: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 450, `closePool extendió el deadline: ${elapsedMs}ms`);
});

test('proceso Node real mantiene referenciado el deadline de shutdown y fuerza exit 1', async (t) => {
  const script = `
    import { createWhatsAppCloudWorkerRuntime } from './src/whatsappCloud/runtime.js';
    const runtime = createWhatsAppCloudWorkerRuntime({
      consumer: {
        async processOnce() { return { outcome: 'idle' }; },
        shutdown() { return new Promise(() => {}); },
      },
      closePool() { return new Promise(() => {}); },
      intervalMs: 50,
      shutdownTimeoutMs: 150,
      keepAlive: true,
      logger: { info() {}, warn() {}, error() {} },
    });
    runtime.start();
    console.log('shutdown-start');
    void runtime.shutdown();
  `;
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  const [code, signal] = await once(child, 'exit');
  const elapsedMs = Date.now() - startedAt;

  assert.equal(signal, null, `proceso terminó por señal; stderr=${stderr}`);
  assert.equal(code, 1, `shutdown pendiente salió naturalmente; stdout=${stdout}; stderr=${stderr}`);
  assert.ok(elapsedMs >= 110, `proceso no permaneció vivo hasta el deadline: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 1_000, `proceso excedió el deadline global: ${elapsedMs}ms`);
});

test('rechazo tardío de closePool queda observado y no duplica exit', async () => {
  const exits = [];
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const runtime = createWhatsAppCloudWorkerRuntime({
      consumer: {
        async processOnce() { return { outcome: 'idle' }; },
        async shutdown() { return true; },
      },
      shutdownTimeoutMs: 100,
      closePool: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late pool detail')), 150)),
      onSignal() {},
      setIntervalImpl: () => 1,
      clearIntervalImpl() {},
      exit: code => exits.push(code),
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(await runtime.shutdown(), false);
    assert.equal(await runtime.shutdown(), false);
    await new Promise(resolve => setTimeout(resolve, 180));

    assert.deepEqual(exits, [1]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('runtime no solapa ticks y sanitiza error operativo', async () => {
  const logs = [];
  let resolveTick;
  let calls = 0;
  const runtime = createWhatsAppCloudWorkerRuntime({
    consumer: {
      async processOnce() {
        calls += 1;
        await new Promise(resolve => { resolveTick = resolve; });
        throw new Error('token=secret phone=351555');
      },
      async shutdown() { return true; },
    },
    closePool: async () => {},
    onSignal() {},
    setIntervalImpl: () => 1,
    clearIntervalImpl() {},
    exit() {},
    logger: { info() {}, warn() {}, error: (...args) => logs.push(args) },
  });
  runtime.start();
  const first = runtime.tick();
  const second = runtime.tick();
  await Promise.resolve();
  resolveTick();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(logs).includes('secret'), false);
  assert.equal(JSON.stringify(logs).includes('351555'), false);
});

test('worker real sigue vivo y reintenta ante PostgreSQL inaccesible', async (t) => {
  const worker = spawn(process.execPath, ['src/whatsappCloud/worker.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://cloud_worker_secret@127.0.0.1:1/pedivoy',
      WHATSAPP_CLOUD_POLL_MS: '50',
      WHATSAPP_CLOUD_SHUTDOWN_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  worker.stdout.setEncoding('utf8');
  worker.stderr.setEncoding('utf8');
  worker.stdout.on('data', chunk => { stdout += chunk; });
  worker.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
  });

  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(worker.exitCode, null, `worker terminó antes de reintentar; stdout=${stdout}; stderr=${stderr}`);
  assert.equal(worker.signalCode, null);
  assert.match(stderr, /error operativo sanitizado/);
  assert.ok(
    stderr.match(/error operativo sanitizado/g)?.length >= 2,
    `worker no reintentó en varias ventanas; stderr=${stderr}`,
  );
  assert.equal(stderr.includes('cloud_worker_secret'), false);

  worker.kill('SIGTERM');
  const [code, signal] = await once(worker, 'exit');
  assert.equal(signal, null);
  assert.equal(code, 0);
});
