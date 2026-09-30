import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveAuthorityEvidence,
  discoverProductionGraph,
  findAllMutationSources,
  resolveMountedMutations,
  validateMutationInventory,
} from './support/productionMutationGraph.js';
import {
  analyzeSqlMutationAuthority,
  publicAuthorityContract,
  validateAuthorityProof,
} from './support/mutationAuthorityContracts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/production-mutation-inventory.json'), 'utf8'));
const intentionallyUnmounted = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/intentionally-unmounted-mutation-sources.json'), 'utf8'));

const allowed = new Set([
  'admin_exacto',
  'repartidor_exacto_ownership',
  'referente_exacto_ownership',
  'repartidor_o_admin_ownership',
  'publico_capability_explicita',
  'webhook_firmado',
  'cron_secret',
]);

const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
const key = row => `${row.source}|${row.method}|${row.path}`;

test('inventario global exacto nace del grafo productivo y clasifica toda mutación', () => {
  validateMutationInventory({ actual: graph.mutations, inventory, root });
  assert.equal(new Set(inventory.map(key)).size, inventory.length, 'no puede haber endpoints duplicados en inventario');
  for (const row of inventory) assert.ok(allowed.has(row.classification), `clasificación inválida: ${key(row)}`);
});

test('authority evidence ownership/public es ejecutable, completa y falla ante drift de metadata', () => {
  const executableClasses = new Set([
    'repartidor_exacto_ownership',
    'referente_exacto_ownership',
    'repartidor_o_admin_ownership',
    'publico_capability_explicita',
  ]);
  const protectedRows = inventory.filter(row => executableClasses.has(row.classification));
  assert.equal(protectedRows.length, 32);
  for (const row of protectedRows) {
    assert.equal(row.authorityEvidence?.module, 'tests/support/mutationAuthorityContracts.js', key(row));
    assert.match(row.authorityEvidence?.export || '', /^(?:ownership|public)AuthorityContract$/, key(row));
    assert.ok(row.authorityEvidence?.case, key(row));
  }

  const evidence = deriveAuthorityEvidence({ root, actual: graph.mutations, inventory });
  for (const row of protectedRows) {
    assert.match(evidence.get(key(row))?.marker || '', /^executed:/, key(row));
  }

  const drifted = inventory.map(row => ({ ...row }));
  const target = drifted.find(row => executableClasses.has(row.classification));
  delete target.authorityEvidence;
  assert.throws(
    () => validateMutationInventory({ actual: graph.mutations, inventory: drifted, root }),
    /authorityEvidence|evidencia ejecutable/i,
  );
});

test('analizador semántico rechaza nombres decorativos y exige predicates con params enlazados', () => {
  const fakeNames = analyzeSqlMutationAuthority({
    evidence: `async () => {
      const empresaId = req.user.empresa_id; // chofer_id empresa_id
      await query('UPDATE pedidos SET estado = $1 WHERE id = $2', [estado, pedidoId]);
    }`,
    requiredColumns: ['empresa_id', 'id'],
    requiredParams: ['empresaId', 'pedidoId'],
  });
  assert.equal(fakeNames.ok, false);

  const missingPredicate = analyzeSqlMutationAuthority({
    evidence: `async () => query('UPDATE pedidos SET estado = $1 WHERE id = $2', [estado, pedidoId, empresaId])`,
    requiredColumns: ['empresa_id', 'id'],
    requiredParams: ['empresaId', 'pedidoId'],
  });
  assert.equal(missingPredicate.ok, false);

  const scoped = analyzeSqlMutationAuthority({
    evidence: `async () => query('UPDATE pedidos SET estado = $1 WHERE id = $2 AND empresa_id = $3', [estado, pedidoId, empresaId])`,
    requiredColumns: ['empresa_id', 'id'],
    requiredParams: ['empresaId', 'pedidoId'],
  });
  assert.equal(scoped.ok, true);
});

