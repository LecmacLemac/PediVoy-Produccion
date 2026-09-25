import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createJuegosPublicosRouter, createJuegosRouter } from '../src/routes/juegos.js';
import { createWppEnqueueTestPool } from './support/wpp-enqueue-test-pool.js';

function buildApp(query, pool) {
  const transactionPool = pool || {
    async connect() {
      return {
        async query(input, params = []) {
          const text = typeof input === 'string' ? input : input.text;
          const values = typeof input === 'string' ? params : input.values;
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
          return { rows: await query(text, values) };
        },
        release() {},
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/juegos-publicos', createJuegosPublicosRouter({ query, pool: transactionPool }));
  return app;
}

function buildAdminApp(query) {
  const app = express();
  app.use(express.json());
  app.use('/api/juegos', createJuegosRouter({
    query,
    withAuth: (req, res, next) => next(),
    isSuper: () => false,
    getEmpresaIdFromToken: () => 1,
  }));
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const campaign = {
  id: 7,
  empresa_id: 1,
  slug: 'raspa-y-gana',
  public_code: 'K8X4PZ2Q',
  nombre: 'Raspadita',
  titulo_publico: 'Raspa y gana',
  descripcion_publica: 'Proba tu suerte.',
  tipo_juego: 'raspadita',
  estado: 'activa',
  participacion_limite: 'once',
  max_participaciones: null,
  max_ganadores: null,
  codigo_prefijo: 'AGUA',
  whatsapp_mensaje: 'Ganaste {premio}. Codigo {codigo}.',
  bases_condiciones: 'Premio no canjeable por dinero.',
  valid_from: null,
  valid_to: null,
  empresa_nombre: 'Agua Hidro',
  empresa_landing_domain: null,
  empresa_landing_slug: 'agua-hidro',
};

test('GET /api/juegos-publicos/campania expone campaña pública', async () => {
  const queries = [];
  const query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (/CREATE TABLE IF NOT EXISTS juegos_campanias/.test(sql)) return [];
    if (/FROM juegos_campanias jc/.test(sql)) return [campaign];
    if (/FROM juegos_premios/.test(sql)) {
      return [
        {
          tipo: 'producto_gratis',
          nombre_publico: 'Bidon gratis',
          descripcion: null,
          valor: null,
          producto_id: 6,
          producto_nombre: 'Bidon 20L',
          producto_imagen: '/uploads/bidon.png',
        },
        { tipo: 'sin_premio', nombre_publico: 'Esta vez no hubo premio', descripcion: null, valor: null, producto_id: null },
      ];
    }
    return [];
  };

  await withServer(buildApp(query), async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/juegos-publicos/campania?empresa_id=1&campania=raspa-y-gana`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.empresa_nombre, 'Agua Hidro');
    assert.equal(body.empresa_web_url, `${baseUrl}/?slug=agua-hidro`);
    assert.equal(body.titulo_publico, 'Raspa y gana');
    assert.equal(body.disponible.ok, true);
    assert.equal(body.premios.length, 2);
    assert.equal(body.premios[0].producto_nombre, 'Bidon 20L');
    assert.equal(body.premios[0].producto_imagen, '/uploads/bidon.png');
  });

  assert.ok(queries.some((q) => /FROM juegos_campanias jc/.test(q.sql)));
});

test('GET /api/juegos-publicos/campania resuelve por codigo publico', async () => {
  const queries = [];
  const query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (/CREATE TABLE IF NOT EXISTS juegos_campanias/.test(sql)) return [];
    if (/FROM juegos_campanias jc/.test(sql)) return [campaign];
    if (/FROM juegos_premios/.test(sql)) return [];
    return [];
  };

  await withServer(buildApp(query), async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/juegos-publicos/campania?public_code=K8X4PZ2Q`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.public_code, 'K8X4PZ2Q');
    assert.equal(body.empresa_id, 1);
    assert.equal(body.slug, 'raspa-y-gana');
  });

  const campaignQuery = queries.find((q) => /LOWER\(jc.public_code\)/.test(q.sql));
  assert.ok(campaignQuery);
  assert.deepEqual(campaignQuery.params, ['K8X4PZ2Q']);
});

test('POST /api/juegos-publicos/participar registra ganador y encola WhatsApp', async () => {
  let participationInserted = null;
  let outboxInserted = null;
  const query = async (sql, params = []) => {
    if (/CREATE TABLE IF NOT EXISTS juegos_campanias/.test(sql)) return [];
    if (/FROM juegos_campanias jc/.test(sql)) return [campaign];
    if (/pg_advisory_xact_lock/.test(sql) && !/INSERT INTO wpp_outbox/.test(sql)) return [];
    if (/COUNT\(\*\)::int AS c/.test(sql)) return [{ c: 0 }];
    if (/FROM juegos_participaciones/.test(sql) && /telefono_norm/.test(sql) && /LIMIT 1/.test(sql)) return [];
    if (/FROM juegos_premios jp/.test(sql)) {
      return [
        {
          id: 3,
          empresa_id: 1,
          campania_id: 7,
          tipo: 'producto_gratis',
          producto_id: 6,
          producto_nombre: 'Bidon 20L',
          nombre_publico: 'Bidon gratis',
          descripcion: 'Un bidon sin cargo',
          probabilidad: 1,
          stock_total: null,
          stock_diario: null,
        },
      ];
    }
    if (/INSERT INTO juegos_participaciones/.test(sql)) {
      participationInserted = params;
      return [{ id: 99, codigo: params[6], resultado_tipo: params[7], resultado_nombre: params[8], created_at: new Date() }];
    }
    if (/UPDATE juegos_participaciones SET enviado_whatsapp_at/.test(sql)) return [];
    return [];
  };
  const outboxPool = createWppEnqueueTestPool({
    configIntegraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-1', access_token_encrypted: 'v1:test' } },
    async onQuery(request) {
      if (/INSERT INTO wpp_outbox/.test(request.text)) {
        outboxInserted = request.values;
        return undefined;
      }
      if (request.text === 'BEGIN' || request.text === 'COMMIT' || request.text === 'ROLLBACK'
        || /pg_advisory_xact_lock/.test(request.text)
        || /SELECT config_integraciones FROM empresas/.test(request.text)
        || /FROM wpp_outbox/.test(request.text)) return undefined;
      return { rows: await query(request.text, request.values) };
    },
  });

  await withServer(buildApp(query, outboxPool), async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/juegos-publicos/participar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ empresa_id: 1, campania: 'raspa-y-gana', telefono: '351 555 1234' }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.ganador, true);
    assert.match(body.codigo, /^AGUA-[A-F0-9]{10}$/);
    assert.equal(body.resultado_tipo, 'producto_gratis');
    assert.equal(body.next_participation_message, 'Esta campania permite participar una sola vez.');
    assert.equal(body.premio.producto_id, 6);
    assert.equal(body.premio.producto_nombre, 'Bidon 20L');
  });

  assert.equal(participationInserted[0], 1);
  assert.equal(participationInserted[1], 7);
  assert.equal(participationInserted[3], 6);
  assert.equal(participationInserted[5], '3515551234');
  assert.equal(outboxInserted[0], 1);
  assert.equal(outboxInserted[1], '5493515551234');
  assert.match(outboxInserted[2], /Bidon gratis/);
  assert.equal(outboxInserted[3], 'cloud');
});

