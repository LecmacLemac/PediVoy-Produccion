// Local-only synthetic dashboard fixtures. No production DB or application startup.
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWithAuth } from '../../src/core/auth.js';
import { createPedidosRouter } from '../../src/routes/pedidos.js';

export function dashboardFixture({ browserKey = 'synthetic-browser-key', mapId } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const app = express();
  app.use(express.json());
  const user = { id: 1, role: 'admin', empresa_id: 7, activo: true, chofer_id: null, referente_id: null };
  const rows = [
    { id: 5001, empresa_id: 7, empresa_nombre: 'Empresa sintética', estado: 'cancelado', punto_entrega_id: 1001, cliente: 'Cliente sintético', direccion: 'Dirección de prueba', ciudad: 'Córdoba', provincia: 'Córdoba', pais: 'Argentina', monto: 3000, metodo_pago: 'efectivo', latitud: -31.42, longitud: -64.19, fecha: new Date().toISOString() },
    { id: 5002, empresa_id: 7, empresa_nombre: 'Empresa sintética', estado: 'entregado', punto_entrega_id: 1002, cliente: 'Cliente sintético 2', direccion: 'Dirección de prueba', monto: 3000, metodo_pago: 'efectivo', latitud: null, longitud: null, fecha: new Date().toISOString() },
  ];
  const items = [{ producto: 'Producto de prueba', cantidad: 2, precio_unitario: 1500 }];
  const writes = [];
  const unexpected = [];
  const config = { GOOGLE_MAPS_BROWSER_API_KEY: browserKey, GOOGLE_MAPS_MAP_ID: mapId };
  const secret = 'synthetic-dashboard-fixture-only';
  const auth = createWithAuth({ jwtSecret: secret, queryFn: async (_sql, args) => args[0] === 1 ? [user] : [] });
  const router = createPedidosRouter({ withAuthFn: auth, mapsBrowserEnv: config });
  app.get('/api/me', (_req, res) => res.json({ user }));
  app.get('/api/empresas', (_req, res) => res.json([{ id: 7, nombre: 'Empresa sintética' }]));
  for (const p of ['/api/choferes', '/api/zonas', '/api/productos']) app.get(p, (_req, res) => res.json([]));
  app.get('/api/pedidos/dashboard-data', (_req, res) => res.json({ rows, total_count: rows.length, total_pages: 1, page: 1, pageSize: 25 }));
  app.get('/api/pedidos/:id/items', (_req, res) => res.json(items));
  const geocode = { respond: async () => ({ latitud: -31.44, longitud: -64.23 }) };
  app.post('/api/clientes/geocode', async (req, res) => res.json(await geocode.respond(req.body)));
  app.put('/api/clientes/:id', (req, res) => { writes.push({ url: req.path, body: req.body }); res.json({ ok: true }); });
  app.put('/api/pedidos/:id', (req, res) => {
    writes.push({ url: req.path, body: req.body });
    const row = rows.find(r => r.id === Number(req.params.id));
    if (row && req.body.estado) row.estado = req.body.estado;
    res.json({ ok: true });
  });
  app.use('/api/pedidos', (req, res, next) => {
    // Never let another real router handler access the configured business DB.
    if (req.path !== '/maps-config') return next();
    req.headers.authorization = 'Bearer ' + jwt.sign({ uid: 1, role: user.role }, secret);
    return router(req, res, next);
  });
  app.use('/api', (req, res) => { unexpected.push(req.method + ' ' + req.originalUrl); res.status(404).json({ error: 'No synthetic fixture for this endpoint' }); });
  app.use('/pedidos', express.static(path.join(root, 'pedidos')));
  return { app, root, rows, user, writes, unexpected, config, geocode };
}
