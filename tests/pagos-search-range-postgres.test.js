import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import puppeteer from 'puppeteer';
import cookieParser from 'cookie-parser';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

// Fence dotenv and every default connection before importing real route modules.
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.DATABASE_URL = 'postgres://invalid:invalid@127.0.0.1:1/unused';
process.env.ENABLE_WPP = '0';
if (process.env.TMPDIR) { fs.mkdirSync(process.env.TMPDIR, { recursive: true }); process.chdir(process.env.TMPDIR); }
const { createTransferenciasRouter } = await import('../src/routes/transferencias.js');
const qrModule = await import('../src/qr/pagosRouter.js');
const { createWithAuth } = await import('../src/core/auth.js');
const { requireCanonicalBackofficeRole } = await import('../src/routes/canonicalBackofficeRole.js');

async function setup(pool) {
  await pool.query(`
    SET TIME ZONE 'UTC';
    CREATE TABLE usuarios(id int PRIMARY KEY, username text, role text, empresa_id int, chofer_id int, referente_id int, activo boolean);
    CREATE TABLE choferes(id int PRIMARY KEY, empresa_id int, nombre text, activo boolean);
    CREATE TABLE referentes(id int PRIMARY KEY, empresa_id int, activo boolean, deleted_at timestamptz);
    CREATE TABLE puntos_entrega(id int PRIMARY KEY, empresa_id int, cliente text, telefono text, direccion text, zona_id int);
    CREATE TABLE zonas_geograficas(id int PRIMARY KEY, empresa_id int, nombre text);
    CREATE TABLE empresa_cuentas_bancarias(id int PRIMARY KEY, empresa_id int, banco text, alias text, cbu text, titular text, activa boolean DEFAULT true, prioridad int);
    CREATE TABLE pedidos(id int PRIMARY KEY, empresa_id int, punto_entrega_id int, zona_id int, chofer_id int, fecha timestamptz, estado text, monto numeric, metodo_pago text);
    CREATE TABLE comprobantes_transferencia(id int PRIMARY KEY, empresa_id int, pedido_id int, zona_id int, chofer_id int,
      fecha timestamptz, monto numeric, metodo_pago text, comprobante_path text, validado int DEFAULT 0, procesado boolean DEFAULT false,
      estado_revision text DEFAULT 'pendiente', riesgo_score int, riesgo_flags text, verified_reason text, verified_by int, verified_at timestamptz,
      banco_origen text, banco_destino text, alias_destino text, cbu_destino text, titular_destino text, cuenta_bancaria_id int,
      cuenta_bancaria_confianza int, cuenta_bancaria_match_fuente text, cuenta_bancaria_match_detalle text, nro_operacion text, telefono text);
    CREATE TABLE pedido_pagos(id int PRIMARY KEY, empresa_id int, pedido_id int, chofer_id int, metodo_pago text, canal text, descripcion text,
      proveedor text, provider_payment_id text, provider_order_id text, provider_status text, estado text, monto numeric, moneda text,
      checkout_url text, vence_at timestamptz, settlement_at timestamptz, created_at timestamptz, updated_at timestamptz);
    INSERT INTO usuarios VALUES(1,'admin','admin',7,NULL,NULL,true),(2,'super','super',NULL,NULL,NULL,true),(3,'limited','user',7,NULL,NULL,true);
    INSERT INTO puntos_entrega VALUES(1,7,'José Álvarez','+54 (11) 5555-1234','Calle prueba',1),(2,8,'Secreto otro tenant','999','Privada',2);
    INSERT INTO zonas_geograficas VALUES(1,7,'Local'),(2,8,'Privada');
    INSERT INTO choferes VALUES(1,7,'Local',true),(2,8,'Privado',true);
    INSERT INTO pedidos VALUES(123,7,1,1,1,'2026-10-10T03:00:00.000001Z','pendiente',100,'transferencia'),
      (124,7,1,1,1,'2026-10-10T03:00:00.000002Z','pendiente',100,'transferencia'),
      (800,8,2,2,2,'2026-10-10T04:00:00Z','pendiente',100,'transferencia');
    INSERT INTO comprobantes_transferencia(id,empresa_id,pedido_id,fecha,monto,nro_operacion,comprobante_path)
      VALUES(2,7,123,'2026-10-10T03:00:00.000001Z',100,'OP-100%_\\end','receipt'),
            (1,7,124,'2026-10-10T03:00:00.000002Z',100,'ordinary','receipt'),
            (800,8,800,'2026-10-10T04:00:00Z',100,'secret','receipt');
    INSERT INTO pedido_pagos(id,empresa_id,pedido_id,chofer_id,estado,provider_payment_id,provider_order_id,created_at)
      VALUES(2,7,123,1,'pendiente','QR-100%_\\end','order-a','2026-10-10T03:00:00.000001Z'),
            (1,7,124,1,'pagado','ordinary','order-b','2026-10-10T03:00:00.000002Z'),
            (800,8,800,2,'pagado','secret','secret','2026-10-10T04:00:00Z');
  `);
}