test('POST /participar usa una sola conexión y un único COMMIT exterior para participación y outbox', async () => {
  const statements = [];
  let connects = 0;
  let releases = 0;
  const client = {
    async query(input, params = []) {
      const request = typeof input === 'string' ? { text: input, values: params } : input;
      statements.push(request);
      const { text, values = [] } = request;
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
      if (/FROM juegos_campanias jc/.test(text)) return { rows: [campaign] };
      if (/pg_advisory_xact_lock/.test(text)) return { rows: [] };
      if (/COUNT\(\*\)::int AS c/.test(text)) return { rows: [{ c: 0 }] };
      if (/FROM juegos_participaciones/.test(text) && /telefono_norm/.test(text) && /LIMIT 1/.test(text)) return { rows: [] };
      if (/FROM juegos_premios jp/.test(text)) return { rows: [{
        id: 3, empresa_id: 1, campania_id: 7, tipo: 'producto_gratis', producto_id: 6,
        producto_nombre: 'Bidon 20L', nombre_publico: 'Bidon gratis', descripcion: 'Premio',
        probabilidad: 1, stock_total: null, stock_diario: null,
      }] };
      if (/INSERT INTO juegos_participaciones/.test(text)) return { rows: [{
        id: 99, codigo: values[6], resultado_tipo: values[7], resultado_nombre: values[8], created_at: new Date(),
      }] };
      if (/SELECT config_integraciones FROM empresas/.test(text)) return { rows: [{ config_integraciones: {} }] };
      if (/FROM wpp_outbox/.test(text) && !/INSERT INTO wpp_outbox/.test(text)) return { rows: [] };
      if (/INSERT INTO wpp_outbox/.test(text)) return { rows: [{ id: 44, status: 'pending', transport_origin: 'company' }] };
      if (/UPDATE juegos_participaciones SET enviado_whatsapp_at/.test(text)) return { rows: [] };
      throw new Error(`SQL inesperado: ${text}`);
    },
    release() { releases += 1; },
  };
  const pool = { async connect() { connects += 1; return client; } };

  await withServer(buildApp(async () => [], pool), async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/juegos-publicos/participar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ empresa_id: 1, campania: 'raspa-y-gana', telefono: '351 555 1234' }),
    });
    assert.equal(resp.status, 200);
  });

  assert.equal(connects, 1);
  assert.equal(releases, 1);
  assert.equal(statements.filter(({ text }) => text === 'BEGIN').length, 1);
  assert.equal(statements.filter(({ text }) => text === 'COMMIT').length, 1);
  assert.equal(statements.filter(({ text }) => text === 'ROLLBACK').length, 0);
  const labels = statements.map(({ text }) => {
    if (/pg_advisory_xact_lock\(\$1::integer, hashtext\(\$2\)::integer\)/.test(text)) return 'GAME_LOCK';
    if (/\$1::integer, \$2::integer/.test(text)) return 'CONFIG_LOCK';
    if (/SELECT config_integraciones FROM empresas/.test(text)) return 'CONFIG_READ';
    if (/hashtextextended/.test(text)) return 'DEDUPE_LOCK';
    if (/INSERT INTO wpp_outbox/.test(text)) return 'OUTBOX_INSERT';
    if (/UPDATE juegos_participaciones SET enviado_whatsapp_at/.test(text)) return 'PARTICIPATION_UPDATE';
    return null;
  }).filter(Boolean);
  assert.deepEqual(labels, ['GAME_LOCK', 'CONFIG_LOCK', 'CONFIG_READ', 'DEDUPE_LOCK', 'OUTBOX_INSERT', 'PARTICIPATION_UPDATE']);
});

