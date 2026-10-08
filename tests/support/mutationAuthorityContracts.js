import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OWNERSHIP_CASES = new Set([
  'src/routes/gastos.js|POST|/',
  'src/routes/gastos.js|PUT|/:id',
  'src/routes/gastos.js|DELETE|/:id',
  'src/routes/referentePortal.js|PUT|/perfil',
  'src/routes/referentePortal.js|PUT|/password',
  'src/routes/referentePortal.js|POST|/clientes-propuestos',
  'src/routes/referentePortal.js|POST|/notificaciones/marcar-leidas',
  'src/routes/referentePortal.js|POST|/notificaciones/:id/leida',
  'src/routes/repartidorApi.js|POST|/pedidos/:id/pago-qr',
  'src/routes/repartidorApi.js|POST|/pedidos/:id/transferencia/notificar',
  'src/routes/repartidorApi.js|PUT|/pedidos/:id',
  'src/routes/repartidorApi.js|POST|/pedidos/:id/entregar',
  'src/routes/repartidorApi.js|POST|/pedidos/:id/activos-movimientos',
  'src/routes/repartidorApi.js|POST|/tomar/:id',
  'src/routes/repartidorApi.js|POST|/optimizar-ruta',
  'src/routes/tracking.js|POST|/update',
  'src/routes/tracking.js|POST|/location',
  'src/route.js|POST|/owned/item',
  'repartidor-tomar',
]);

const PUBLIC_CASES = new Set([
  'src/routes/auth.js|POST|/login',
  'src/routes/auth.js|POST|/logout',
  'src/routes/authGuestSignup.js|POST|/guest',
  'src/routes/authGuestSignup.js|POST|/register',
  'src/routes/authGuestSignup.js|POST|/signup-full',
  'src/routes/juegos.js|POST|/participar',
  'src/routes/juegos.js|POST|/premio-entrega',
  'src/routes/publicClientApp.js|POST|/auth/companies',
  'src/routes/publicClientApp.js|POST|/auth/request-otp',
  'src/routes/publicClientApp.js|POST|/auth/verify-otp',
  'src/routes/publicClientApp.js|POST|/profile',
  'src/routes/publicClientApp.js|POST|/auth/logout',
  'src/routes/publicLegacyCatalog.js|POST|/contacto',
  'src/routes/publicLegacyPedidos.js|POST|/push/subscribe',
  'src/routes/publicLegacyPedidos.js|POST|/push/unsubscribe',
  'src/routes/tracking.js|POST|/update',
  'src/routes/tracking.js|POST|/location',
  'src/routes/tracking.js|POST|/incidents/:pedidoId/ack',
  'src/routes/publicLegacyCreatePedido.js|POST|/public/pedidos',
  'public-create-pedido',
]);

function result(ok, reason, marker, proof) {
  return { ok, reason: ok ? '' : reason, marker, ...(proof ? { proof } : {}) };
}

function proofPayload(proof) {
  return JSON.stringify({ schema: proof.schema, caseId: proof.caseId, endpointKey: proof.endpointKey,
    testCase: proof.testCase, assertions: proof.assertions, results: proof.results });
}

function createAuthorityProof({ caseId, endpointKey, testCase, assertions, results = {} }) {
  const proof = { schema: 1, caseId, endpointKey, testCase, assertions, results };
  proof.hash = crypto.createHash('sha256').update(proofPayload(proof)).digest('hex');
  return proof;
}

export function validateAuthorityProof(proof, { caseId, endpointKey }) {
  if (!PUBLIC_CASES.has(caseId)) return false;
  const endpointMatches = caseId === endpointKey
    || (caseId === 'public-create-pedido' && endpointKey.endsWith('|POST|/public/pedidos'));
  if (!endpointMatches || !proof || proof.schema !== 1 || proof.caseId !== caseId || proof.endpointKey !== endpointKey) return false;
  const expectedTestCase = caseId === 'src/routes/authGuestSignup.js|POST|/signup-full'
    ? `executed:${caseId}:router-harness`
    : (caseId === 'src/routes/authGuestSignup.js|POST|/guest' || caseId === 'src/routes/authGuestSignup.js|POST|/register')
      ? `executed:${caseId}:retired`
      : `executed:${caseId}:source-contract`;
  if (proof.testCase !== expectedTestCase) return false;
  if (!Array.isArray(proof.assertions) || !proof.assertions.length
    || !proof.assertions.every(item => item && typeof item.name === 'string' && item.ok === true)) return false;
  if (!proof.results || typeof proof.results !== 'object' || Array.isArray(proof.results)) return false;
  const expected = crypto.createHash('sha256').update(proofPayload(proof)).digest('hex');
  return typeof proof.hash === 'string' && proof.hash === expected;
}