async function harness(pool, work) {
  let businessSelects = 0;
  const reads = [];
  const queryFn = async (sql, params = [], options = {}) => {
    // Existing router bootstrap DDL is deliberately not exercised by this read-only feature suite.
    if (/^\s*(ALTER TABLE|CREATE INDEX)/i.test(sql)) return [];
    if (/FROM (comprobantes_transferencia ct|pedido_pagos pp|pedidos p)/.test(sql)) {
      businessSelects++;
      reads.push({options});
    }
    return (await pool.query(sql, params)).rows;
  };
  const auth = createWithAuth({ queryFn, jwtSecret: 'synthetic-test-key' });
  const license = (req,res,next) => req.headers['x-license'] === 'inactive' ? res.status(403).json({error:'license'}) : next();
  const app = express();
  const writes = [];
  app.use(cookieParser());
  app.use((req,res,next)=>{if(req.method!=='GET'){writes.push(req.path);return res.status(405).json({error:'No writes in read-only integration'});}next();});
  app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));
  app.get('/api/choferes',auth,(_req,res)=>res.json([]));
  app.use('/pedidos',express.static(new URL('../pedidos/',import.meta.url).pathname));
  app.use('/api/transferencias', createTransferenciasRouter({ TRANSF_DIR: process.env.TMPDIR || process.cwd(), queryFn, withAuthFn: auth, checkLicenciaFn: license }));
  if (qrModule.createListQrPagosHandler) app.get('/api/admin/qr/pagos', auth, requireCanonicalBackofficeRole, license, qrModule.createListQrPagosHandler({ queryFn }));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const get = async (source, query = {}, options = {}) => {
    const qs = typeof query === 'string' ? query : new URLSearchParams(query).toString();
    const response = await fetch(`http://127.0.0.1:${server.address().port}${source}?${qs}`, {headers:{
      authorization: `Bearer ${jwt.sign({uid:1,role:'admin',empresa_id:999,...options.claims},'synthetic-test-key')}`,
      ...options.headers,
    }});
    return { status: response.status, rows: await response.json() };
  };
  try { await work({get, reads, writes, origin:`http://127.0.0.1:${server.address().port}`, businessSelects:()=>businessSelects}); } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}