test('analizador SQL ignora comentarios sin romper literales y enlaza placeholders exactos', () => {
  for (const evidence of [
    `async () => query('UPDATE pedidos SET estado=$1 WHERE id=$2 -- AND empresa_id=$3', [estado, pedidoId, empresaId])`,
    `async () => query('UPDATE pedidos SET estado=$1 WHERE id=$2 /* AND empresa_id=$3 */', [estado, pedidoId, empresaId])`,
    `async () => query('UPDATE pedidos SET nota=$1 WHERE id=$2; UPDATE pedidos SET estado=$3 WHERE empresa_id=$4', [nota, pedidoId, estado, empresaId])`,
    `async () => query('WITH muerto AS (SELECT 1 WHERE empresa_id=$3) UPDATE pedidos SET estado=$1 WHERE id=$2', [estado, pedidoId, empresaId])`,
  ]) {
    assert.equal(analyzeSqlMutationAuthority({
      evidence,
      requiredColumns: ['empresa_id', 'id'],
      requiredParams: ['empresaId', 'pedidoId'],
    }).ok, false, evidence);
  }

  const literalMarkers = analyzeSqlMutationAuthority({
    evidence: `async () => query(\`UPDATE pedidos
      SET nota = 'texto -- no comentario /* tampoco */', payload = $$ -- literal $$
      WHERE id = $1
        /* comentario real */ AND empresa_id = $2\`, [pedidoId, empresaId])`,
    requiredColumns: ['empresa_id', 'id'],
    requiredParams: ['empresaId', 'pedidoId'],
  });
  assert.equal(literalMarkers.ok, true);

  const misordered = analyzeSqlMutationAuthority({
    evidence: `async () => query('UPDATE pedidos SET estado=$1 WHERE id=$2 AND empresa_id=$3', [estado, empresaId, pedidoId])`,
    requiredColumns: ['empresa_id', 'id'],
    requiredParams: ['empresaId', 'pedidoId'],
  });
  assert.equal(misordered.ok, false);
});

test('contrato público no confunde body/admin nominal con capability', () => {
  const outcome = publicAuthorityContract({
    caseId: 'src/routes/authGuestSignup.js|POST|/signup-full',
    endpointKey: 'src/routes/authGuestSignup.js|POST|/signup-full',
    row: { method: 'POST' },
    middlewareText: '',
    evidence: `async (req) => {
      const admin = req.body.admin === true;
      await query('UPDATE usuarios SET admin = $1 WHERE id = $2', [admin, req.body.id]);
    }`,
  });
  assert.equal(outcome.ok, false);
  assert.doesNotMatch(outcome.marker || '', /^executed:/);
});

test('signup-full rechaza evidencia decorativa y sólo acepta proof ejecutado del router real', () => {
  const decorative = publicAuthorityContract({
    root,
    caseId: 'src/routes/authGuestSignup.js|POST|/signup-full',
    endpointKey: 'src/routes/authGuestSignup.js|POST|/signup-full',
    row: { method: 'POST' },
    middlewareText: '',
    evidence: `async () => {
      const withTransaction = async fn => fn(async () => []);
      const labels = ['INSERT INTO empresas', 'INSERT INTO usuarios', 'maxRetries: 0'];
      return { withTransaction, labels };
    }`,
  });
  assert.equal(decorative.ok, false);
  assert.equal(decorative.proof, undefined);

  const actual = publicAuthorityContract({
    root,
    caseId: 'src/routes/authGuestSignup.js|POST|/signup-full',
    endpointKey: 'src/routes/authGuestSignup.js|POST|/signup-full',
    row: { method: 'POST' },
    middlewareText: '',
    evidence: fs.readFileSync(path.join(root, 'src/routes/authGuestSignup.js'), 'utf8'),
  });
  assert.equal(actual.ok, true, actual.reason);
  assert.equal(validateAuthorityProof(actual.proof, {
    caseId: 'src/routes/authGuestSignup.js|POST|/signup-full',
    endpointKey: 'src/routes/authGuestSignup.js|POST|/signup-full',
  }), true);
  assert.equal(actual.proof.results.transactionCalls, 3);
  assert.equal(actual.proof.results.successfulTransactionCalls, 1);
  assert.equal(actual.proof.results.rollbackCalls, 2);
  assert.equal(actual.proof.results.maxRetries, 0);
});

