import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createJuegosPublicosRouter, createJuegosRouter } from '../src/routes/juegos.js';

function buildApp(query) {
  const app = express();
  app.use(express.json());
  app.use('/api/juegos-publicos', createJuegosPublicosRouter({ query }));
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

test('POST /api/juegos-publicos/participar registra ganador y encola WhatsApp', async () => {
  let participationInserted = null;
  let outboxInserted = null;
  const query = async (sql, params = []) => {
    if (/CREATE TABLE IF NOT EXISTS juegos_campanias/.test(sql)) return [];
    if (/FROM juegos_campanias jc/.test(sql)) return [campaign];
    if (/pg_advisory_xact_lock/.test(sql)) return [];
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
    if (/INSERT INTO wpp_outbox/.test(sql)) {
      outboxInserted = params;
      return [];
    }
    if (/UPDATE juegos_participaciones SET enviado_whatsapp_at/.test(sql)) return [];
    return [];
  };

  await withServer(buildApp(query), async (baseUrl) => {
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
  assert.equal(outboxInserted[1], '3515551234');
  assert.match(outboxInserted[2], /Bidon gratis/);
});

test('POST /api/juegos-publicos/participar informa cuando puede volver si ya participo', async () => {
  const dailyCampaign = { ...campaign, participacion_limite: 'daily' };
  const query = async (sql) => {
    if (/CREATE TABLE IF NOT EXISTS juegos_campanias/.test(sql)) return [];
    if (/FROM juegos_campanias jc/.test(sql)) return [dailyCampaign];
    if (/pg_advisory_xact_lock/.test(sql)) return [];
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