test('POST /participar revierte participación y outbox si falla antes de COMMIT', async () => {
  const committed = { participations: [], outbox: [] };
  let staged;
  let loggedError;
  const statements = [];
  const client = {
    async query(input, params = []) {
      const request = typeof input === 'string' ? { text: input, values: params } : input;
      const { text, values = [] } = request;
      statements.push(text);
      if (text === 'BEGIN') { staged = { participations: [], outbox: [] }; return { rows: [] }; }
      if (text === 'COMMIT') {
        committed.participations.push(...staged.participations);
        committed.outbox.push(...staged.outbox);
        staged = null;
        return { rows: [] };
      }
      if (text === 'ROLLBACK') { staged = null; return { rows: [] }; }
      if (/FROM juegos_campanias jc/.test(text)) return { rows: [campaign] };
      if (/pg_advisory_xact_lock/.test(text)) return { rows: [] };
      if (/COUNT\(\*\)::int AS c/.test(text)) return { rows: [{ c: 0 }] };
      if (/FROM juegos_participaciones/.test(text) && /telefono_norm/.test(text) && /LIMIT 1/.test(text)) return { rows: [] };
      if (/FROM juegos_premios jp/.test(text)) return { rows: [{
        id: 3, empresa_id: 1, campania_id: 7, tipo: 'producto_gratis', producto_id: 6,
        producto_nombre: 'Bidon 20L', nombre_publico: 'Bidon gratis', descripcion: 'Premio',
        probabilidad: 1, stock_total: null, stock_diario: null,
      }] };
      if (/INSERT INTO juegos_participaciones/.test(text)) {
        staged.participations.push(values);
        return { rows: [{ id: 99, codigo: values[6], resultado_tipo: values[7], resultado_nombre: values[8], created_at: new Date() }] };
      }
      if (/SELECT config_integraciones FROM empresas/.test(text)) return { rows: [{ config_integraciones: {} }] };
      if (/FROM wpp_outbox/.test(text) && !/INSERT INTO wpp_outbox/.test(text)) return { rows: [] };
      if (/INSERT INTO wpp_outbox/.test(text)) {
        staged.outbox.push(values);
        return { rows: [{ id: 44, status: 'pending', transport_origin: 'company' }] };
      }
      if (/UPDATE juegos_participaciones SET enviado_whatsapp_at/.test(text)) throw new Error('forced update failure');
      throw new Error(`SQL inesperado: ${text}`);
    },
    release() {},
  };

  const originalConsoleError = console.error;
  console.error = error => { loggedError = error; };
  try {
    await withServer(buildApp(async () => [], { async connect() { return client; } }), async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/api/juegos-publicos/participar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ empresa_id: 1, campania: 'raspa-y-gana', telefono: '351 555 1234' }),
      });
      assert.equal(resp.status, 500);
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(committed, { participations: [], outbox: [] });
  assert.equal(loggedError?.message, 'forced update failure');
  assert.equal(statements.filter(text => text === 'ROLLBACK').length, 1);
  assert.equal(statements.includes('COMMIT'), false);
});