test('proof público missing, malformed o de otro endpoint falla cerrado', () => {
  assert.equal(validateAuthorityProof(null, { caseId: 'x', endpointKey: 'x' }), false);
  assert.equal(validateAuthorityProof({ schema: 1 }, { caseId: 'x', endpointKey: 'x' }), false);
  assert.equal(validateAuthorityProof({
    schema: 1,
    caseId: 'x',
    endpointKey: 'otro',
    testCase: 'executed:x',
    assertions: [{ name: 'real', ok: true }],
    results: {},
    hash: 'decorativo',
  }, { caseId: 'x', endpointKey: 'x' }), false);
});

test('grafo productivo sigue mounts, registradores y subrouters fuera de src/routes', () => {
  for (const required of [
    'src/app.js',
    'src/routes/mountApiModules.js',
    'src/routes/index.js',
    'src/routes/landingRoutes.js',
    'src/routes/publicLegacyCreatePedido.js',
    'src/qr/pagosWebhookRouter.js',
    'src/wpp/whatsappWeb.js',
    'src/wpp/routes.js',
    'src/wpp/cronRoutes.js',
    'src/trackingPublic.js',
  ]) assert.ok(graph.sources.has(required), `fuente productiva ausente del grafo: ${required}`);

  const mutationSources = new Set(graph.mutations.map(row => row.source));
  for (const row of inventory) assert.ok(mutationSources.has(row.source), `fixture apunta a fuente sin mutaciones: ${row.source}`);
});

test('mounts derivados del código resuelven paths productivos finales únicos', () => {
  const mounted = resolveMountedMutations(graph.mutations, graph.mounts);
  assert.equal(mounted.length, inventory.length);
  for (const endpoint of [
    'POST /api/empresas/:id/landing-page',
    'POST /public/pedidos',
    'POST /api/webhooks/pagos',
    'POST /api/webhooks/pagos/:proveedor',
    'POST /api/whatsapp/reset',
    'POST /internal/cron/cleanup-tracking',
    'POST /internal/cron/cleanup-wpp',
    'POST /api/juegos-publicos/participar',
    'POST /api/juegos-publicos/premio-entrega',
  ]) assert.ok(mounted.some(row => `${row.method} ${row.mountedPath}` === endpoint), endpoint);
});

test('toda fuente mutante bajo src está en el grafo o excluida con razón verificable', () => {
  const all = findAllMutationSources(root);
  const exclusions = new Map(intentionallyUnmounted.map(row => [row.source, row.reason]));
  for (const [source] of all) {
    if (graph.sources.has(source)) continue;
    assert.ok(exclusions.get(source), `fuente mutante fuera del grafo sin clasificación: ${source}`);
  }
  for (const [source, reason] of exclusions) {
    assert.ok(all.has(source), `exclusión sin mutaciones reales: ${source}`);
    assert.equal(graph.sources.has(source), false, `exclusión ahora está montada y debe auditarse: ${source}`);
    assert.ok(String(reason).trim().length >= 20, `exclusión sin justificación suficiente: ${source}`);
  }
});

