import path from 'node:path';
import { createApp } from '../../src/app.js';

let wppCalls = 0;
const noop = async () => null;
const rowsFor = (sql, params = []) => {
  const text = String(sql);
  if (text.includes('LOWER(TRIM(landing_slug))')) return params[0] === 'tenant-uno' ? [{ id: 1 }] : [];
  if (/SELECT\s+id[\s\S]*FROM empresas[\s\S]*WHERE id = \$1/.test(text)) return [{ id: 1 }];
  if (text.includes('FROM information_schema.columns')) {
    return [
      { table_name: 'pedidos', column_name: 'fecha_entrega_estimada' },
      { table_name: 'zonas_geograficas', column_name: 'dias_entrega' },
    ];
  }
  if (/ALTER TABLE/i.test(text)) return [];
  if (text.includes('FROM puntos_entrega') && text.includes('RIGHT(REGEXP_REPLACE')) return [];
  if (text.includes('INSERT INTO puntos_entrega')) return [{ id: 101 }];
  if (text.includes('FROM zona_chofer')) return [{ id: 55 }];
  if (text.includes('FROM productos') && text.includes('promo_config')) {
    return [{ id: 55, nombre: 'Bidón 20L', promo_config: null, config_activo: {}, retornable: false }];
  }
  if (text.includes('FROM cliente_recompensas')) return [];
  if (text.includes('SELECT pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: null }];
  if (text.includes('FROM pedidos') && text.includes('submission_id = $2')) return [];
  if (text.includes('INSERT INTO pedidos')) return [{ id: 9003, estado: 'pendiente', monto: 3500, tracking_token: 'tok_9003' }];
  if (text.includes('INSERT INTO items_pedido')) return [];
  if (text.includes('SELECT config_entrega FROM empresas')) return [{ config_entrega: {} }];
  if (text.includes('SELECT dias_entrega') && text.includes('FROM zonas_geograficas')) return [{ dias_entrega: [] }];
  if (text.includes('SELECT nombre, telefono FROM choferes')) return [];
  if (text.includes('FROM cliente_retornables_saldos')) return [];
  return [];
};
const query = async (sql, params = []) => rowsFor(sql, params);
const pool = {
  async connect() {
    return {
      async query(sql, params = []) { return { rows: rowsFor(sql, params) }; },
      release() {},
    };
  },
  async query(sql, params = []) { return { rows: rowsFor(sql, params) }; },
};

const app = createApp({
  projectDir: path.resolve('.'),
  query,
  pool,
  withTransaction: async work => work(query),
  withAuth: (_req, _res, next) => next(),
  isSuper: () => false,
  getEmpresaIdFromToken: () => 1,
  resolveEmpresaId: () => 1,
  getEmpresaById: async () => null,
  crearPreferenciaLicencia: noop,
  obtenerPago: noop,
  geocodeIfNeeded: async () => ({ lat: -24.8, lng: -65.4 }),
  normalizePhone: value => String(value || '').replace(/\D+/g, ''),
  pointInAnyZone: async () => 7,
  sendSmsViaIfttt: noop,
  ENABLE_WPP: false,
  WPP_QR_ONLY: false,
  wpp: {
    checkLicencia: (_req, _res, next) => next(),
    enqueueWppMessage: async () => { wppCalls += 1; },
  },
  ejecutarEstrategiaVecinos: noop,
  ejecutarPostEntregaUpsell: noop,
});

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const response = await fetch(`http://127.0.0.1:${port}/public/pedidos?slug=tenant-uno`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '3.3.3.3' },
  body: JSON.stringify({
    empresa_id: 1,
    cliente: 'Cliente prueba',
    telefono: '3515550000',
    direccion: 'Calle 1',
    ciudad: 'Salta',
    provincia: 'Salta',
    pais: 'Argentina',
    metodo_pago: 'efectivo',
    submission_id: 'sub-9003',
    items: [{ producto: 'Bidón 20L', producto_id: 55, cantidad: 1, precio_unitario: 3500 }],
  }),
});
const body = await response.json();
await new Promise(resolve => setTimeout(resolve, 20));
await new Promise(resolve => server.close(resolve));
console.log(`RESULT:${JSON.stringify({ status: response.status, ok: body.ok, pedidoId: body.pedido?.id, wppCalls })}`);
process.exit(0);