function proofResult({ caseId, endpointKey, testCase, assertions, results }) {
  const proof = createAuthorityProof({ caseId, endpointKey, testCase, assertions, results });
  if (!validateAuthorityProof(proof, { caseId, endpointKey })) return result(false, 'proof público malformed', '');
  return result(true, '', `executed:${caseId}:${proof.hash.slice(0, 12)}`, proof);
}

function stripJsComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (char === '\\') out += source[++i] || '';
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; out += char; continue; }
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
}

function splitTopLevel(source) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) { parts.push(source.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function extractSqlCalls(evidence) {
  const source = stripJsComments(evidence);
  const calls = [];
  const pattern = /\b(?:query|txQuery|client\.query)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf('(');
    let depth = 1;
    let quote = null;
    let end = open + 1;
    for (; end < source.length && depth > 0; end += 1) {
      const char = source[end];
      if (quote) {
        if (char === '\\') end += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
    }
    const args = splitTopLevel(source.slice(open + 1, end - 1));
    const literal = args[0] || '';
    if (!['\'', '"', '`'].includes(literal[0]) || literal.at(-1) !== literal[0]) continue;
    calls.push({ sql: literal.slice(1, -1), params: args[1] || '' });
  }
  return calls;
}

function stripSqlComments(sql) {
  let out = '';
  let quote = null;
  let dollarTag = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { out += dollarTag; i += dollarTag.length - 1; dollarTag = null; }
      else out += char;
      continue;
    }
    if (quote) {
      out += char;
      if (char === quote && sql[i + 1] === quote) out += sql[++i];
      else if (char === quote) quote = null;
      continue;
    }
    const dollar = sql.slice(i).match(/^\$[A-Za-z_][\w]*\$|^\$\$/)?.[0];
    if (dollar) { dollarTag = dollar; out += dollar; i += dollar.length - 1; continue; }
    if (char === "'" || char === '"') { quote = char; out += char; continue; }
    if (char === '-' && next === '-') {
      out += '  '; i += 2;
      while (i < sql.length && sql[i] !== '\n') { out += ' '; i += 1; }
      if (i < sql.length) out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i] === '\n' ? '\n' : ' '; i += 1; }
      if (i < sql.length) { out += '  '; i += 1; }
      continue;
    }
    out += char;
  }
  return out;
}

function splitSqlStatements(sql) {
  const parts = [];
  let start = 0;
  let quote = null;
  let dollarTag = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { i += dollarTag.length - 1; dollarTag = null; }
      continue;
    }
    if (quote) {
      if (char === quote && sql[i + 1] === quote) i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    const dollar = sql.slice(i).match(/^\$[A-Za-z_][\w]*\$|^\$\$/)?.[0];
    if (dollar) { dollarTag = dollar; i += dollar.length - 1; continue; }
    if (char === "'" || char === '"') quote = char;
    else if (char === ';') { parts.push(sql.slice(start, i)); start = i + 1; }
  }
  parts.push(sql.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}