test('POST /participar trata fallo de COMMIT como resultado desconocido y descarta la conexión', async () => {
  const commitError = new Error('forced commit transport failure');
  const statements = [];
  const releaseArgs = [];
  let loggedError;
  const client = {
    async query(input, params = []) {
      const request = typeof input === 'string' ? { text: input, values: params } : input;
      const { text, values = [] } = request;
      statements.push(text);
      if (text === 'BEGIN') return { rows: [] };
      if (text === 'COMMIT') throw commitError;
      if (text === 'ROLLBACK') throw new Error('no debe intentar rollback después de COMMIT ambiguo');
      if (/FROM juegos_campanias jc/.test(text)) return { rows: [campaign] };
      if (/pg_advisory_xact_lock/.test(text)) return { rows: [] };
      if (/COUNT\(\*\)::int AS c/.test(text)) return { rows: [{ c: 0 }] };
      if (/FROM juegos_participaciones/.test(text) && /telefono_norm/.test(text) && /LIMIT 1/.test(text)) return { rows: [] };
      if (/FROM juegos_premios jp/.test(text)) return { rows: [{
        id: null, empresa_id: 1, campania_id: 7, tipo: 'sin_premio', producto_id: null,
        producto_nombre: null, nombre_publico: 'Sin premio', descripcion: null,
        probabilidad: 1, stock_total: null, stock_diario: null,
      }] };
      if (/INSERT INTO juegos_participaciones/.test(text)) return { rows: [{
        id: 99, codigo: values[6], resultado_tipo: values[7], resultado_nombre: values[8], created_at: new Date(),
      }] };
      throw new Error(`SQL inesperado: ${text}`);
    },
    release(error) { releaseArgs.push(error); },
  };
  const originalConsoleError = console.error;
  console.error = error => { loggedError = error; };
  try {
    await withServer(buildApp(async () => [], { async connect() { return client; } }), async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/api/juegos-publicos/participar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ empresa_id: 1, campania: 'raspa-y-gana', telefono: '351 555 1234' }),
      });
      assert.equal(resp.status, 500);
      assert.deepEqual(await resp.json(), { error: 'Error registrando participacion.' });
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(statements.filter(text => text === 'COMMIT').length, 1);
  assert.equal(statements.filter(text => text === 'ROLLBACK').length, 0);
  assert.deepEqual(releaseArgs, [commitError]);
  assert.equal(loggedError?.code, 'transaction_outcome_unknown');
  assert.equal(loggedError?.message, 'transaction_outcome_unknown');
});

