import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {readFileSync} from 'node:fs';

import { registerPublicLegacyCreatePedidoRoute } from '../src/routes/publicLegacyCreatePedido.js';
import { toNum, inRange, round, buildOrderSummary } from '../src/public/pedidosLegacyHelpers.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';
import { lockProductIdentityNamespaces } from '../src/services/productIdentityNamespace.js';

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const { port } = server.address();
    await work(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function createFixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (
      id integer PRIMARY KEY,
      landing_slug text,
      landing_domain text,
      plan_estado text DEFAULT 'active',
      plan_vencimiento timestamptz,
      config_entrega jsonb DEFAULT '{}'::jsonb
    );
    CREATE TABLE productos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      nombre text NOT NULL,
      precio numeric DEFAULT 0,
      activo boolean DEFAULT true,
      mostrar_en_catalogo boolean DEFAULT true,
      mostrar_en_landing boolean DEFAULT true,
      deleted_at timestamptz,
      promo_config jsonb,
      config_activo jsonb DEFAULT '{}'::jsonb,
      retornable boolean DEFAULT false
    );
    CREATE TABLE zonas_geograficas (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL,
      dias_entrega jsonb DEFAULT '[]'::jsonb
    );
    CREATE TABLE puntos_entrega (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL,
      cliente text,
      telefono text,
      telefono_normalizado text,
      direccion text,
      ciudad text,
      provincia text,
      pais text,
      latitud numeric,
      longitud numeric,
      notas text,
      zona_id integer
    );
    CREATE TABLE pedidos (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL,
      punto_entrega_id integer,
      fecha timestamptz,
      estado text,
      cantidad numeric,
      cantidad_entregada numeric,
      monto numeric,
      metodo_pago text,
      aviso_recibido integer,
      sats integer,
      submission_id text,
      chofer_id integer,
      zona_id integer,
      fecha_entrega_estimada date,
      referido_por_id integer,
      notas text,
      tracking_token text
    );
    CREATE TABLE items_pedido (
      id serial PRIMARY KEY,
      pedido_id integer NOT NULL REFERENCES pedidos(id),
      producto text,
      producto_id integer,
      cantidad numeric,
      precio_unitario numeric
    );
    CREATE TABLE cliente_recompensas (
      id serial PRIMARY KEY,
      cliente_id integer,
      producto_id integer,
      cantidad numeric,
      reclamado boolean DEFAULT false,
      fecha_reclamado timestamptz,
      origen_pedido_id integer
    );
    CREATE TABLE cliente_retornables_saldos (
      empresa_id integer,
      punto_entrega_id integer,
      producto_id integer,
      saldo numeric
    );
    CREATE TABLE promociones_redenciones (
      id serial PRIMARY KEY,
      empresa_id integer,
      punto_entrega_id integer,
      trigger_producto_id integer,
      beneficio_tipo text,
      beneficio_producto_id integer,
      pedido_id integer,
      created_at timestamptz DEFAULT now()
    );
    INSERT INTO empresas (id, landing_slug, landing_domain) VALUES
      (1, 'tenant-uno', 'uno.example.test'),
      (2, 'tenant-dos', 'dos.example.test');
  `);
}

async function resetData(pool) {
  await pool.query(`
    TRUNCATE promociones_redenciones, cliente_retornables_saldos, cliente_recompensas,
      items_pedido, pedidos, puntos_entrega, productos RESTART IDENTITY CASCADE;
  `);
}

function buildApp(pool, overrides = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  registerPublicLegacyCreatePedidoRoute(app, {
    query,
    nowFn: overrides.nowFn,
    pool: overrides.pool || pool,
    geocodeIfNeeded: overrides.geocodeIfNeeded || (async () => null),
    normalizePhone: value => String(value || '').replace(/\D+/g, ''),
    pointInAnyZone: async () => null,
    enqueueOrderConfirmationWppMessage: overrides.enqueueWppMessage || (async () => null),
    enqueueWppMessage: overrides.enqueueWppMessage || (async () => null),
    sendSmsViaIfttt: async () => null,
    toNum,
    inRange,
    round,
    buildOrderSummary,
    getAliasEmpresa: async () => null,
    ejecutarEstrategiaVecinosFn: overrides.ejecutarEstrategiaVecinosFn || (async () => null),
    resolveEmpresaIdFn: overrides.resolveEmpresaIdFn,
  });
  return app;
}

function payload(item, suffix) {
  return {
    empresa_id: 1,
    cliente: `Cliente ${suffix}`,
    telefono: `351555${String(suffix).padStart(4, '0')}`,
    direccion: `Calle ${suffix}`,
    items: [{ cantidad: 1, precio_unitario: 1200, ...item }],
  };
}

async function postPedido(baseUrl, body, ipSuffix, extraHeaders = {}) {
  const tenantQuery = Object.hasOwn(extraHeaders, 'x-test-url-query')
    ? extraHeaders['x-test-url-query']
    : `empresa_id=${encodeURIComponent(body.empresa_id)}`;
  const headers = { ...extraHeaders };
  delete headers['x-test-url-query'];
  const response = await fetch(`${baseUrl}/public/pedidos?${tenantQuery}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.77.0.${ipSuffix}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function mutationCounts(pool) {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pedidos) AS pedidos,
      (SELECT COUNT(*)::int FROM items_pedido) AS items,
      (SELECT COUNT(*)::int FROM promociones_redenciones) AS promociones,
      (SELECT COUNT(*)::int FROM puntos_entrega) AS puntos_entrega
  `);
  return result.rows[0];
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('scheduled confirmation binds one header date and immutable replay intent', postgresOptions, async () => {
  process.env.SCHEDULED_MENUS_ENABLED='1';
  try { await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(readFileSync(new URL('../src/menu/schema.sql',import.meta.url),'utf8'));
    await pool.query(`
      UPDATE empresas SET menu_config='{"enabled":true,"timezone":"UTC","advance_enabled":true}'::jsonb;
      INSERT INTO productos(id,empresa_id,nombre,precio,disponibilidad_config) VALUES(55,1,'Menu',1200,'{"enabled":true,"weekdays":[0,1,2,3,4,5,6],"daily_capacity":1}');`);
    let notices=0;
    const app=buildApp(pool,{enqueueWppMessage:async()=>{notices++;}});
    const date=new Date().toISOString().slice(0,10);
    await withServer(app, async base => {
      const body={...payload({producto_id:55,producto:'Menu'},9100),submission_id:'scheduled-1',fecha_entrega:date,catalog_channel:'catalog'};
      const first=await postPedido(base,body,1);
      assert.equal(first.status,200,JSON.stringify(first.body));
      assert.equal(first.body.pedido.fecha_entrega_programada,date);
      const count=notices;
      const replay=await postPedido(base,body,2);
      assert.equal(replay.status,200); assert.equal(replay.body.created,false);
      assert.equal(replay.body.pedido.fecha_entrega_programada,date);
      assert.equal(notices,count);
      assert.equal((await pool.query('SELECT reservado FROM public.menu_cupos_diarios')).rows[0].reservado,'1');
      const exhausted=await postPedido(base,{...body,submission_id:'scheduled-2'},5);
      assert.equal(exhausted.status,409);
      assert.equal(notices,count);
      const conflict=await postPedido(base,{...body,items:[{...body.items[0],cantidad:2}]},3);
      assert.equal(conflict.status,409);
      const itemDate=await postPedido(base,{...body,submission_id:'bad-date',items:[{...body.items[0],fecha_entrega:date}]},4);
      assert.equal(itemDate.status,400);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pedidos')).rows[0].n,1);
    });
  }); } finally { delete process.env.SCHEDULED_MENUS_ENABLED; }
});

test('landing confirmation persists its original channel and rejects channel-changing replay',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{await withIsolatedPostgres(async pool=>{
  await createFixture(pool);await pool.query(readFileSync(new URL('../src/menu/schema.sql',import.meta.url),'utf8'));
  await pool.query(`UPDATE empresas SET menu_config='{"enabled":true,"timezone":"UTC"}';
   INSERT INTO productos(id,empresa_id,nombre,precio,disponibilidad_config) VALUES(55,1,'Menu',1200,'{"enabled":true,"mode":"weekly","weekdays":[1],"channels":{"landing":{"weekdays":[4]}},"daily_capacity":2}');`);
  const app=buildApp(pool,{nowFn:()=>new Date('2026-10-15T12:00:00Z')});
  await withServer(app,async base=>{
   const body={...payload({producto_id:55,producto:'Menu'},9900),fecha_entrega:'2026-10-15',submission_id:'landing-original',catalog_channel:'landing'};
   const first=await postPedido(base,body,70);assert.equal(first.status,200,JSON.stringify(first.body));
   const saved=(await pool.query('SELECT menu_channel,menu_intent_hash,fecha_entrega_programada::text FROM pedidos')).rows[0];
   assert.equal(saved.menu_channel,'landing');assert.equal(saved.fecha_entrega_programada,'2026-10-15');assert.ok(saved.menu_intent_hash);
   const replay=await postPedido(base,body,71);assert.equal(replay.status,200);assert.equal(replay.body.created,false);
   const conflict=await postPedido(base,{...body,catalog_channel:'catalog'},72);assert.equal(conflict.status,409);
   assert.equal((await pool.query('SELECT reservado FROM public.menu_cupos_diarios')).rows[0].reservado,'1');
   await pool.query("UPDATE empresas SET menu_config='{}'");
   const legacy=await postPedido(base,{...payload({producto_id:55,producto:'Menu'},9901),catalog_channel:'landing'},73);
   assert.equal(legacy.status,200,JSON.stringify(legacy.body));
   assert.equal((await pool.query('SELECT menu_channel FROM pedidos ORDER BY id DESC LIMIT 1')).rows[0].menu_channel,null);
  });
 });}finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('omitted date defaults to tenant today and next-day retry preserves the committed date',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{await withIsolatedPostgres(async pool=>{
  await createFixture(pool);await pool.query(readFileSync(new URL('../src/menu/schema.sql',import.meta.url),'utf8'));
  await pool.query(`UPDATE empresas SET menu_config='{"enabled":true,"timezone":"UTC","advance_enabled":true}';
   INSERT INTO productos(id,empresa_id,nombre,precio,disponibilidad_config) VALUES(55,1,'Menu',1200,'{"enabled":true,"weekdays":[0,1,2,3,4,5,6],"daily_capacity":1}');`);
  let current=new Date('2026-10-15T12:00:00Z');let notices=0;
  const app=buildApp(pool,{nowFn:()=>current,enqueueWppMessage:async()=>{notices++;}});
  await withServer(app,async base=>{
   const body={...payload({producto_id:55,producto:'Menu'},9500),submission_id:'omitted-date'};
   const first=await postPedido(base,body,30);
   assert.equal(first.status,200,JSON.stringify(first.body));
   assert.equal(first.body.pedido.fecha_entrega_programada,'2026-10-15');
   current=new Date('2026-10-16T12:00:00Z');
   const replay=await postPedido(base,body,31);
   assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.created,false);
   assert.equal(replay.body.pedido.fecha_entrega_programada,'2026-10-15');assert.equal(notices,1);
   const conflict=await postPedido(base,{...body,fecha_entrega:'2026-10-16'},32);
   assert.equal(conflict.status,409);assert.equal(conflict.body.code,'MENU_INTENT_CONFLICT');
   const same=await postPedido(base,{...body,fecha_entrega:'2026-10-15'},33);
   assert.equal(same.status,200,JSON.stringify(same.body));
   assert.equal((await pool.query('SELECT reservado FROM public.menu_cupos_diarios')).rows[0].reservado,'1');
  });
 });}finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('lost COMMIT acknowledgement replays the committed scheduled order without a second reservation or notifier',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{await withIsolatedPostgres(async pool=>{
  await createFixture(pool);await pool.query(readFileSync(new URL('../src/menu/schema.sql',import.meta.url),'utf8'));
  await pool.query(`UPDATE empresas SET menu_config='{"enabled":true,"timezone":"UTC"}';
   INSERT INTO productos(id,empresa_id,nombre,precio,disponibilidad_config) VALUES(55,1,'Menu',1200,'{"enabled":true,"weekdays":[0,1,2,3,4,5,6],"daily_capacity":1}');`);
  let lose=true,notices=0;
  const wrapped={connect:async()=>{const c=await pool.connect();return {query:async(s,p)=>{const r=await c.query(s,p);if(s==='COMMIT'&&lose){lose=false;throw Object.assign(new Error('synthetic lost acknowledgement'),{code:'ECONNRESET'});}return r;},release:e=>c.release(e)};}};
  const app=buildApp(pool,{pool:wrapped,nowFn:()=>new Date('2026-10-15T12:00:00Z'),enqueueWppMessage:async()=>{notices++;}});
  await withServer(app,async base=>{
   const body={...payload({producto_id:55,producto:'Menu'},9700),submission_id:'lost-commit',fecha_entrega:'2026-10-15'};
   const first=await postPedido(base,body,50);assert.equal(first.status,503);assert.equal(first.body.code,'TRANSACTION_OUTCOME_UNKNOWN');
   const replay=await postPedido(base,body,51);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.created,false);
   assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos')).rows[0].n,1);
   assert.equal((await pool.query('SELECT reservado FROM public.menu_cupos_diarios')).rows[0].reservado,'1');assert.equal(notices,0);
  });
 });}finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('public confirmation acquires the SQL write barrier before company or product row locks',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{await withIsolatedPostgres(async pool=>{
  await createFixture(pool);await pool.query(readFileSync(new URL('../src/menu/schema.sql',import.meta.url),'utf8'));
  await pool.query(`UPDATE empresas SET menu_config='{"enabled":true,"timezone":"UTC"}';INSERT INTO productos(id,empresa_id,nombre,precio) VALUES(55,1,'Menu',1200);`);
  const statements=[];
  const wrapped={connect:async()=>{const c=await pool.connect();return {query:async(s,p)=>{statements.push(s);return c.query(s,p);},release:e=>c.release(e)};}};
  const app=buildApp(pool,{pool:wrapped,nowFn:()=>new Date('2026-10-15T12:00:00Z')});
  await withServer(app,async base=>{
   const result=await postPedido(base,{...payload({producto_id:55,producto:'Menu'},9800),fecha_entrega:'2026-10-15'},60);
   assert.equal(result.status,200,JSON.stringify(result.body));
   const barrier=statements.findIndex(s=>s.includes('public.menu_write_barrier'));
   const rowLock=statements.findIndex(s=>/FOR (SHARE|UPDATE)/.test(s) && !s.includes('public.menu_write_barrier'));
   assert.ok(barrier>=0 && barrier<rowLock,JSON.stringify({barrier,rowLock}));
  });
 });}finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('window is rechecked after item writes and no notifier runs on rejected final composition',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{await withIsolatedPostgres(async pool=>{
  await createFixture(pool);await pool.query(readFileSync(new URL('../src/menu/schema.sql',import.meta.url),'utf8'));
  await pool.query(`UPDATE empresas SET menu_config='{"enabled":true,"timezone":"UTC"}';
    INSERT INTO productos(id,empresa_id,nombre,precio,disponibilidad_config) VALUES(55,1,'Menu',1200,'{"enabled":true,"weekdays":[0,1,2,3,4,5,6],"close_time":"10:01"}');`);
  let current=new Date('2026-10-15T10:00:00Z');let inserts=0;let notices=0;
  const wrapped={connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,params)=>{const result=await client.query(sql,params);if(sql.includes('INSERT INTO items_pedido')){inserts++;current=new Date('2026-10-15T10:02:00Z');}return result;},release:(...args)=>client.release(...args)};
  }};
  const app=buildApp(pool,{pool:wrapped,nowFn:()=>current,enqueueWppMessage:async()=>{notices++;}});
  await withServer(app,async base=>{
   const result=await postPedido(base,{...payload({producto_id:55,producto:'Menu'},9200),fecha_entrega:'2026-10-15'},10);
   assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(result.body.code,'MENU_UNAVAILABLE');assert.equal(inserts,1);assert.equal(notices,0);
   assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos')).rows[0].n,0);
   assert.equal((await pool.query('SELECT count(*)::int n FROM public.menu_reservas_items')).rows[0].n,0);
  });
 });}finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('public hidden scheduled products cannot be purchased manually but physical gifts still reserve',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{await withIsolatedPostgres(async pool=>{
  await createFixture(pool);await pool.query(readFileSync(new URL('../src/menu/schema.sql',import.meta.url),'utf8'));
  await pool.query(`UPDATE empresas SET menu_config='{"enabled":true,"timezone":"UTC"}';
   INSERT INTO productos(id,empresa_id,nombre,precio,promo_config,disponibilidad_config,mostrar_en_catalogo) VALUES
    (55,1,'Menu',1200,'{"once_per_client_gift":{"enabled":true,"gift_product_id":66}}','{"enabled":true,"weekdays":[0,1,2,3,4,5,6]}',true),
    (66,1,'Regalo',0,NULL,'{"enabled":true,"weekdays":[0,1,2,3,4,5,6],"daily_capacity":2}',false);`);
  const app=buildApp(pool,{nowFn:()=>new Date('2026-10-15T12:00:00Z')});
  await withServer(app,async base=>{
   const rejected=await postPedido(base,{...payload({producto_id:66,producto:'Regalo'},9600),fecha_entrega:'2026-10-15'},40);
   assert.equal(rejected.status,409,JSON.stringify(rejected.body));
   assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos')).rows[0].n,0);
   const accepted=await postPedido(base,{...payload({producto_id:55,producto:'Menu'},9601),fecha_entrega:'2026-10-15'},41);
   assert.equal(accepted.status,200,JSON.stringify(accepted.body));
   assert.equal((await pool.query('SELECT reservado FROM public.menu_cupos_diarios WHERE producto_id=66')).rows[0].reservado,'1');
  });
 });}finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('promotion gift participates in authoritative final availability before any order survives',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{await withIsolatedPostgres(async pool=>{
  await createFixture(pool);await pool.query(readFileSync(new URL('../src/menu/schema.sql',import.meta.url),'utf8'));
  await pool.query(`UPDATE empresas SET menu_config='{"enabled":true,"timezone":"UTC"}';
   INSERT INTO productos(id,empresa_id,nombre,precio,promo_config,disponibilidad_config) VALUES
    (55,1,'Menu',1200,'{"once_per_client_gift":{"enabled":true,"gift_product_id":66}}','{"enabled":true,"weekdays":[0,1,2,3,4,5,6],"daily_capacity":1}'),
    (66,1,'Regalo',0,NULL,'{"enabled":true,"weekdays":[0,1,2,3,4,5,6],"daily_capacity":0}');`);
  let notices=0;
  const app=buildApp(pool,{nowFn:()=>new Date('2026-10-15T12:00:00Z'),enqueueWppMessage:async()=>{notices++;}});
  await withServer(app,async base=>{
   const body={...payload({producto_id:55,producto:'Menu'},9300),fecha_entrega:'2026-10-15',submission_id:'gift-test'};
   const rejected=await postPedido(base,body,11);assert.equal(rejected.status,409,JSON.stringify(rejected.body));
   assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos')).rows[0].n,0);
   assert.equal((await pool.query('SELECT count(*)::int n FROM puntos_entrega')).rows[0].n,0);assert.equal(notices,0);
   await pool.query(`UPDATE productos SET disponibilidad_config=disponibilidad_config || '{"daily_capacity":1}'::jsonb WHERE id=66`);
   const accepted=await postPedido(base,body,12);assert.equal(accepted.status,200,JSON.stringify(accepted.body));
   assert.deepEqual((await pool.query('SELECT producto_id,reservado FROM public.menu_cupos_diarios ORDER BY producto_id')).rows,[{producto_id:55,reservado:'1'},{producto_id:66,reservado:'1'}]);
  });
 });}finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('two public confirmations racing last quota commit one order and one notification',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{await withIsolatedPostgres(async pool=>{
  await createFixture(pool);await pool.query(readFileSync(new URL('../src/menu/schema.sql',import.meta.url),'utf8'));
  await pool.query(`UPDATE empresas SET menu_config='{"enabled":true,"timezone":"UTC"}';
   INSERT INTO productos(id,empresa_id,nombre,precio,disponibilidad_config) VALUES(55,1,'Menu',1200,'{"enabled":true,"weekdays":[0,1,2,3,4,5,6],"daily_capacity":1}');`);
  const gate=deferred();let checks=0,notices=0;
  const wrapped={connect:async()=>{const client=await pool.connect();return {
   query:async(sql,params)=>{
    const result=await client.query(sql,params);
    if(sql==='BEGIN' && checks<2){checks++;if(checks===2)gate.resolve();await gate.promise;}
    return result;
   },release:(...args)=>client.release(...args)
  };}};
  const app=buildApp(pool,{pool:wrapped,nowFn:()=>new Date('2026-10-15T12:00:00Z'),enqueueWppMessage:async()=>{notices++;}});
  await withServer(app,async base=>{
   const bodies=[9400,9401].map(id=>({...payload({producto_id:55,producto:'Menu'},id),fecha_entrega:'2026-10-15',submission_id:`race-${id}`}));
   const results=await Promise.all(bodies.map((body,i)=>postPedido(base,body,20+i)));
   assert.deepEqual(results.map(result=>result.status).sort(),[200,409],JSON.stringify(results));
   assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos')).rows[0].n,1);
   assert.equal((await pool.query('SELECT reservado FROM public.menu_cupos_diarios')).rows[0].reservado,'1');assert.equal(notices,1);
  });
 });}finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});