const sources = ['/api/transferencias','/api/admin/qr/pagos','/api/transferencias/sin-comprobante'];
test('búsqueda Pagos usa PostgreSQL real y auth canónica sin acceder DB instalada', postgresOptions, async t => {
  await withIsolatedPostgres(async cluster => {
    // initdb --no-locale can default to SQL_ASCII; production text is UTF-8.
    await cluster.query("CREATE DATABASE pagos_utf8 TEMPLATE template0 ENCODING 'UTF8'");
    const pool = new pg.Pool({ ...cluster.options, database: 'pagos_utf8' });
    try {
    await setup(pool);
    await harness(pool, async ({get, reads, writes, origin, businessSelects}) => {
      await t.test('transferencias: búsqueda global antes de LIMIT, sin acentos y tenant del usuario vigente', async () => {
        assert.deepEqual((await get(sources[0],{q:'inexistente',limit:1})).rows, []);
        assert.deepEqual((await get(sources[0],{q:'JOSE ALVAREZ',empresa_id:8,limit:1})).rows.map(x=>x.id), [1]);
      });
      await t.test('tres fuentes: búsquedas literales, teléfono, pedido exacto y referencias sin fuga tenant', async () => {
        await pool.query(`INSERT INTO pedidos SELECT 125,7,1,1,1,fecha,'pendiente',100,'transferencia' FROM pedidos WHERE id=123`);
        for (const source of sources) {
          const response = await get(source,{q:'JOSE ALVAREZ',limit:1,empresa_id:8});
          assert.equal(response.status,200,source);
          assert.equal(response.rows.length,1,source);
          assert.equal(response.rows[0].empresa_id,7);
          assert.ok((await get(source,{q:'+54 11 5555-1234'})).rows.length > 0,source);
          assert.deepEqual((await get(source,{q:"%' OR 1=1 --"})).rows,[],source);
          assert.deepEqual((await get(source,{q:'Secreto'})).rows,[],source);
          assert.deepEqual((await get(source,{q:'#99999999999999999999999999'})).rows,[],source);
        }
        for (const source of sources.slice(0,2)) {
          for (const q of ['%','_','\\','100%_\\end','#123']) {
            assert.deepEqual((await get(source,{q,limit:1})).rows.map(x=>x.id),[2],`${source}: ${q}`);
          }
          assert.deepEqual((await get(source,{q:'#12'})).rows,[]);
        }
        assert.deepEqual((await get(sources[1],{q:'order-a'})).rows.map(x=>x.id),[2]);
        assert.deepEqual((await get(sources[2],{q:'#125'})).rows.map(x=>x.id),[125]);
        await pool.query(`INSERT INTO comprobantes_transferencia(id,empresa_id,fecha,telefono) VALUES(3,7,'2026-10-10T03:00:00Z','+54 (9) 222-444')`);
        assert.deepEqual((await get(sources[0],{q:'549222444'})).rows.map(x=>x.id),[3]);
      });
      await t.test('tres fuentes: rango local inclusivo independiente timezone servidor y fecha legacy', async () => {
        const instants = ['2026-10-10T02:59:59.999999Z','2026-10-10T03:00:00Z','2026-10-11T02:59:59.999999Z','2026-10-11T03:00:00Z'];
        for (let i=0;i<instants.length;i++) {
          const id=200+i;
          await pool.query(`INSERT INTO pedidos(id,empresa_id,punto_entrega_id,fecha,metodo_pago) VALUES($1,7,1,$2,'transferencia');`,[id,instants[i]]);
          await pool.query(`INSERT INTO comprobantes_transferencia(id,empresa_id,pedido_id,fecha) VALUES($1,7,$1,$2)`,[id,instants[i]]);
          await pool.query(`INSERT INTO pedido_pagos(id,empresa_id,pedido_id,created_at) VALUES($1,7,$1,$2)`,[id,instants[i]]);
        }
        for (const source of sources) {
          const ids = response => response.rows.map(x=>x.id).filter(x=>x>=200 && x<=203);
          assert.deepEqual(ids(await get(source,{desde:'2026-10-10',hasta:'2026-10-10'})),[202,201],source);
          assert.deepEqual(ids(await get(source,{fecha:'2026-10-10'})),[202,201],source);
          assert.deepEqual(ids(await get(source,{desde:'2026-10-11'})),[203],source);
          assert.deepEqual(ids(await get(source,{hasta:'2026-10-09'})),[200],source);
        }
        await pool.query("SET TIME ZONE 'Pacific/Honolulu'");
        for(const source of sources) {
          const response=await get(source,{desde:'2026-10-10',hasta:'2026-10-10'});
          assert.deepEqual(response.rows.map(x=>x.id).filter(x=>x>=200&&x<=203),[202,201],source);
        }
        await pool.query("SET TIME ZONE 'UTC'");
      });
      await t.test('validación 400 antes de cualquier SELECT de negocio', async () => {
        const invalid = [ 'q[]=x','q[a]=x',new URLSearchParams({q:'x'.repeat(121)}).toString(),
          'desde=2026-02-30','hasta=2026-13-01','desde=2026-1-01','desde=10%2F10%2F2026','desde[]=2026-10-10',
          'hasta[a]=2026-10-10','desde=2026-10-11&hasta=2026-10-10','fecha=2026-02-29'];
        for(const source of sources) for(const query of invalid) {
          const before = businessSelects();
          assert.equal((await get(source,query)).status,400,`${source}?${query}`);
          assert.equal(businessSelects(),before);
        }
      });
      await t.test('cursor compuesto recorre fechas fuera de orden ID, empates y microsegundos sin pérdidas', async () => {
        for(const id of [210,211]) {
          await pool.query(`INSERT INTO pedidos(id,empresa_id,punto_entrega_id,fecha,metodo_pago) VALUES($1,7,1,'2026-10-10T03:00:00.000001Z','transferencia')`,[id]);
          await pool.query(`INSERT INTO comprobantes_transferencia(id,empresa_id,pedido_id,fecha) SELECT id,empresa_id,id,fecha FROM pedidos WHERE id=$1`,[id]);
          await pool.query(`INSERT INTO pedido_pagos(id,empresa_id,pedido_id,created_at) SELECT id,empresa_id,id,fecha FROM pedidos WHERE id=$1`,[id]);
        }
        for(const source of sources) {
          const all=(await get(source)).rows;
          const collected=[];
          let cursor={};
          for(let page=0;page<30;page++) {
            const response=await get(source,{limit:1,...cursor});
            assert.equal(response.status,200);
            if(!response.rows.length)break;
            const row=response.rows[0];
            assert.match(row.cursor_fecha,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
            collected.push(row.id);
            cursor={before_id:row.id,before_fecha:row.cursor_fecha};
          }
          assert.deepEqual(collected,all.map(x=>x.id),source);
          const legacy=await get(source,{before_id:202});
          assert.ok(legacy.rows.every(row=>row.id<202));
        }
      });
      await t.test('cursor nullable recorre 200 nulos y mezcla fechas e IDs desordenados sin pérdidas', async t => {
        await pool.query(`
          INSERT INTO puntos_entrega(id,empresa_id,cliente) VALUES(30000,7,'Cursor nullable aislado');
          INSERT INTO pedidos(id,empresa_id,punto_entrega_id,fecha,metodo_pago)
            SELECT id,7,30000,NULL,'transferencia' FROM generate_series(30000,30204) id;
          INSERT INTO pedidos(id,empresa_id,punto_entrega_id,fecha,metodo_pago) VALUES
            (29000,7,30000,'2026-10-10T03:00:00.000002Z','transferencia'),
            (31000,7,30000,'2026-10-10T03:00:00.000001Z','transferencia');
          INSERT INTO comprobantes_transferencia(id,empresa_id,pedido_id,fecha)
            SELECT id,7,id,fecha FROM pedidos WHERE punto_entrega_id=30000;
          INSERT INTO pedido_pagos(id,empresa_id,pedido_id,created_at)
            SELECT id,7,id,fecha FROM pedidos WHERE punto_entrega_id=30000;
        `);
        try {
          for(const source of sources) await t.test(source, async () => {
            const nullIds=Array.from({length:205},(_,i)=>30204-i);
            for(const nullableOnly of [true,false]) {
              const query={q:'Cursor nullable aislado',limit:200};
              if(nullableOnly) {query.before_id='40000';query.before_fecha='-infinity';}
              const collected=[];
              for(let page=0;page<4;page++) {
                const response=await get(source,query);
                assert.equal(response.status,200,source);
                if(!response.rows.length)break;
                for(const row of response.rows) {
                  if(nullIds.includes(row.id)) assert.equal(row.cursor_fecha,'-infinity');
                  else assert.match(row.cursor_fecha,/\.\d{6}Z$/);
                }
                collected.push(...response.rows.map(row=>row.id));
                const last=response.rows.at(-1);
                query.before_id=String(last.id);query.before_fecha=last.cursor_fecha;
              }
              assert.deepEqual(collected,nullableOnly?nullIds:[29000,31000,...nullIds],source);
            }
            const legacy=await get(source,{q:'Cursor nullable aislado',before_id:30002});
            assert.deepEqual(legacy.rows.map(row=>row.id),[29000,30001,30000]);
          });
        } finally {
          await pool.query(`DELETE FROM pedido_pagos WHERE pedido_id IN (SELECT id FROM pedidos WHERE punto_entrega_id=30000);
            DELETE FROM comprobantes_transferencia WHERE pedido_id IN (SELECT id FROM pedidos WHERE punto_entrega_id=30000);
            DELETE FROM pedidos WHERE punto_entrega_id=30000;DELETE FROM puntos_entrega WHERE id=30000;`);
        }
      });
      await t.test('cursor rechaza escalares ambiguos, fechas inválidas e IDs inseguros antes de negocio', async () => {
        const invalid=['before_fecha=2026-10-10T03:00:00Z','before_id=0','before_id=-1','before_id=1.5','before_id=1e2',
          'before_id=9007199254740993','before_id[]=2','before_id=2&before_fecha[]=2026-10-10T03:00:00Z',
          'before_id=2&before_fecha=2026-02-30T03:00:00Z','before_id=2&before_fecha=2026-10-10',
          'before_id=2&before_fecha=2026-10-10T24:00:00Z','before_id=2&before_fecha=infinity',
          'before_id=2&before_fecha=Infinity','before_id=2&before_fecha=-Infinity','before_id=2&before_fecha=%2Binfinity',
          'before_id=2&before_fecha=NaN','before_id=2&before_fecha=null','before_fecha=-infinity','before_id=2&before_fecha[]=-infinity',
          'before_id=2&before_fecha=2026-10-10T03:00:00.0000001Z'];
        for(const source of sources) for(const query of invalid){
          const before=businessSelects();
          assert.equal((await get(source,query)).status,400,`${source}?${query}`);
          assert.equal(businessSelects(),before);
        }
      });
      await t.test('efectivo se excluye antes de paginar sin ocultar transferencias coincidentes', async t => {
        await pool.query(`
          INSERT INTO puntos_entrega(id,empresa_id,cliente) VALUES(40000,7,'Efectivo aislado');
          INSERT INTO pedidos(id,empresa_id,punto_entrega_id,metodo_pago) VALUES
            (40000,7,40000,'EfEcTiVo'),(40001,7,40000,'transferencia'),(40002,7,40000,NULL);
          INSERT INTO comprobantes_transferencia(id,empresa_id,pedido_id,fecha,metodo_pago)
            SELECT id,7,40000,'2026-10-12T15:00:00Z',CASE WHEN id%2=0 THEN 'pago EFECTIVO' ELSE NULL END
            FROM generate_series(40000,40199) id;
          INSERT INTO comprobantes_transferencia(id,empresa_id,pedido_id,fecha,metodo_pago,nro_operacion) VALUES
            (40200,7,40000,'2026-10-07T15:00:00Z','transferencia',NULL),
            (40201,7,40001,'2026-10-07T15:00:00Z',NULL,NULL),
            (40202,7,40002,'2026-10-07T15:00:00Z',NULL,NULL),
            (40203,7,NULL,'2026-10-07T15:00:00Z',NULL,'Efectivo aislado');
        `);
        try {
          await t.test('SQL real conserva COALESCE y entrega los matches tras 200 efectivos', async () => {
            const response=await get(sources[0],{q:'Efectivo aislado',limit:200});
            assert.equal(response.status,200);
            assert.deepEqual(response.rows.map(row=>row.id),[40203,40202,40201,40200]);
            assert.deepEqual(response.rows.map(row=>row.metodo_pago),Array(4).fill('transferencia'));
          });
          await t.test('HTML real y cookie encuentran resultados sin cargar otra página de efectivo', async () => {
            const browser=await puppeteer.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
            try {
              const page=await browser.newPage(),errors=[];
              page.on('pageerror',error=>errors.push(error.message));
              await page.setCookie({name:'token',value:jwt.sign({uid:1,role:'admin'},'synthetic-test-key'),url:origin,httpOnly:true});
              await page.setRequestInterception(true);
              page.on('request',request=>request.url().startsWith(origin)?request.continue():request.abort());
              await page.goto(origin+'/pedidos/pagos.html',{waitUntil:'networkidle0'});
              await page.select('#fTipo','transferencia');
              await page.$eval('#fBuscar',input=>input.value='Efectivo aislado');
              await page.evaluate(()=>loadPagos());
              assert.deepEqual(await page.evaluate(()=>currentRows.map(row=>row.raw_id)),[40203,40202,40201,40200]);
              assert.equal(await page.$eval('#btnVerMas',node=>getComputedStyle(node).display),'none');
              assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
            } finally {await browser.close();}
          });
        } finally {
          await pool.query(`DELETE FROM comprobantes_transferencia WHERE id BETWEEN 40000 AND 40203;
            DELETE FROM pedidos WHERE id BETWEEN 40000 AND 40002;DELETE FROM puntos_entrega WHERE id=40000;`);
        }
      });
      await t.test('huérfanos, estados legacy y joins inválidos no exponen datos de otra empresa', async () => {
        assert.deepEqual((await get(sources[0],{estado:'orphan'})).rows.map(x=>x.id),[3]);
        await pool.query(`INSERT INTO usuarios VALUES(800,'Privado','admin',8,NULL,NULL,true);
          INSERT INTO empresa_cuentas_bancarias(id,empresa_id,banco,alias,cbu,titular) VALUES(800,8,'Privado','Privado','Privado','Privado');
          UPDATE pedidos SET punto_entrega_id=2,zona_id=2,chofer_id=2 WHERE id=125;
          UPDATE comprobantes_transferencia SET verified_by=800,cuenta_bancaria_id=800,zona_id=2 WHERE id=2;
          UPDATE pedido_pagos SET pedido_id=125,chofer_id=2 WHERE id=2;`);
        const receipt=(await get(sources[0],{q:'#123'})).rows[0];
        assert.equal(receipt.verified_by_username,null);
        assert.equal(receipt.cuenta_alias,null);
        assert.equal(receipt.zona_nombre,null);
        await pool.query('UPDATE comprobantes_transferencia SET verified_by=2 WHERE id=1');
        assert.equal((await get(sources[0],{q:'#124'})).rows[0].verified_by_username,null);
        for(const source of sources.slice(1)) {
          const row=(await get(source,{q:'#125'})).rows[0];
          for(const field of ['cliente','telefono','zona_nombre','chofer_nombre'])assert.equal(row[field],null,`${source}.${field}`);
          assert.deepEqual((await get(source,{q:'Secreto'})).rows,[]);
        }
        await pool.query(`UPDATE comprobantes_transferencia SET estado_revision='en_revision' WHERE id=2;
          UPDATE comprobantes_transferencia SET validado=1 WHERE id=1;`);
        assert.deepEqual((await get(sources[0],{estado_revision:'en_revision'})).rows.map(x=>x.id),[2]);
        assert.deepEqual((await get(sources[0],{estado:'verificado'})).rows.map(x=>x.id),[1]);
        assert.ok(!(await get(sources[0],{estado:'pendiente'})).rows.some(x=>x.id===1));
        assert.deepEqual((await get(sources[1],{estado:'verificado'})).rows.map(x=>x.id),[1]);
      });
      await t.test('auth/licencia vigentes, super acotable y parámetros escalares sin coerción', async () => {
        for(const source of sources) {
          assert.equal((await get(source,{}, {headers:{authorization:''}})).status,401);
          assert.equal((await get(source,{}, {claims:{uid:3,role:'super'}})).status,403);
          assert.equal((await get(source,{}, {claims:{type:'client'}})).status,401);
          assert.equal((await get(source,{}, {headers:{'x-license':'inactive'}})).status,403);
          const superRows=(await get(source,{empresa_id:8},{claims:{uid:2,role:'super'}})).rows;
          assert.ok(superRows.every(row=>row.empresa_id===8));
          const all=(await get(source,{}, {claims:{uid:2,role:'super'}})).rows;
          assert.ok(all.length>superRows.length);
          for(const query of ['estado[]=pendiente','chofer_id[]=1','limit[]=1','empresa_id[]=7','chofer_id=9007199254740993','limit=1.5']) {
            const before=businessSelects();
            assert.equal((await get(source,query)).status,400,`${source}?${query}`);
            assert.equal(businessSelects(),before);
          }
        }
      });
      await t.test('HTML real + cookie canónica + tres rutas + PostgreSQL encuentra pagos fuera de primera página', async () => {
        await pool.query(`
          INSERT INTO puntos_entrega(id,empresa_id,cliente,telefono,direccion) VALUES(901,7,'María Integrada','+54 (9) 555-0123','Dirección de prueba');
          INSERT INTO pedidos(id,empresa_id,punto_entrega_id,fecha,estado,monto,metodo_pago)
            VALUES(901,7,901,'2026-10-07T15:00:00Z','pendiente',100,'transferencia'),(902,7,901,'2026-10-07T15:00:00Z','pendiente',200,'transferencia');
          INSERT INTO comprobantes_transferencia(id,empresa_id,pedido_id,fecha,monto,metodo_pago,comprobante_path,nro_operacion,estado_revision)
            VALUES(902,7,902,'2026-10-07T15:00:00Z',200,'transferencia','synthetic-receipt','BUSQUEDA-UNICA','en_revision');
          INSERT INTO pedido_pagos(id,empresa_id,pedido_id,created_at,estado,monto,proveedor)
            VALUES(903,7,902,'2026-10-07T15:00:00Z','pagado',200,'mercado_pago');
          INSERT INTO comprobantes_transferencia(id,empresa_id,pedido_id,fecha,monto,metodo_pago)
            SELECT id,7,123,'2026-10-12T15:00:00Z',1,'transferencia' FROM generate_series(10000,10200) id;
        `);
        const browser=await puppeteer.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
        try {
          const page=await browser.newPage(),errors=[];
          page.on('pageerror',error=>errors.push(error.message));
          await page.setViewport({width:1280,height:900});
          await page.setCookie({name:'token',value:jwt.sign({uid:1,role:'super'},'synthetic-test-key'),url:origin,httpOnly:true});
          await page.setRequestInterception(true);
          page.on('request',request=>request.url().startsWith(origin)?request.continue():request.abort());
          await page.goto(origin+'/pedidos/pagos.html',{waitUntil:'networkidle0'});
          assert.equal(await page.evaluate(()=>currentUser.role),'admin','El rol vigente reemplaza al claim antiguo');
          assert.equal(await page.evaluate(()=>currentRows.some(row=>row.source==='transferencia'&&row.raw_id===902)),false,'El comprobante objetivo no estaba entre los 200 primeros');
          await page.type('#fBuscar','maria integrada');
          await page.$eval('#fDesde',input=>input.value='2026-10-07');
          await page.$eval('#fHasta',input=>input.value='2026-10-07');
          await page.focus('#fBuscar');await page.keyboard.press('Enter');
          await page.waitForFunction(()=>!listBusy&&currentRows.length===3);
          assert.deepEqual(await page.evaluate(()=>currentRows.map(row=>row.row_id).sort()),['miss-901','qr-903','tr-902']);
          assert.equal(await page.evaluate(()=>currentRows.every(row=>row.empresa_id===7)),true);
          assert.equal(await page.$eval('#kpiTotal',node=>node.textContent),'$ 500');
          await page.select('#fTipo','transferencia');await page.select('#fEstado','en_revision');
          await page.evaluate(()=>loadPagos());
          assert.deepEqual(await page.evaluate(()=>currentRows.map(row=>row.row_id)),['tr-902']);
          await page.$eval('#fBuscar',input=>input.value='BUSQUEDA-UNICA');await page.evaluate(()=>loadPagos());
          assert.deepEqual(await page.evaluate(()=>currentRows.map(row=>row.row_id)),['tr-902']);
          await page.$eval('#fBuscar',input=>input.value='maria integrada');
          await page.select('#fTipo','qr');await page.select('#fEstado','verificado');await page.evaluate(()=>loadPagos());
          assert.deepEqual(await page.evaluate(()=>currentRows.map(row=>row.row_id)),['qr-903']);
          await page.select('#fTipo','sin_comprobante');await page.select('#fEstado','pendiente');await page.evaluate(()=>loadPagos());
          assert.deepEqual(await page.evaluate(()=>currentRows.map(row=>row.row_id)),['miss-901']);
          await page.select('#fTipo','');await page.select('#fEstado','');await page.evaluate(()=>loadPagos());
          const output=process.env.TMPDIR+'/pagos-search-integration';fs.mkdirSync(output,{recursive:true});
          await page.screenshot({path:output+'/desktop.png',fullPage:true});
          await page.setViewport({width:390,height:844});
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
          await page.screenshot({path:output+'/mobile.png',fullPage:true});
          assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
        }finally{await browser.close();}
      });
      await t.test('las consultas de búsqueda suprimen PII en el logger SQL compartido', async () => {
        assert.ok(reads.length>0);
        assert.ok(reads.every(read=>read.options.sensitive===true));
      });
    });
    } finally { await pool.end(); }
  });
});