test('POST /participar preserva el error primario si ROLLBACK falla y libera una sola vez descartando el client', async () => {
  const primaryError = new Error('primary transaction failure');
  const rollbackError = new Error('rollback transport failure');
  const statements = [];
  const releaseArgs = [];
  let loggedError;
  const client = {
    async query(input) {
      const text = typeof input === 'string' ? input : input.text;
      statements.push(text);
      if (text === 'BEGIN') return { rows: [] };
      if (text === 'ROLLBACK') throw rollbackError;
      if (/FROM juegos_campanias jc/.test(text)) throw primaryError;
      throw new Error(`SQL inesperado: ${text}`);
    },
    release(error) { releaseArgs.push(error); },
  };
  const originalConsoleError = console.error;
  console.error = error => { loggedError = error; };
  try {
    await withServer(buildApp(async () => [], { async connect() { return client; } }), async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/api/juegos-publicos/participar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ empresa_id: 1, campania: 'raspa-y-gana', telefono: '351 555 1234' }),
      });
      assert.equal(resp.status, 500);
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(loggedError, primaryError);
  assert.equal(statements.filter(text => text === 'ROLLBACK').length, 1);
  assert.equal(statements.filter(text => text === 'COMMIT').length, 0);
  assert.deepEqual(releaseArgs, [rollbackError]);
});

test('POST /api/juegos-publicos/participar acepta codigo publico sin empresa ni slug', async () => {
  let participationInserted = null;
  const query = async (sql, params = []) => {
    if (/CREATE TABLE IF NOT EXISTS juegos_campanias/.test(sql)) return [];
    if (/FROM juegos_campanias jc/.test(sql)) return [campaign];
    if (/pg_advisory_xact_lock/.test(sql) && !/INSERT INTO wpp_outbox/.test(sql)) return [];
    if (/COUNT\(\*\)::int AS c/.test(sql)) return [{ c: 0 }];
    if (/FROM juegos_participaciones/.test(sql) && /telefono_norm/.test(sql) && /LIMIT 1/.test(sql)) return [];
    if (/FROM juegos_premios jp/.test(sql)) {
      return [{ id: null, tipo: 'sin_premio', producto_id: null, nombre_publico: 'Esta vez no hubo premio', descripcion: null, probabilidad: 1 }];
    }
    if (/INSERT INTO juegos_participaciones/.test(sql)) {
      participationInserted = params;
      return [{ id: 100, codigo: null, resultado_tipo: params[7], resultado_nombre: params[8], created_at: new Date() }];
    }
    return [];
  };

  await withServer(buildApp(query), async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/juegos-publicos/participar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ public_code: 'K8X4PZ2Q', telefono: '351 555 1234' }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.ganador, false);
  });

  assert.equal(participationInserted[0], 1);
  assert.equal(participationInserted[1], 7);
});