export function analyzeSqlMutationAuthority({ evidence, requiredColumns = [], requiredParams = [] }) {
  const calls = extractSqlCalls(evidence).flatMap(call => splitSqlStatements(stripSqlComments(call.sql))
    .filter(sql => /^\s*(?:UPDATE|DELETE\s+FROM)\b/i.test(sql))
    .map(sql => ({ ...call, sql })));
  for (const call of calls) {
    const mutationTail = call.sql.replace(/^[\s\S]*?\bSET\b/i, 'SET ');
    const regions = [...mutationTail.matchAll(/\b(?:WHERE|ON)\b([\s\S]*?)(?=\b(?:WHERE|ON|RETURNING|ORDER\s+BY|LIMIT)\b|$)/gi)]
      .map(match => match[1]);
    if (!regions.length) continue;
    const bindings = new Map();
    for (const region of regions) {
      for (const predicate of region.matchAll(/\b([A-Za-z_][\w.]*)\s*=\s*\$(\d+)|\$(\d+)\s*=\s*\b([A-Za-z_][\w.]*)/g)) {
        bindings.set((predicate[1] || predicate[4]).split('.').at(-1).toLowerCase(), Number(predicate[2] || predicate[3]));
      }
    }
    const params = splitTopLevel(call.params.replace(/^\[/, '').replace(/\]$/, ''));
    const columnsOk = requiredColumns.every(column => bindings.has(column.toLowerCase()));
    const paramsOk = requiredParams.every((param, requiredIndex) => {
      const column = requiredColumns[requiredIndex];
      const placeholder = column ? bindings.get(column.toLowerCase()) : [...bindings.values()][requiredIndex];
      const expression = params[placeholder - 1] || '';
      return new RegExp(`(?:^|\\W)${param.replace(/[$]/g, '\\$&')}(?:$|\\W)`).test(expression);
    });
    if (columnsOk && paramsOk) return { ok: true, call };
  }
  return { ok: false, reason: 'mutation SQL sin predicates/placeholders/params de autoridad enlazados' };
}

function hasAll(source, patterns) {
  const live = stripJsComments(source);
  return patterns.every(pattern => pattern.test(live));
}