test('omitidas históricas conservan clasificación de autoridad explícita', () => {
  const expected = new Map([
    ['src/routes/landingRoutes.js|POST|/api/empresas/:id/landing-page', 'admin_exacto'],
    ['src/routes/landingRoutes.js|DELETE|/api/empresas/:id/landing-page', 'admin_exacto'],
    ['src/routes/publicLegacyCreatePedido.js|POST|/public/pedidos', 'publico_capability_explicita'],
    ['src/qr/pagosWebhookRouter.js|POST|/pagos', 'webhook_firmado'],
    ['src/qr/pagosWebhookRouter.js|POST|/pagos/:proveedor', 'webhook_firmado'],
    ['src/wpp/routes.js|POST|/api/whatsapp/reset', 'admin_exacto'],
    ['src/wpp/cronRoutes.js|POST|/internal/cron/cleanup-tracking', 'cron_secret'],
    ['src/wpp/cronRoutes.js|POST|/internal/cron/cleanup-wpp', 'cron_secret'],
  ]);
  const classified = new Map(inventory.map(row => [key(row), row.classification]));
  for (const [endpoint, classification] of expected) assert.equal(classified.get(endpoint), classification, endpoint);

  const landing = fs.readFileSync(path.join(root, 'src/routes/landingRoutes.js'), 'utf8');
  assert.match(landing, /app\.post\([\s\S]*?withAuth,[\s\S]*?requireCanonicalBackofficeRole,[\s\S]*?pagesUploader\.single/);
  assert.match(landing, /app\.delete\([^\n]+withAuth, requireCanonicalBackofficeRole/);
  const webhook = fs.readFileSync(path.join(root, 'src/qr/pagosWebhookRouter.js'), 'utf8');
  assert.match(webhook, /x-pagos-signature/);
  assert.match(webhook, /timingSafeEqualHex\(providedSig, expectedSig\)/);
  const cron = fs.readFileSync(path.join(root, 'src/wpp/cronRoutes.js'), 'utf8');
  assert.match(cron, /requireCronSecret\(req, res\)/);
  const wpp = fs.readFileSync(path.join(root, 'src/wpp/routes.js'), 'utf8');
  assert.match(wpp, /app\.post\('\/api\/whatsapp\/reset', withAuth/);
  assert.match(wpp, /if \(!isSuper\(req\)\) return res\.status\(403\)/);
});

test('DI productiva de juegos públicos transporta withTransaction canónico sin wrapper local', () => {
  const domain = fs.readFileSync(path.join(root, 'src/bootstrap/createDomainDeps.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const mountsSource = fs.readFileSync(path.join(root, 'src/routes/mountApiModules.js'), 'utf8');
  const juegos = fs.readFileSync(path.join(root, 'src/routes/juegos.js'), 'utf8');
  assert.match(domain, /import \{ query, pool, withTransaction \} from '\.\.\/db\.js'/);
  assert.match(domain, /\bwithTransaction,\s*\n/);
  assert.match(app, /mountApiModules\(app, \{[\s\S]*?\bwithTransaction,/);
  assert.match(mountsSource, /createJuegosPublicosRouter\(\{ query, pool, withTransaction \}\)/);
  assert.match(juegos, /withTransaction: injectedWithTransaction/);
  assert.match(juegos, /typeof injectedWithTransaction === 'function'[\s\S]*?\? injectedWithTransaction[\s\S]*?: \(fn\) => runCanonicalTransaction/);
  assert.doesNotMatch(juegos.slice(juegos.indexOf('export function createJuegosPublicosRouter')), /async function withTransaction\s*\(/);
});

test('DI productiva de signup-full transporta withTransaction canónico sin undefined', () => {
  const domain = fs.readFileSync(path.join(root, 'src/bootstrap/createDomainDeps.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const mountsSource = fs.readFileSync(path.join(root, 'src/routes/mountApiModules.js'), 'utf8');
  const signup = fs.readFileSync(path.join(root, 'src/routes/authGuestSignup.js'), 'utf8');
  assert.match(domain, /import \{ query, pool, withTransaction \} from '\.\.\/db\.js'/);
  assert.match(app, /mountApiModules\(app, \{[\s\S]*?\bwithTransaction,/);
  assert.match(mountsSource, /createAuthGuestSignupRouter\(\{ query, withAuth, pool, withTransaction \}\)/);
  assert.match(signup, /withTransaction = canonicalWithTransaction/);
  assert.match(signup, /\}, \{ pool, maxRetries: 0 \}\)/);
  assert.doesNotMatch(signup, /client\.query\(['"](?:BEGIN|COMMIT|ROLLBACK)['"]\)/);
});

test('las 21 mutaciones de activos/costos/alquileres están inventariadas como admin exacto', () => {
  const vertical = inventory.filter(row => ['src/adm/activosRouter.js', 'src/adm/costosRouter.js', 'src/adm/alquileresRouter.js'].includes(row.source));
  assert.equal(vertical.length, 21);
  assert.ok(vertical.every(row => row.classification === 'admin_exacto'));
});
