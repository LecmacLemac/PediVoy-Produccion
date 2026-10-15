import assert from 'node:assert/strict';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import childProcess from 'node:child_process';

// Install BEFORE dynamic application imports. Keep the actual production factories,
// mount, router, helpers and WPP lifecycle; replace only IO at the module boundary.
export function isolateRepartidorProductionDI() {
  const state = { defaultDbCalls: [], workerCalls: [], networkViolations: [], schemaCalls: [], ports: new Set() };
  const dbUrl = new URL('../../src/db.js', import.meta.url).href;
  const transferUrl = new URL('../../src/routes/transferencias.js', import.meta.url).href;
  const gastosUrl = new URL('../../src/routes/gastos.js', import.meta.url).href;
  const originalConnect = net.Socket.prototype.connect;
  const originalSpawn = childProcess.spawn;
  const previousEnv = Object.fromEntries(['NODE_ENV', 'AUTO_START_EMPRESA_WPP_WORKER'].map(key => [key, process.env[key]]));
  process.env.NODE_ENV = 'test';
  process.env.AUTO_START_EMPRESA_WPP_WORKER = '0';
  // A unique module fixture avoids globals and never evaluates src/db.js/.env.
  const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
    export const calls = [];
    const forbidden = () => { calls.push('DEFAULT_DB'); throw new Error('DEFAULT_DB_FORBIDDEN'); };
    export const query = forbidden, withTransaction = forbidden;
    export const pool = { connect: forbidden, query: forbidden };
    export const runWithSensitiveDbQueries = work => work();
    export const schemaCalls = [];
    export const schemaQuery = async sql => { schemaCalls.push(sql); return []; };
  `)}`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true };
      const result = nextResolve(specifier, context);
      return result.url === dbUrl ? { url: fixtureUrl, shortCircuit: true } : result;
    },
    load(url, context, nextLoad) {
      // Unrelated routers perform startup DDL (transferencias defaults to DB).
      // Inject synthetic IO into their REAL factories, not no-op routers/source edits.
      if (url === transferUrl || url === gastosUrl) {
        const factory = url === transferUrl ? 'createTransferenciasRouter' : 'createGastosRouter';
        const queryKey = url === transferUrl ? 'queryFn' : 'query';
        return { format: 'module', shortCircuit: true, source: `
          import { ${factory} as realFactory } from ${JSON.stringify(url + '?di-fixture')};
          import { schemaQuery } from ${JSON.stringify(fixtureUrl)};
          export const ${factory} = deps => realFactory({ ...deps, ${queryKey}: schemaQuery });
        ` };
      }
      assert.notEqual(url, dbUrl, 'El módulo DB real no debe cargarse');
      return nextLoad(url, context);
    },
  });
  net.Socket.prototype.connect = function (...args) {
    const options = net._normalizeArgs(Array.isArray(args[0]) ? args[0] : args)[0];
    if (options.host !== '127.0.0.1' || !state.ports.has(Number(options.port))) {
      state.networkViolations.push('NON_FIXTURE_NETWORK');
      throw new Error('Only the active loopback fixture is allowed');
    }
    return originalConnect.apply(this, args);
  };
  childProcess.spawn = () => {
    state.workerCalls.push('spawn');
    throw new Error('Worker spawn forbidden in production DI test');
  };
  syncBuiltinESMExports();
  return {
    state,
    async fixture() {
      const fixture = await import(fixtureUrl);
      state.defaultDbCalls = fixture.calls;
      state.schemaCalls = fixture.schemaCalls;
    },
    restore() {
      hooks.deregister();
      net.Socket.prototype.connect = originalConnect;
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    },
  };
}