test('POST /api/juegos-publicos/participar informa cuando puede volver si ya participo', async () => {
  const dailyCampaign = { ...campaign, participacion_limite: 'daily' };
  const query = async (sql) => {
    if (/CREATE TABLE IF NOT EXISTS juegos_campanias/.test(sql)) return [];
    if (/FROM juegos_campanias jc/.test(sql)) return [dailyCampaign];
    if (/pg_advisory_xact_lock/.test(sql) && !/INSERT INTO wpp_outbox/.test(sql)) return [];
    if (/COUNT\(\*\)::int AS c/.test(sql)) return [{ c: 0 }];
    if (/FROM juegos_participaciones/.test(sql) && /telefono_norm/.test(sql) && /LIMIT 1/.test(sql)) {
      return [{ id: 101, created_at: new Date() }];
    }
    return [];
  };

  await withServer(buildApp(query), async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/juegos-publicos/participar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ empresa_id: 1, campania: 'raspa-y-gana', telefono: '351 555 1234' }),
    });
    assert.equal(resp.status, 409);
    const body = await resp.json();
    assert.equal(body.already, true);
    assert.equal(body.error, 'Ese telefono ya participo hoy. Podes volver a participar manana.');
    assert.equal(body.next_participation_label, 'manana');
    assert.equal(body.next_participation_message, 'Podes volver a participar manana.');
  });
});

test('POST /api/juegos-publicos/premio-entrega crea pedido de premio', async () => {
  let pointInserted = null;
  let orderInserted = null;
  let itemInserted = null;
  let participationUpdated = null;

  const query = async (sql, params = []) => {
    if (/CREATE TABLE IF NOT EXISTS juegos_campanias/.test(sql)) return [];
    if (/FROM juegos_campanias jc/.test(sql)) return [campaign];
    if (/FROM juegos_participaciones/.test(sql) && /codigo =/.test(sql)) {
      return [{
        id: 99,
        empresa_id: 1,
        campania_id: 7,
        producto_id: 6,
        telefono: '351 555 1234',
        telefono_norm: '3515551234',
        codigo: 'AGUA-ABC123DEF4',
        resultado_tipo: 'producto_gratis',
        resultado_nombre: 'Bidon gratis',
        pedido_id: null,
      }];
    }
    if (/FROM productos/.test(sql)) return [{ id: 6, nombre: 'Bidon gratis' }];
    if (/FROM puntos_entrega/.test(sql)) return [];
    if (/INSERT INTO puntos_entrega/.test(sql)) {
      pointInserted = params;
      return [{ id: 44 }];
    }
    if (/INSERT INTO pedidos/.test(sql)) {
      orderInserted = params;
      return [{ id: 123, estado: 'pendiente', tracking_token: 'track-123' }];
    }
    if (/INSERT INTO items_pedido/.test(sql)) {
      itemInserted = params;
      return [];
    }
    if (/UPDATE juegos_participaciones/.test(sql)) {
      participationUpdated = params;
      return [];
    }
    return [];
  };

  await withServer(buildApp(query), async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/juegos-publicos/premio-entrega`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        empresa_id: 1,
        campania: 'raspa-y-gana',
        codigo: 'AGUA-ABC123DEF4',
        telefono: '351 555 1234',
        nombre: 'Juan Perez',
        direccion: 'San Martin 123',
        ciudad: 'Villa Maria',
        provincia: 'Cordoba',
        notas: 'Casa azul',
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.pedido_id, 123);
    assert.equal(body.punto_entrega_id, 44);
  });

  assert.equal(pointInserted[0], 1);
  assert.equal(pointInserted[1], 'Juan Perez');
  assert.equal(pointInserted[2], 'San Martin 123');
  assert.equal(orderInserted[0], 1);
  assert.equal(orderInserted[1], 44);
  assert.equal(orderInserted[2], 'juego-1-99');
  assert.equal(itemInserted[0], 123);
  assert.equal(itemInserted[1], 'Bidon gratis');
  assert.equal(itemInserted[2], 6);
  assert.equal(participationUpdated[0], 44);
  assert.equal(participationUpdated[1], 123);
});

test('GET /api/juegos/campanias/:id/participaciones devuelve seguimiento operativo', async () => {
  const query = async (sql, params = []) => {
    if (/CREATE TABLE IF NOT EXISTS juegos_campanias/.test(sql)) return [];
    if (/SELECT id, empresa_id, nombre, titulo_publico/.test(sql)) {
      assert.equal(params[0], 7);
      assert.equal(params[1], 1);
      return [{ id: 7, empresa_id: 1, nombre: 'Raspadita', titulo_publico: 'Raspa y gana' }];
    }
    if (/FROM juegos_participaciones/.test(sql) && /ORDER BY created_at DESC/.test(sql)) {
      return [
        {
          id: 99,
          telefono: '351 555 1234',
          telefono_norm: '3515551234',
          codigo: 'AGUA-ABC123DEF4',
          resultado_tipo: 'producto_gratis',
          resultado_nombre: 'Bidon gratis',
          premio_id: 3,
          producto_id: 6,
          punto_entrega_id: 44,
          pedido_id: 123,
          enviado_whatsapp_at: new Date(),
          redimido_at: null,
          created_at: new Date(),
        },
      ];
    }
    if (/premios_pendientes/.test(sql)) {
      return [{
        participaciones: 3,
        ganadores: 1,
        sin_premio: 2,
        premios_pendientes: 0,
        pedidos_generados: 1,
        premios_redimidos: 0,
        ultima_participacion: new Date(),
      }];
    }
    if (/FROM juegos_premios jp/.test(sql)) {
      return [{
        id: 3,
        tipo: 'producto_gratis',
        nombre_publico: 'Bidon gratis',
        producto_id: 6,
        producto_nombre: 'Bidon 20L',
        stock_total: 10,
        stock_diario: 2,
        entregados: 1,
        pedidos_generados: 1,
        redimidos: 0,
      }];
    }
    return [];
  };

  await withServer(buildAdminApp(query), async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/juegos/campanias/7/participaciones`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.campaign.titulo_publico, 'Raspa y gana');
    assert.equal(body.resumen.participaciones, 3);
    assert.equal(body.resumen.ganadores, 1);
    assert.equal(body.premios[0].producto_nombre, 'Bidon 20L');
    assert.equal(body.items[0].pedido_id, 123);
    assert.equal(body.items[0].telefono_norm, '3515551234');
  });
});

