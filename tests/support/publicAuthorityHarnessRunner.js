import express from 'express';
import { createAuthGuestSignupRouter } from '../../src/routes/authGuestSignup.js';

const assertions = [];
const check = (name, ok) => assertions.push({ name, ok: Boolean(ok) });
let transactionCalls = 0;
let rollbackCalls = 0;
let maxRetries = null;
let empresaInsertCalls = 0;
let usuarioInsertCalls = 0;
let nextMode = 'ok';

const pool = { connect: async () => ({}) };
const withTransaction = async (work, options) => {
  transactionCalls += 1;
  maxRetries = options?.maxRetries;
  check('canonical pool forwarded', options?.pool === pool);
  check('retries disabled', options?.maxRetries === 0);
  try {
    let queryIndex = 0;
    return await work(async (sql, params) => {
      queryIndex += 1;
      if (queryIndex === 1) {
        empresaInsertCalls += 1;
        check('empresa INSERT executed', /^\s*INSERT\s+INTO\s+empresas\b/i.test(sql));
        check('empresa body tenant ignored', !params.includes(999));
        if (nextMode === 'empresa-empty') return [];
        return [{ id: 314 }];
      }
      usuarioInsertCalls += 1;
      check('usuario INSERT executed', /^\s*INSERT\s+INTO\s+usuarios\b/i.test(sql));
      check('usuario linked to returned empresa', params[2] === 314);
      if (nextMode === 'usuario-empty') return [];
      return [{ id: 9, username: params[0], role: 'user', empresa_id: params[2] }];
    });
  } catch (error) {
    rollbackCalls += 1;
    throw error;
  }
};

const app = express();
app.use(express.json());
app.use('/api/auth', createAuthGuestSignupRouter({
  query: async () => [],
  withAuth: (_req, _res, next) => next(),
  pool,
  withTransaction,
}));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const originalError = console.error;
console.error = () => {};
try {
  const post = body => fetch(`${base}/api/auth/signup-full`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `authority-${Math.random()}` },
    body: JSON.stringify(body),
  });
  const valid = await post({
    username: 'authority_owner', password: 'Password123!', empresa_nombre: 'Authority Co', empresa_id: 999,
  });
  const validBody = await valid.json();
  check('valid request succeeds', valid.status === 200 && validBody?.user?.empresa_id === 314);

  nextMode = 'empresa-empty';
  const empresaFailure = await post({ username: 'authority_emp_fail', password: 'Password123!', empresa_nombre: 'Fail Empresa' });
  check('empresa exact-row failure rejected', empresaFailure.status === 500);

  nextMode = 'usuario-empty';
  const usuarioFailure = await post({ username: 'authority_user_fail', password: 'Password123!', empresa_nombre: 'Fail Usuario' });
  check('usuario exact-row failure rejected', usuarioFailure.status === 500);
  check('adversarial failures rolled back', rollbackCalls === 2);
} finally {
  console.error = originalError;
  await new Promise(resolve => server.close(resolve));
}

process.stdout.write(JSON.stringify({
  assertions,
  results: {
    transactionCalls,
    successfulTransactionCalls: transactionCalls - rollbackCalls,
    rollbackCalls,
    maxRetries,
    empresaInsertCalls,
    usuarioInsertCalls,
  },
}));
