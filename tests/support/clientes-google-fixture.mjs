// Local synthetic client-screen harness. Never starts the app or accesses its configured DB.
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWithAuth } from '../../src/core/auth.js';
import { createClientesRouter } from '../../src/routes/clientes.js';
export function clientesFixture({ browserKey = 'synthetic-browser-key', mapId } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const app = express(); app.use(express.json());
  const user = { id: 1, role: 'admin', empresa_id: 7, activo: true, chofer_id: null, referente_id: null };
  const clients = [
    { id: 1001, empresa_id: 7, cliente: 'Cliente sintético A', telefono: '3515551234', direccion: 'Dirección de prueba', ciudad: 'Córdoba', provincia: 'Córdoba', latitud: -31.42, longitud: -64.19, zona_id: 3 },
    { id: 1002, empresa_id: 7, cliente: 'Cliente sintético B', direccion: 'Otra dirección de prueba', ciudad: 'Córdoba', latitud: null, longitud: null },
  ];
  const writes = [], unexpected = [];
  const geocode = { respond: async () => ({ latitud: -31.44, longitud: -64.23, zona_id: 3 }) };
  const env = { GOOGLE_MAPS_BROWSER_API_KEY: browserKey, GOOGLE_MAPS_MAP_ID: mapId };
  const secret = 'synthetic-client-fixture-only';
  const router = createClientesRouter({ mapsBrowserEnv: env, query: async () => { throw new Error('Business SQL prohibited'); }, withAuth: createWithAuth({ jwtSecret: secret, queryFn: async (_sql, args) => args[0] === 1 ? [user] : [] }) });
  app.get('/api/me', (_req, res) => res.json({ user }));
  app.get('/api/empresas', (_req, res) => res.json([{ id: 7, nombre: 'Empresa sintética' }]));
  app.get('/api/clientes/master', (_req, res) => res.json(clients));
  app.get('/api/zonas', (_req, res) => res.json([{ id: 3, nombre: 'Zona sintética' }]));
  for (const endpoint of ['/api/zonas/choferes', '/api/choferes']) app.get(endpoint, (_req, res) => res.json([]));
  app.post('/api/clientes/geocode', async (req, res) => res.json(await geocode.respond(req.body)));
  app.put('/api/clientes/:id', (req, res) => {
    writes.push({ url: req.path, body: req.body });
    const c = clients.find(c => c.id === Number(req.params.id)); if (c) Object.assign(c, req.body);
    res.json({ ok: true, cliente: c });
  });
  app.post('/api/clientes', (req, res) => { writes.push({ url: req.path, body: req.body }); res.json({ ok: true, cliente: { id: 1003, ...req.body } }); });
  app.use('/api/clientes', (req, res, next) => {
    if (req.path !== '/maps-config') return next();
    req.headers.authorization = 'Bearer ' + jwt.sign({ uid: 1, role: user.role }, secret);
    return router(req, res, next);
  });
  app.use('/api', (req, res) => { unexpected.push(req.method + ' ' + req.originalUrl); res.status(404).json({ error: 'Unexpected fixture endpoint' }); });
  app.use('/pedidos', express.static(path.join(root, 'pedidos')));
  return { app, root, user, clients, writes, geocode, env, unexpected };
}