test('GET /api/juegos/campanias/:id/qr usa URL con codigo publico', async () => {
  const query = async (sql, params = []) => {
    if (/CREATE TABLE IF NOT EXISTS juegos_campanias/.test(sql)) return [];
    if (/SELECT id, empresa_id, slug, public_code FROM juegos_campanias/.test(sql)) {
      assert.deepEqual(params, ['7', 1]);
      return [{ id: 7, empresa_id: 1, slug: 'raspa-y-gana', public_code: 'K8X4PZ2Q' }];
    }
    return [];
  };

  await withServer(buildAdminApp(query), async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/juegos/campanias/7/qr`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.url, `${baseUrl}/pedidos/juegos/K8X4PZ2Q`);
    assert.match(body.data_url, /^data:image\/png;base64,/);
  });
});

test('DELETE /api/juegos/campanias/:id/participaciones/:participacionId elimina cualquier participante', async () => {
  const queries = [];
  const query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (/CREATE TABLE IF NOT EXISTS juegos_campanias/.test(sql)) return [];
    if (/DELETE FROM juegos_participaciones/.test(sql)) {
      assert.deepEqual(params, [99, 7, 1]);
      return [{ id: 99 }];
    }
    return [];
  };

  await withServer(buildAdminApp(query), async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/juegos/campanias/7/participaciones/99`, { method: 'DELETE' });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.id, 99);
  });

  assert.ok(queries.some(({ sql }) => /DELETE FROM juegos_participaciones/.test(sql)));
});
