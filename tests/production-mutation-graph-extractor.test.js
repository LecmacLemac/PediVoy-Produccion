import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverProductionGraph,
  extractMutationRegistrations,
  resolveMountedMutations,
  validateMutationInventory,
  validateMountFixture,
} from './support/productionMutationGraph.js';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-graph-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

test('extractor soporta app/router, optional chaining, templates constantes, arrays y route chaining', () => {
  const rows = extractMutationRegistrations(`
    app.post('/direct', handler);
    router?.put(\`/constant\`, handler);
    r.patch(['/one', "/two"], handler);
    router.route('/chain').delete(handler).post(handler);
  `, 'src/routes/sample.js');
  assert.deepEqual(rows.map(({ method, path: routePath }) => `${method} ${routePath}`).sort(), [
    'DELETE /chain', 'PATCH /one', 'PATCH /two', 'POST /chain', 'POST /direct', 'PUT /constant',
  ]);
});

test('grafo sigue imports productivos y registradores externos recursivamente', () => {
  const root = fixture({
    'src/app.js': "import { mount } from './mount.js'; mount(app);",
    'src/mount.js': "import { register } from './nested/register.js'; export const mount = app => register(app);",
    'src/nested/register.js': "export function register(app) { app.post('/external', handler); }",
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    assert.deepEqual([...graph.sources].sort(), ['src/app.js', 'src/mount.js', 'src/nested/register.js']);
    assert.deepEqual(graph.mutations.map(row => `${row.source}|${row.method}|${row.path}`), [
      'src/nested/register.js|POST|/external',
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('validación falla ante fuente omitida, fila fantasma, endpoint nuevo y duplicado ambiguo', () => {
  const actual = [
    { source: 'src/a.js', method: 'POST', path: '/a' },
    { source: 'src/b.js', method: 'DELETE', path: '/b' },
  ];
  assert.throws(() => validateMutationInventory({ actual, inventory: [actual[0]] }), /no inventariada.*src\/b\.js/s);
  assert.throws(() => validateMutationInventory({ actual: [actual[0]], inventory: [...actual, { source: 'src/c.js', method: 'PUT', path: '/ghost' }] }), /sin endpoint real.*src\/b\.js/s);
  assert.throws(() => validateMutationInventory({ actual, inventory: actual, baselineKeys: new Set([`${actual[0].source}|${actual[0].method}|${actual[0].path}`]) }), /endpoint nuevo.*src\/b\.js/s);
  assert.throws(() => validateMutationInventory({ actual: [actual[0], actual[0]], inventory: [actual[0]] }), /duplicado ambiguo/);
});

test('mounts estáticos se derivan de app.use y componen el path final sin prefijo manual', () => {
  const root = fixture({
    'src/app.js': "import { createThingRouter } from './thing.js'; app.use('/api/real', createThingRouter());",
    'src/thing.js': "export function createThingRouter() { const router = {}; router.post('/run', handler); return router; }",
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    const mounted = resolveMountedMutations(graph.mutations, graph.mounts);
    assert.equal(mounted[0].mountedPath, '/api/real/run');
    assert.throws(() => validateMountFixture({
      root,
      derivedMounts: graph.mounts,
      fixture: [{
        source: 'src/thing.js',
        export: 'createThingRouter',
        prefix: '/incorrecto',
        anchor: { source: 'src/app.js', expression: "app.use('/api/real', createThingRouter())" },
      }],
    }), /prefijo.*no coincide/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('un import sin mount o registrador ejecutado no vuelve alcanzable una fuente mutante', () => {
  const root = fixture({
    'src/app.js': "import { mount } from './mount.js'; void 0;",
    'src/mount.js': "export function mount(app) { app.post('/external', handler); }",
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    assert.equal(graph.sources.has('src/mount.js'), false);
    assert.equal(graph.mutations.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('clasificación queda vinculada a autoridad real y no acepta admin reclasificado como público', () => {
  const root = fixture({
    'src/app.js': "import { createRouter } from './route.js'; app.use('/api/admin', createRouter());",
    'src/route.js': `
      import { requireCanonicalBackofficeRole } from './guard.js';
      export function createRouter() {
        const router = {};
        router.post('/mutate', withAuth, requireCanonicalBackofficeRole, handler);
        return router;
      }
    `,
    'src/guard.js': 'export function requireCanonicalBackofficeRole() {}',
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    const row = { source: 'src/route.js', method: 'POST', path: '/mutate', classification: 'admin_exacto' };
    assert.equal(validateMutationInventory({ actual: graph.mutations, inventory: [row], root }), true);
    assert.throws(() => validateMutationInventory({
      actual: graph.mutations,
      inventory: [{ ...row, classification: 'publico_capability_explicita' }],
      root,
    }), /autoridad.*no respalda[\s\S]*publico/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('compone automáticamente cadenas de subrouter uses', () => {
  const root = fixture({
    'src/app.js': "import { createParent } from './parent.js'; app.use('/api', createParent());",
    'src/parent.js': "import { createChild } from './child.js'; export function createParent() { const router = {}; router.use('/nested', createChild()); return router; }",
    'src/child.js': "export function createChild() { const router = {}; router.delete('/item/:id', handler); return router; }",
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    const mounted = resolveMountedMutations(graph.mutations, graph.mounts);
    assert.equal(mounted[0].mountedPath, '/api/nested/item/:id');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('grafo excluye registradores dormidos y sigue llamadas directas o anidadas alcanzables', () => {
  const cases = [
    {
      name: 'dormido',
      app: "import { mount } from './mount.js'; const neverCalled = () => mount(app); void neverCalled;",
      expected: false,
    },
    {
      name: 'directo',
      app: "import { mount } from './mount.js'; mount(app);",
      expected: true,
    },
    {
      name: 'anidado invocado',
      app: "import { mount } from './mount.js'; const nested = () => mount(app); nested();",
      expected: true,
    },
  ];

  for (const scenario of cases) {
    const root = fixture({
      'src/app.js': scenario.app,
      'src/mount.js': "export function mount(app) { app.post('/external', handler); }",
    });
    try {
      const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
      assert.equal(graph.sources.has('src/mount.js'), scenario.expected, scenario.name);
      assert.equal(graph.mutations.some(row => row.path === '/external'), scenario.expected, scenario.name);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('grafo falla cerrado ante bootstrap condicional que no puede resolver estáticamente', () => {
  const root = fixture({
    'src/app.js': "import { mount } from './mount.js'; if (featureFlag) mount(app);",
    'src/mount.js': "export function mount(app) { app.post('/conditional', handler); }",
  });
  try {
    assert.throws(
      () => discoverProductionGraph({ root, entries: ['src/app.js'] }),
      /bootstrap condicional no resoluble|anchor explícito/i
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('condición desconocida falla cerrado cuando el registrador es indirecto a uno o dos niveles', () => {
  for (const [name, mountSource] of [
    ['un nivel', "import { register } from './register.js'; export function mount(app) { register(app); }"],
    ['dos niveles', "import { bridge } from './bridge.js'; export function mount(app) { bridge(app); }"],
  ]) {
    const root = fixture({
      'src/app.js': "import { mount } from './mount.js'; if (featureFlag) mount(app);",
      'src/mount.js': mountSource,
      'src/bridge.js': "import { register } from './register.js'; export function bridge(app) { register(app); }",
      'src/register.js': "export function register(app) { app.post('/conditional', handler); }",
    });
    try {
      assert.throws(
        () => discoverProductionGraph({ root, entries: ['src/app.js'] }),
        error => /bootstrap condicional no resoluble/i.test(error.message)
          && /src\/app\.js#default/.test(error.message)
          && /featureFlag/.test(error.message)
          && /mount\(app\)/.test(error.message),
        name
      );
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('fixed-point detecta ciclos registradores y no marca helpers cíclicos no registradores', () => {
  for (const [name, register] of [['registrador', true], ['no registrador', false]]) {
    const root = fixture({
      'src/app.js': "import { a } from './cycle.js'; if (featureFlag) a(app);",
      'src/cycle.js': register
        ? "export function a(app) { b(app); } export function b(app) { a(app); app.post('/cycle', handler); }"
        : "export function a(app) { b(app); } export function b(app) { a(app); return 1; }",
    });
    try {
      if (register) assert.throws(
        () => discoverProductionGraph({ root, entries: ['src/app.js'] }),
        error => /featureFlag/.test(error.message) && /a\(app\)/.test(error.message),
        name
      );
      else assert.doesNotThrow(() => discoverProductionGraph({ root, entries: ['src/app.js'] }), name);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('condiciones true/false locales e importadas siguen sólo la rama registradora alcanzable', () => {
  const cases = [
    ['true local', "const enabled = true; import { mount } from './mount.js'; if (enabled) mount(app);", true],
    ['false local', "const enabled = false; import { mount } from './mount.js'; if (enabled) mount(app);", false],
    ['true importada', "import { enabled } from './flags.js'; import { mount } from './mount.js'; if (enabled) mount(app);", true],
    ['false importada', "import { disabled } from './flags.js'; import { mount } from './mount.js'; if (disabled) mount(app);", false],
  ];
  for (const [name, app, included] of cases) {
    const root = fixture({
      'src/app.js': app,
      'src/flags.js': 'export const enabled = true; export const disabled = false;',
      'src/mount.js': "import { register } from './register.js'; export function mount(app) { register(app); }",
      'src/register.js': "export function register(app) { app.post('/static', handler); }",
    });
    try {
      const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
      assert.equal(graph.mutations.some(row => row.path === '/static'), included, name);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('ternario, cortocircuito lógico y switch desconocidos cierran ante registrador indirecto', () => {
  const bootstraps = [
    'featureFlag ? mount(app) : noop();',
    'featureFlag && mount(app);',
    'featureFlag || mount(app);',
    'switch (featureFlag) { case true: mount(app); break; default: noop(); }',
  ];
  for (const bootstrap of bootstraps) {
    const root = fixture({
      'src/app.js': `import { mount } from './mount.js'; function noop() {} ${bootstrap}`,
      'src/mount.js': "import { register } from './register.js'; export function mount(app) { register(app); }",
      'src/register.js': "export function register(app) { app.post('/conditional', handler); }",
    });
    try {
      assert.throws(() => discoverProductionGraph({ root, entries: ['src/app.js'] }), /bootstrap condicional no resoluble/i, bootstrap);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('ternario, cortocircuito lógico y switch estáticos incluyen o excluyen la llamada correcta', () => {
  const cases = [
    ['true ? mount(app) : noop();', true],
    ['false ? mount(app) : noop();', false],
    ['true && mount(app);', true],
    ['false && mount(app);', false],
    ['false || mount(app);', true],
    ['true || mount(app);', false],
    ['switch (true) { case true: mount(app); break; default: noop(); }', true],
    ['switch (false) { case true: mount(app); break; default: noop(); }', false],
  ];
  for (const [bootstrap, included] of cases) {
    const root = fixture({
      'src/app.js': `import { mount } from './mount.js'; function noop() {} ${bootstrap}`,
      'src/mount.js': "export function mount(app) { app.post('/static-control', handler); }",
    });
    try {
      const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
      assert.equal(graph.mutations.some(row => row.path === '/static-control'), included, bootstrap);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('condiciones dentro de handlers runtime no contaminan la fase de registro', () => {
  const root = fixture({
    'src/app.js': "import { mount } from './mount.js'; mount(app);",
    'src/mount.js': `
      export function mount(app) {
        app.post('/runtime', (req, res) => {
          if (req.body.featureFlag) runtimeHelper(app);
          res.end();
        });
      }
      function runtimeHelper(app) { app.post('/never-bootstrap', handler); }
    `,
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    assert.deepEqual(graph.mutations.map(row => row.path), ['/runtime']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('allowlist nominal no aprueba /tomar sin predicates de empresa, chofer y estado aunque el ID sea conocido', () => {
  const root = fixture({
    'src/app.js': "import { createRouter } from './routes/repartidorApi.js'; app.use('/api/repartidor', createRouter());",
    'src/routes/repartidorApi.js': `
      export function createRouter() {
        const router = {};
        router.post('/tomar/:id', withAuth, requireExactRepartidor, (req, res) => query('UPDATE pedidos SET estado=$1 WHERE id=$2', ['tomado', req.params.id]));
        return router;
      }
    `,
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    const row = graph.mutations[0];
    assert.throws(() => validateMutationInventory({
      actual: graph.mutations,
      inventory: [{
        source: row.source,
        method: row.method,
        path: row.path,
        classification: 'repartidor_exacto_ownership',
        authorityEvidence: {
          module: 'tests/support/mutationAuthorityContracts.js',
          export: 'ownershipAuthorityContract',
          case: 'repartidor-tomar',
        },
      }],
      root,
    }), /predicates|ownership|autoridad/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('contrato ejecutable de /tomar acepta empresa+chofer+estado y rechaza metadata ausente o case incorrecto', () => {
  const root = fixture({
    'src/app.js': "import { createRouter } from './routes/repartidorApi.js'; app.use('/api/repartidor', createRouter());",
    'src/routes/repartidorApi.js': `
      export function createRouter() {
        const router = {};
        router.post('/tomar/:id', withAuth, requireExactRepartidor, (req, res) => query(
          'UPDATE pedidos SET estado=$1, chofer_id=$2 WHERE id=$3 AND empresa_id=$4 AND estado=$5 RETURNING id',
          ['tomado', req.user.chofer_id, req.params.id, req.user.empresa_id, 'pendiente']
        ));
        return router;
      }
    `,
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    const row = graph.mutations[0];
    const base = { source: row.source, method: row.method, path: row.path, classification: 'repartidor_exacto_ownership' };
    assert.throws(() => validateMutationInventory({ actual: graph.mutations, inventory: [base], root }), /evidencia ejecutable|authorityEvidence/i);
    assert.throws(() => validateMutationInventory({
      actual: graph.mutations,
      inventory: [{ ...base, authorityEvidence: { module: 'tests/support/mutationAuthorityContracts.js', export: 'ownershipAuthorityContract', case: 'no-existe' } }],
      root,
    }), /case|registrad/i);
    assert.equal(validateMutationInventory({
      actual: graph.mutations,
      inventory: [{ ...base, authorityEvidence: { module: 'tests/support/mutationAuthorityContracts.js', export: 'ownershipAuthorityContract', case: 'repartidor-tomar' } }],
      root,
    }), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('endpoint público conocido falla si mezcla auth/admin o mutación DELETE aunque el path esté allowlisted', () => {
  const root = fixture({
    'src/app.js': "import { createRouter } from './routes/publicLegacyCreatePedido.js'; app.use('/', createRouter());",
    'src/routes/publicLegacyCreatePedido.js': `
      export function createRouter() {
        const router = {};
        router.post('/public/pedidos', withAuth, requireCanonicalBackofficeRole, (req, res) => query('DELETE FROM pedidos WHERE id=$1', [req.body.id]));
        return router;
      }
    `,
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    const row = graph.mutations[0];
    assert.throws(() => validateMutationInventory({
      actual: graph.mutations,
      inventory: [{
        source: row.source,
        method: row.method,
        path: row.path,
        classification: 'publico_capability_explicita',
        authorityEvidence: {
          module: 'tests/support/mutationAuthorityContracts.js',
          export: 'publicAuthorityContract',
          case: 'public-create-pedido',
        },
      }],
      root,
    }), /públic|public|auth|admin|DELETE/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('autoridad repartidor se evalúa por endpoint y no por palabras vecinas del archivo', () => {
  const root = fixture({
    'src/app.js': "import { createRouter } from './route.js'; app.use('/api', createRouter());",
    'src/route.js': `
      export function createRouter() {
        const router = {};
        router.post('/guarded', withAuth, requireExactRepartidor, (req, res) => query('UPDATE pedidos SET estado=$1 WHERE empresa_id=$2', ['ok', req.user.empresa_id]));
        router.post('/unguarded', (req, res) => query('UPDATE pedidos SET estado=$1', ['bad']));
        return router;
      }
    `,
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    const inventory = graph.mutations.map(row => ({
      source: row.source,
      method: row.method,
      path: row.path,
      classification: 'repartidor_exacto_ownership',
    }));
    assert.throws(
      () => validateMutationInventory({ actual: graph.mutations, inventory, root }),
      /unguarded/i
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('autoridad aplicable incluye router.use por orden/prefix, route chain e handler importado', () => {
  const root = fixture({
    'src/app.js': "import { createRouter } from './route.js'; app.use('/api', createRouter());",
    'src/route.js': `
      import { updateOwned } from './handler.js';
      export function createRouter() {
        const router = {};
        router.use('/owned', withAuth, requireExactRepartidor);
        router.route('/owned/item').post(updateOwned);
        return router;
      }
    `,
    'src/handler.js': `
      export async function updateOwned(req, res) {
        return query('UPDATE pedidos SET estado=$1 WHERE id=$2 AND empresa_id=$3', ['ok', req.params.id, req.user.empresa_id]);
      }
    `,
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    const row = graph.mutations.find(item => item.path === '/owned/item');
    assert.ok(row);
    assert.equal(validateMutationInventory({
      actual: graph.mutations,
      inventory: [{
        source: row.source,
        method: row.method,
        path: row.path,
        classification: 'repartidor_exacto_ownership',
        authorityEvidence: {
          module: 'tests/support/mutationAuthorityContracts.js',
          export: 'ownershipAuthorityContract',
          case: 'src/route.js|POST|/owned/item',
        },
      }],
      root,
    }), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('registros mutantes directos fallan cerrado bajo condición desconocida con ubicación y condición', () => {
  const root = fixture({
    'src/app.js': `
      if (featureFlag) app.post('/conditional', handler);
    `,
  });
  try {
    assert.throws(
      () => discoverProductionGraph({ root, entries: ['src/app.js'] }),
      error => /registro mutante condicional no resoluble/i.test(error.message)
        && /src\/app\.js:2/.test(error.message)
        && /featureFlag/.test(error.message),
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('registros directos respetan ramas estáticas if/else, ternario, lógicos y switch', () => {
  const root = fixture({
    'src/app.js': `
      if (false) app.post('/if-false', handler); else app.post('/else-selected', handler);
      if (true) app.put(['/array-a', '/array-b'], handler); else app.put('/else-dead', handler);
      false ? app.patch('/ternary-dead', handler) : app.patch('/ternary-selected', handler);
      false && app.delete('/and-dead', handler);
      true && app.delete('/and-selected', handler);
      true || app.post('/or-dead', handler);
      false || app.post('/or-selected', handler);
      switch ('b') {
        case 'a': app.route('/switch-dead').post(handler).delete(handler); break;
        case 'b': app.route('/switch-selected').post(handler).delete(handler); break;
        default: app.post('/switch-default-dead', handler);
      }
    `,
  });
  try {
    const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
    assert.deepEqual(graph.mutations.map(row => `${row.method} ${row.path}`).sort(), [
      'DELETE /and-selected',
      'DELETE /switch-selected',
      'PATCH /ternary-selected',
      'POST /else-selected',
      'POST /or-selected',
      'POST /switch-selected',
      'PUT /array-a',
      'PUT /array-b',
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('use de middleware simple no cuenta como mutación condicional directa ni indirecta', () => {
  for (const [name, app] of [
    ['directo', "import { auth } from './auth.js'; if (featureFlag) app.use(auth);"],
    ['helper', "import { mountAuth } from './auth.js'; if (featureFlag) mountAuth(app);"],
  ]) {
    const root = fixture({
      'src/app.js': app,
      'src/auth.js': `
        export function auth(req, res, next) { next(); }
        export function mountAuth(app) { app.use(auth); }
      `,
    });
    try {
      const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
      assert.equal(graph.mutations.length, 0, name);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('mount condicional de subrouter mutante falla cerrado directa e indirectamente', () => {
  for (const [name, app, extra] of [
    ['directo', "import { createRouter } from './router.js'; if (featureFlag) app.use('/x', createRouter());", {}],
    ['router importado', "import mutatingRouter from './router-instance.js'; if (featureFlag) app.use('/x', mutatingRouter);", {
      'src/router-instance.js': "const router = {}; router.post('/mutate', handler); export default router;",
    }],
    ['helper', "import { mountRouter } from './mount.js'; if (featureFlag) mountRouter(app);", {
      'src/mount.js': "import { createRouter } from './router.js'; export function mountRouter(app) { app.use('/x', createRouter()); }",
    }],
  ]) {
    const root = fixture({
      'src/app.js': app,
      'src/router.js': "export function createRouter() { const router = {}; router.post('/mutate', handler); return router; }",
      ...extra,
    });
    try {
      assert.throws(
        () => discoverProductionGraph({ root, entries: ['src/app.js'] }),
        error => /condicional no resoluble/i.test(error.message) && /featureFlag/.test(error.message),
        name,
      );
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