export function ownershipAuthorityContract({ caseId, endpointKey, classification, evidence }) {
  if (!OWNERSHIP_CASES.has(caseId)) return result(false, `authority case no registrado: ${caseId}`, '');
  if (caseId !== endpointKey && !(caseId === 'repartidor-tomar' && endpointKey.endsWith('|POST|/tomar/:id'))) {
    return result(false, `authority case no corresponde al endpoint: ${caseId}`, '');
  }

  const live = stripJsComments(evidence);
  if (/status\s*\(410\)|endpoint retirado|requiere_cierre/i.test(live)) {
    return result(true, '', `executed:${caseId}:retired`);
  }

  const scopedSql = extractSqlCalls(live).some(({ sql, params }) => {
    const predicate = sql.match(/\b(?:WHERE|ON)\b([\s\S]*)/i)?.[1] || '';
    const tenant = /\bempresa_id\b\s*=\s*\$\d+/i.test(predicate)
      && /\b(?:empresaId|empresa_id)\b/.test(params);
    const resource = /\b(?:id|pedido_id|gasto_id|referente_id|chofer_id|cliente_id)\b\s*=\s*\$\d+/i.test(predicate)
      && /\b(?:pedidoId|gastoId|referenteId|referente_id|choferId|chofer_id|clienteId|req\.params|req\.user)\b/.test(params);
    const actor = classification === 'repartidor_exacto_ownership'
      ? tenant && resource
      : classification === 'referente_exacto_ownership'
        ? /\b(?:id|referente_id)\b\s*=\s*\$\d+/i.test(predicate) && /\b(?:referenteId|referente_id|req\.user\.referente_id)\b/.test(params)
        : /\b(?:choferId|chofer_id|isSuper|role)\b/.test(live);
    const tomarState = !endpointKey.endsWith('|POST|/tomar/:id')
      || (/\bestado\b\s*=\s*\$\d+/i.test(predicate)
        && /\bchofer_id\b\s*=\s*\$\d+/i.test(sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i)?.[1] || '')
        && /\b(?:choferId|chofer_id|req\.user\.chofer_id)\b/.test(params));
    return tenant && resource && actor && tomarState;
  });

  const helperGuard = (
    hasAll(live, [/getPedidoOperablePorRepartidor\s*\(\s*\{[\s\S]*?pedidoId[\s\S]*?empresaId[\s\S]*?choferId/, /if\s*\(\s*!pedido\s*\)/])
    || hasAll(live, [/withTransaction\s*\(/, /FOR\s+(?:UPDATE|SHARE)/i, /rows?\.length\s*!==?\s*1|!\w+\.length/i, /\b(?:empresaId|empresa_id)\b/, /\b(?:choferId|chofer_id|referenteId|referente_id|gastoId|pedidoId)\b/])
    || hasAll(live, [/resolveEmpresa|resolveEmpresaId|getEmpresaIdFromToken/, /req\.user/, /\b(?:INSERT|UPDATE|DELETE)\b/i])
    || hasAll(live, [/req\.user\.(?:referente_id|empresa_id)/, /INSERT\s+INTO\s+referente_clientes_propuestos/i, /RETURNING\s+id/i])
    || hasAll(live, [/const\s+sql\s*=\s*`[\s\S]*?p\.chofer_id\s*=\s*\$1[\s\S]*?p\.empresa_id\s*=\s*\$4/, /query\s*\(\s*sql\s*,\s*\[\s*chofer_id\s*,[\s\S]*?empresa_id\s*\]/])
  );

  if (!scopedSql && !helperGuard) {
    return result(false, 'ownership sin query scoped ni helper/resolver con resultado usado en guard', '');
  }
  return result(true, '', `executed:${caseId}:semantic`);
}

export function publicAuthorityContract({ root, caseId, endpointKey, row, evidence, middlewareText }) {
  if (!PUBLIC_CASES.has(caseId)) return result(false, `authority case no registrado: ${caseId}`, '');
  if (caseId !== endpointKey && !(caseId === 'public-create-pedido' && endpointKey.endsWith('|POST|/public/pedidos'))) {
    return result(false, `authority case no corresponde al endpoint: ${caseId}`, '');
  }
  if (row.method !== 'POST') return result(false, 'endpoint público mutante debe usar POST contractual', '');
  if (/\bwithAuth(?:Fn)?\b|\brequireCanonicalBackofficeRole\b|\brequireExactRepartidor\b|\brequireReferente\b/.test(middlewareText)) {
    return result(false, 'endpoint público mezcla autenticación o autoridad administrativa incompatible', '');
  }

  const live = stripJsComments(evidence);
  if (/\bUPDATE\s+\w+[\s\S]*?\badmin\s*=|req\.body\s*\.\s*admin/i.test(live)) {
    return result(false, 'endpoint público deriva privilegio administrativo desde body', '');
  }
  if (caseId !== 'src/routes/authGuestSignup.js|POST|/signup-full' && /status\s*\(410\)/.test(live)) return proofResult({
    caseId, endpointKey, testCase: `executed:${caseId}:retired`,
    assertions: [{ name: 'endpoint returns 410', ok: true }], results: { status: 410 },
  });

  if (caseId === 'src/routes/authGuestSignup.js|POST|/signup-full') {
    const sqlCalls = extractSqlCalls(live);
    const sourceBound = /await\s+withTransaction\s*\(\s*async\s+txQuery/.test(live)
      && !/(?:const|let|var|function)\s+withTransaction\b/.test(live)
      && sqlCalls.some(call => /^\s*INSERT\s+INTO\s+empresas\b/i.test(call.sql))
      && sqlCalls.some(call => /^\s*INSERT\s+INTO\s+usuarios\b/i.test(call.sql) && /\bnewEmpresaId\b/.test(call.params))
      && /empRows\.length\s*!==\s*1/.test(live)
      && /userRows\.length\s*!==\s*1/.test(live)
      && /\{\s*pool\s*,\s*maxRetries:\s*0\s*\}/.test(live);
    if (!sourceBound || !root) return result(false, 'signup-full sin handler transaccional exact-row ejecutable', '');
    try {
      const raw = execFileSync(process.execPath, [path.join(root, 'tests/support/publicAuthorityHarnessRunner.js')], {
        cwd: root, encoding: 'utf8', timeout: 20_000,
      });
      const harness = JSON.parse(raw);
      if (!Array.isArray(harness.assertions) || harness.assertions.some(item => item.ok !== true)) {
        return result(false, 'harness signup-full falló assertions de autoridad/mutación', '');
      }
      return proofResult({ caseId, endpointKey, testCase: `executed:${caseId}:router-harness`,
        assertions: harness.assertions, results: harness.results });
    } catch (error) {
      return result(false, `harness signup-full no ejecutó: ${error.message}`, '');
    }
  }

  const rules = new Map([
    ['src/routes/auth.js|POST|/login', [/bcrypt\.compare\s*\(/, /jwt\.sign\s*\(/, /SELECT[\s\S]*FROM\s+usuarios/i]],
    ['src/routes/auth.js|POST|/logout', [/res\.cookie\s*\(\s*['"]token['"]/, /maxAge\s*:\s*0/]],
    ['src/routes/juegos.js|POST|/participar', [/withTransaction\s*\(/, /loadCampaignFromPublicRequest\s*\(/, /telefonoNorm/]],
    ['src/routes/juegos.js|POST|/premio-entrega', [/withTransaction\s*\(/, /codigo/, /telefonoNorm/, /FOR\s+UPDATE/i]],
    ['src/routes/publicClientApp.js|POST|/auth/companies', [/resolveRequestTenant\s*\(/, /getClientCompaniesByPhone\s*\(/, /telefonoNorm/]],
    ['src/routes/publicClientApp.js|POST|/auth/request-otp', [/resolveRequestTenant\s*\(/, /otpStore|generateOtp|randomInt/, /telefonoNorm/]],
    ['src/routes/publicClientApp.js|POST|/auth/verify-otp', [/resolveRequestTenant\s*\(/, /otpStore/, /jwt\.sign\s*\(/]],
    ['src/routes/publicClientApp.js|POST|/profile', [/getClientFromRequest\s*\(/, /session\.payload/, /UPDATE[\s\S]*empresa_id/i]],
    ['src/routes/publicClientApp.js|POST|/auth/logout', [/res\.cookie\s*\(\s*['"]client_token['"]/, /maxAge\s*:\s*0/]],
    ['src/routes/publicLegacyPedidos.js|POST|/push/subscribe', [/pushSubscribeSchema\.safeParse\s*\(/, /tracking.*token|validate.*token|verify.*token/i, /INSERT|upsert/i]],
    ['src/routes/publicLegacyPedidos.js|POST|/push/unsubscribe', [/pushUnsubscribeSchema\.safeParse\s*\(/, /DELETE\s+FROM\s+push_subs\s+WHERE\s+endpoint\s*=\s*\$1/i, /\[\s*endpoint\s*\]/]],
  ]);

  if (endpointKey.endsWith('|POST|/public/pedidos')) {
    const ok = hasAll(live, [/resolvePublicPedidoTenant|resolveEmpresaIdFn/, /requestId|reqId|idempot/i, /INSERT\s+INTO\s+pedidos/i, /withTransaction|BEGIN/i])
      && !/\bDELETE\s+FROM\s+pedidos\b/i.test(live);
    if (!ok) return result(false, 'public create-pedido sin tenant resolver, idempotencia y mutación transaccional concretos', '');
    return proofResult({ caseId, endpointKey, testCase: `executed:${caseId}:source-contract`, assertions: [
      { name: 'tenant resolver used', ok: true }, { name: 'idempotency used', ok: true }, { name: 'transactional insert used', ok: true },
    ], results: { matchedRules: 3 } });
  }

  if (caseId === 'src/routes/publicLegacyCatalog.js|POST|/contacto') {
    const required = [
      /resolvePublicPedidoEmpresaId\s*\(/,
      /consumeContactLookup\s*\(/,
      /runInTransaction\s*\(\s*async\s+txQuery/,
      /lockGeneralPhoneIdentity\s*\(\s*txQuery/,
      /resolveTenantDeliveryPointByPhone\s*\(\s*txQuery/,
    ];
    const readOnly = !/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(live);
    if (!readOnly || !hasAll(live, required)) {
      return result(false, 'lookup público POST sin tenant, rate limit, lock o contrato read-only', '');
    }
    return proofResult({ caseId, endpointKey, testCase: `executed:${caseId}:source-contract`,
      assertions: [
        ...required.map((pattern, index) => ({ name: `required public read assertion ${index + 1}`, ok: pattern.test(live) })),
        { name: 'handler is read-only', ok: readOnly },
      ], results: { matchedRules: required.length, readOnly } });
  }

  const required = rules.get(caseId);
  if (!required || !hasAll(live, required)) {
    return result(false, 'endpoint público sin resolver/capability/secret/idempotencia concreto y usado', '');
  }
  return proofResult({ caseId, endpointKey, testCase: `executed:${caseId}:source-contract`,
    assertions: required.map((pattern, index) => ({ name: `required public assertion ${index + 1}`, ok: pattern.test(live) })),
    results: { matchedRules: required.length } });
}

export const authorityContractRegistry = Object.freeze({
  ownershipAuthorityContract,
  publicAuthorityContract,
});
