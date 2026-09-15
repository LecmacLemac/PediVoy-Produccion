import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load the real router in isolation: no database, WhatsApp or IA network access.
// Local function wrappers observe entry into protected handlers without a production seam.
const source = readFileSync(new URL('../src/handlers.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '')
  .replace(/^export (?=function )/gm, '')
  .replace('export default { start };', 'globalThis.router = { start, resolve: _resolverContextoDesdeTelefono };');
const active = { id: 12, username: '5493871234567', activo: true, role: 'super', empresa_id: null, chofer_id: null, referente_id: null };
const driver = { chofer_id: 4, empresa_id: 7, nombre: 'Chofer', activo: true };
const reference = { id: 6, empresa_id: 7, activo: true, deleted_at: null };
const directUser = role => ({ ...active, role, empresa_id: 7,
  chofer_id: role === 'repartidor' ? 4 : null, referente_id: role === 'referente' ? 6 : null });
const commands = ['procesar op 123456', 'rentabilidad', 'estadistica'];

function harness({ user = null, linked = null, chofer = driver, referente = reference, empresaId, identityQuery, sender = active.username } = {}) {
  const queries = [];
  const business = [];
  const replies = [];
  const errors = [];
  const sandbox = {
    console: { error: (...args) => errors.push(args), warn() {} },
    process: { env: {} },
    business,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (identityQuery && /FROM usuarios|FROM choferes/.test(sql)) return identityQuery(sql, params);
      if (/FROM usuarios/.test(sql)) {
        // Model SELECT projection so missing security columns cannot pass unnoticed.
        const row = /WHERE chofer_id/.test(sql) ? linked : user;
        if (!row) return [];
        const columns = sql.match(/SELECT\s+([\s\S]*?)\s+FROM/)[1].split(',').map(s => s.trim());
        return [Object.fromEntries(columns.map(column => {
          const field = column.match(/^(?:u\.)?(\w+)$/);
          if (field) return [field[1], row[field[1]]];
          // Match the full joined expression: do not invent validity columns or
          // let an omitted join/predicate silently behave like a correct query.
          if (column === '(c.id IS NOT NULL AND c.activo IS TRUE AND c.empresa_id = u.empresa_id) AS chofer_valid') {
            assert.match(sql, /LEFT JOIN choferes c ON c.id = u.chofer_id/);
            return ['chofer_valid', !!chofer && chofer.chofer_id === row.chofer_id &&
              chofer.activo === true && chofer.empresa_id === row.empresa_id];
          }
          if (column.replace(/\s+/g, ' ') === '(r.id IS NOT NULL AND r.activo IS TRUE AND r.deleted_at IS NULL AND r.empresa_id = u.empresa_id) AS referente_valid') {
            assert.match(sql, /LEFT JOIN referentes r ON r.id = u.referente_id/);
            return ['referente_valid', !!referente && referente.id === row.referente_id &&
              referente.activo === true && referente.deleted_at === null && referente.empresa_id === row.empresa_id];
          }
          throw new Error(`Unmodeled identity projection: ${column}`);
        }))];
      }
      if (/FROM choferes/.test(sql)) return chofer ? [{ ...chofer, activo: /nombre, activo/.test(sql) ? chofer.activo : undefined }] : [];
      if (/FROM pedidos p/.test(sql)) return [];
      if (/FROM puntos_entrega/.test(sql)) return [{ empresa_id: 7, cliente: 'Cliente' }];
      if (/SELECT id FROM empresas/.test(sql)) return [{ id: 7 }];
      if (/UPDATE comprobantes_transferencia/.test(sql)) return [{ id: 1 }];
      throw new Error(`Unexpected business query: ${sql}`);
    },
  };
  vm.runInNewContext(source + `
    for (const name of ['handleRentabilidadEmpresa', 'handleEstadisticaEmpresa', 'marcarComprobanteComoProcesadoPg', 'handleResumen', 'handleReposicionAutomatica', 'responderConIA']) {
      const original = eval(name);
      eval(name + ' = async (...args) => { business.push({ name, args }); ' +
        (name === 'responderConIA' ? 'return;' : 'return original(...args);') + ' }');
    }
  `, sandbox);
  let receive;
  sandbox.router.start({
    on(event, listener) { assert.equal(event, 'message'); receive = listener; },
    async sendMessage(to, body) { replies.push(body); },
  }, empresaId === undefined ? {} : { empresaId });
  let sequence = 0;
  return {
    queries, business, replies, errors,
    resolve: () => sandbox.router.resolve(`${sender}@c.us`),
    send: body => receive({ from: `${sender}@c.us`, body, id: { _serialized: String(++sequence) } }),
  };
}

const invalid = [
  ...[false, null, undefined, 1, 'true'].map(activo => [`active=${activo}`, { ...active, activo }]),
  ...[undefined, 7, 0, -1, '7', false].map(empresa_id => [`super tenant=${empresa_id}`, { ...active, empresa_id }]),
  ...['SUPER', ' super ', 'ADMIN', ' admin ', 'guest', 'inventado', null].map(role => [`role=${role}`, { ...active, role }]),
  ...['admin', 'user', 'repartidor', 'referente', 'facturacion', 'contable'].flatMap(role =>
    [null, undefined, 0, -1, 1.5, '7', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(empresa_id =>
      [`${role} tenant=${empresa_id}`, { ...active, role, empresa_id }])),
];

for (const path of ['direct', 'linked']) {
  for (const [name, row] of invalid) {
    test(`${path}: invalid ${name} fails closed before commands, fallback or IA`, async () => {
      for (const empresaId of [undefined, 9]) {
        const h = harness({ [path === 'direct' ? 'user' : 'linked']: row, empresaId });
        for (const command of [...commands, 'resumen', 'necesitas reposicion', 'hola', 'ayuda']) await h.send(command);
        assert.deepEqual(h.business, [], 'No protected handler or IA may run');
        assert.ok(h.queries.every(({ sql }) => /FROM usuarios/.test(sql) || (path === 'linked' && /FROM choferes/.test(sql))), 'No fallback, business read or write query');
        assert.deepEqual(h.errors, [], 'Denial must be explicit, not an exception');
        assert.deepEqual(h.replies, [], 'Invalid identity stops the message');
      }
    });
  }
}

for (const path of ['direct']) {
  for (const role of ['admin', 'user', 'repartidor', 'referente', 'facturacion', 'contable']) {
    test(`${path}: active coherent ${role} never gains super commands`, async () => {
      const h = harness({ [path === 'direct' ? 'user' : 'linked']: directUser(role) });
      const ctx = await h.resolve();
      assert.equal(ctx.role, role);
      for (const command of commands) await h.send(command);
      assert.deepEqual(h.business, []);
      assert.equal(h.replies.length, 3);
      assert.ok(h.queries.every(({ sql }) => /FROM usuarios|FROM choferes/.test(sql)));
    });
  }
}

for (const empresa_id of [null, undefined, 0, -1, 1.5, '7', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`chofer tenant=${empresa_id} cannot grant repartidor context`, async () => {
    const h = harness({ chofer: { ...driver, empresa_id } });
    await h.send('resumen');
    await h.send('hola');
    assert.deepEqual(h.business, []);
    assert.deepEqual(h.errors, []);
    assert.ok(h.queries.every(({ sql }) => /FROM usuarios|FROM choferes/.test(sql)));
  });
}

test('active linked repartidor from another tenant fails closed', async () => {
  const h = harness({ linked: { ...active, role: 'repartidor', empresa_id: 8 } });
  await h.send('resumen');
  assert.deepEqual(h.business, []);
  assert.deepEqual(h.errors, []);
});

for (const path of ['direct']) {
  test(`${path}: exact active global super retains privileged dispatch and write`, async () => {
    const h = harness({ [path === 'direct' ? 'user' : 'linked']: active });
    assert.equal((await h.resolve()).role, 'super');
    for (const command of commands) await h.send(command);
    assert.deepEqual(h.business.map(call => call.name), ['marcarComprobanteComoProcesadoPg', 'handleRentabilidadEmpresa', 'handleEstadisticaEmpresa']);
    assert.equal(h.queries.filter(({ sql }) => /UPDATE comprobantes_transferencia/.test(sql)).length, 1);
  });
}

test('unlinked coherent chofer retains repartidor context', async () => {
  const h = harness();
  const ctx = await h.resolve();
  assert.equal(ctx.role, 'repartidor');
  assert.equal(ctx.empresa_id, 7);
  assert.equal(ctx.chofer_id, 4);
});

test('historical customer still reaches IA', async () => {
  const h = harness({ chofer: null });
  await h.send('hola');
  assert.deepEqual(h.business.map(call => call.name), ['responderConIA']);
  assert.equal(h.business[0].args[3].role, 'cliente');
});

for (const role of ['super', 'admin', 'user', 'referente', 'facturacion', 'contable', 'REPARTIDOR', ' repartidor ']) {
  test(`linked ${role} cannot gain a driver or privileged identity`, async () => {
    const h = harness({ linked: { ...active, role, empresa_id: role === 'super' ? null : 7, chofer_id: 4 } });
    for (const command of [...commands, 'resumen', 'hola']) await h.send(command);
    assert.deepEqual(h.business, []);
    assert.deepEqual(h.replies, []);
    assert.deepEqual(h.errors, []);
  });
}
for (const activo of [false, null, undefined, 1, 'true']) {
  test(`inactive/non-true driver ${activo} stops fallback`, async () => {
    const h = harness({ chofer: { ...driver, activo } });
    for (const command of ['resumen', 'hola']) await h.send(command);
    assert.deepEqual(h.business, []);
    assert.deepEqual(h.errors, []);
    assert.ok(h.queries.every(({ sql }) => /FROM usuarios|FROM choferes/.test(sql)));
  });
}
for (const links of [{ chofer_id: 5, referente_id: null }, { chofer_id: 4, referente_id: 2 }]) {
  test(`linked repartidor rejects incompatible links ${JSON.stringify(links)}`, async () => {
    const h = harness({ linked: { ...active, role: 'repartidor', empresa_id: 7, ...links } });
    await h.send('resumen');
    assert.deepEqual(h.business, []);
  });
}
for (const role of ['user', 'admin', 'referente', 'facturacion', 'contable', 'repartidor']) {
  test(`forced worker cannot rescope registered ${role}`, async () => {
    const h = harness({ user: directUser(role), empresaId: 9 });
    await h.send('hola');
    await h.send('resumen');
    assert.deepEqual(h.business, []);
    assert.deepEqual(h.replies, []);
  });
}
test('forced worker cannot rescope unlinked chofer', async () => {
  const h = harness({ empresaId: 9 });
  await h.send('hola');
  assert.deepEqual(h.business, []);
});
for (const role of ['user', 'admin', 'referente', 'facturacion', 'contable', 'cliente']) {
  test(`resumen denies ${role} before business handler`, async () => {
    const h = harness(role === 'cliente' ? { chofer: null } : { user: directUser(role) });
    await h.send('resumen');
    assert.deepEqual(h.business, []);
    assert.equal(h.replies.length, 1);
    assert.match(h.replies[0], /permiso/i);
    assert.deepEqual(h.errors, []);
  });
}
test('coherent linked repartidor retains own driver context', async () => {
  const h = harness({ linked: { ...active, role: 'repartidor', empresa_id: 7, chofer_id: 4 } });
  const ctx = await h.resolve();
  assert.equal(ctx.role, 'repartidor');
  assert.equal(ctx.chofer_id, 4);
  await h.send('resumen chofer 5');
  assert.deepEqual(h.business, []);
  assert.equal(h.replies.length, 1);
});
test('forced worker scopes direct global super and historical customer', async () => {
  for (const options of [{ user: active }, { chofer: null }]) {
    const h = harness({ ...options, empresaId: 9 });
    await h.send('hola');
    assert.equal(h.business[0].args[3].empresa_id, 9);
  }
});

// Direct usernames take priority even when the fallback driver would be valid.
const invalidDirectLinks = [
  ...['super', 'user', 'admin', 'facturacion', 'contable'].flatMap(role =>
    [{ chofer_id: 4 }, { referente_id: 6 }, { chofer_id: 4, referente_id: 6 },
     { chofer_id: undefined }, { referente_id: undefined }].map(links =>
      [`${role} links=${JSON.stringify(links)}`, { user: { ...active, role, empresa_id: role === 'super' ? null : 7, ...links } }])),
  ...['repartidor', 'referente'].flatMap(role => {
    const own = role === 'repartidor' ? 'chofer_id' : 'referente_id';
    const other = role === 'repartidor' ? 'referente_id' : 'chofer_id';
    const record = role === 'repartidor' ? 'chofer' : 'referente';
    const valid = role === 'repartidor' ? driver : reference;
    return [
      ...[null, undefined, 0, -1, 1.5, '4', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(id =>
        [`${role} ${own}=${id}`, { user: { ...directUser(role), [own]: id } }]),
      ...[4, undefined].map(id =>
        [`${role} incompatible ${other}=${id}`, { user: { ...directUser(role), [other]: id } }]),
      ...[null, { ...valid, activo: false }, { ...valid, activo: null }, { ...valid, empresa_id: 8 },
        { ...valid, [role === 'repartidor' ? 'chofer_id' : 'id']: 99 },
        ...(role === 'referente' ? [{ ...valid, deleted_at: '2026-01-01' }] : [])].map(link =>
        [`${role} linked record=${JSON.stringify(link)}`, { user: directUser(role), [record]: link }]),
    ];
  }),
];
for (const [name, options] of invalidDirectLinks) {
  test(`direct: ${name} fails before commands, IA and business queries`, async () => {
    for (const empresaId of [undefined, 7, 9]) {
      const h = harness({ ...options, empresaId });
      assert.equal(await h.resolve(), null);
      for (const command of [...commands, 'resumen', 'necesitas reposicion', 'ver pedidos', 'hola', 'ayuda']) await h.send(command);
      assert.deepEqual(h.business, []);
      assert.deepEqual(h.replies, []);
      assert.deepEqual(h.errors, []);
      assert.equal(h.queries.length, 9, 'One identity query per resolution, no fallback or business query');
      assert.ok(h.queries.every(({ sql }) => /FROM usuarios/.test(sql)));
    }
  });
}
for (const role of ['repartidor', 'referente']) {
  test(`direct: valid ${role} retains functional tenant and operational scope`, async () => {
    for (const empresaId of [undefined, 7]) {
      const h = harness({ user: directUser(role), empresaId });
      const ctx = await h.resolve();
      assert.equal(ctx.role, role);
      assert.equal(ctx.empresa_id, 7);
      assert.equal(ctx.chofer_id, role === 'repartidor' ? 4 : null);
      assert.equal(ctx.referente_id, role === 'referente' ? 6 : null);
      await h.send('hola');
      assert.equal(h.business[0].name, 'responderConIA');
      assert.equal(h.business[0].args[3].empresa_id, 7);
      assert.equal(h.business[0].args[3].role, role);
      await h.send('ver pedidos');
      const orders = h.queries.find(({ sql }) => /FROM pedidos p/.test(sql));
      assert.match(orders.sql, /pe.empresa_id = \$1/);
      assert.deepEqual(Array.from(orders.params), role === 'repartidor' ? [7, 4] : [7, '3871234567']);
      if (role === 'repartidor') assert.match(orders.sql, /p.chofer_id = \$2/);
      assert.equal(h.replies.length, 1);
      assert.deepEqual(h.errors, []);
    }
  });
}

// Model both the old suffix lookup and the exact normalized SQL, including LIMIT.
// These fixtures exercise the real resolver and message dispatch with distinct senders.
function phoneHarness({ users = [], drivers = [], sender = active.username } = {}) {
  const digits = value => String(value ?? '').replace(/\D/g, '');
  return harness({ sender, identityQuery(sql, params) {
    let rows;
    if (/WHERE chofer_id/.test(sql)) return users.filter(row => row.chofer_id === params[0]);
    if (/FROM usuarios/.test(sql)) {
      rows = users.filter(row => /regexp_replace/i.test(sql)
        ? digits(row.username) === params[0] || (/u.telefono/.test(sql) && digits(row.telefono) === params[0])
        : params.includes(row.username));
    } else {
      rows = drivers.filter(row => /LIKE/.test(sql)
        ? params.some(value => digits(row.telefono).endsWith(value))
        : digits(row.telefono) === params[0]);
    }
    return /LIMIT 1/.test(sql) ? rows.slice(0, 1) : rows;
  } });
}
const otherInternational = '343871234567'; // Same final ten digits as 5493871234567.
for (const path of ['user', 'chofer']) {
  test(`${path}: distinct international identities never collide or use local suffix privilege`, async () => {
    for (const stored of [otherInternational, '3871234567']) {
      const h = phoneHarness(path === 'user'
        ? { users: [{ ...active, username: stored }] }
        : { drivers: [{ ...driver, telefono: stored }] });
      assert.equal((await h.resolve()).role, 'cliente');
      for (const command of [...commands, 'resumen']) await h.send(command);
      assert.deepEqual(h.business, []);
      assert.deepEqual(h.errors, []);
    }
  });
  test(`${path}: duplicate normalized full identities fail closed without fallback`, async () => {
    for (const activo of [true, false]) {
      const h = phoneHarness(path === 'user'
        ? { users: [active, { ...active, id: 13, username: '+54 (938) 712-34567', activo }], drivers: [{ ...driver, telefono: active.username }] }
        : { drivers: [{ ...driver, telefono: active.username }, { ...driver, chofer_id: 5, telefono: '+54 (938) 712-34567', activo }] });
      assert.equal(await h.resolve(), null);
      for (const command of [...commands, 'resumen', 'hola']) await h.send(command);
      assert.deepEqual(h.business, []);
      assert.deepEqual(h.replies, []);
      assert.deepEqual(h.errors, []);
      assert.ok(h.queries.every(({ sql }) => path === 'user' ? /FROM usuarios/.test(sql) : /FROM usuarios|FROM choferes/.test(sql)));
    }
  });
}
for (const role of ['super', 'repartidor']) {
  test(`unique formatted full username preserves valid ${role} alongside a suffix-sharing number`, async () => {
    const user = role === 'super' ? active : { ...directUser(role), chofer_valid: true };
    const h = phoneHarness({ users: [
      { ...active, id: 13, username: otherInternational },
      { ...user, username: '+54 (938) 712-34567' },
    ] });
    assert.equal((await h.resolve()).role, role);
    await h.send(role === 'super' ? commands[0] : 'ver pedidos');
    if (role === 'super') assert.equal(h.business[0].name, 'marcarComprobanteComoProcesadoPg');
    else {
      const orders = h.queries.find(({ sql }) => /FROM pedidos p/.test(sql));
      assert.deepEqual(Array.from(orders.params), [7, 4]);
    }
    assert.deepEqual(h.errors, []);
  });
}
test('unique formatted full chofer identity selects only its own tenant and driver', async () => {
  const drivers = [
    { ...driver, chofer_id: 5, empresa_id: 8, telefono: otherInternational },
    { ...driver, telefono: '+54 (938) 712-34567' },
  ];
  for (const [sender, id, tenant] of [[active.username, 4, 7], [otherInternational, 5, 8]]) {
    const h = phoneHarness({ drivers, sender });
    const ctx = await h.resolve();
    assert.equal(ctx.role, 'repartidor');
    assert.equal(ctx.chofer_id, id);
    assert.equal(ctx.empresa_id, tenant);
  }
});
test('usuarios.telefono accepts exact formatted identity and detects ambiguity across fields', async () => {
  const users = [{ ...active, username: 'operator', telefono: '+54 (938) 712-34567' }];
  assert.equal((await phoneHarness({ users }).resolve()).role, 'super');
  users.push({ ...active, id: 13 });
  assert.equal(await phoneHarness({ users }).resolve(), null);
});

test('duplicate coherent users linked to one driver fail closed', async () => {
  const linked = { ...directUser('repartidor'), username: 'driver-login' };
  const h = phoneHarness({
    users: [linked, { ...linked, id: 13, username: 'other-login' }],
    drivers: [{ ...driver, telefono: active.username }],
  });
  assert.equal(await h.resolve(), null);
  for (const command of [...commands, 'resumen', 'hola']) await h.send(command);
  assert.deepEqual(h.business, []);
  assert.deepEqual(h.replies, []);
  assert.deepEqual(h.errors, []);
  assert.ok(h.queries.every(({ sql }) => /FROM usuarios|FROM choferes/.test(sql)));
});
