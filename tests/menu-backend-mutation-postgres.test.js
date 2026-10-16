import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUpdatePedidoHandler } from '../src/routes/pedidos.js';
import { createUpdatePedidoItemsHandler } from '../src/routes/pedidosItems.js';
import { withTransaction } from '../src/db.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';
const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}});
test('canonical edit and reopening reject scheduled items lacking a committed date and roll back',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try {await withIsolatedPostgres(async pool=>{
  await pool.query(`CREATE TABLE usuarios(id int,role text,empresa_id int,activo boolean);
   INSERT INTO usuarios VALUES(5,'admin',7,true);
   CREATE TABLE empresas(id int PRIMARY KEY,menu_config jsonb DEFAULT '{}'); INSERT INTO empresas(id,menu_config) VALUES(7,'{"enabled":true}');
   CREATE TABLE productos(id int PRIMARY KEY,empresa_id int,nombre text,activo boolean,deleted_at timestamptz,disponibilidad_config jsonb);
   INSERT INTO productos VALUES(55,7,'Menú',true,NULL,'{"enabled":true}');
   CREATE TABLE public.menu_write_barrier(id int PRIMARY KEY,revision bigint DEFAULT 0); INSERT INTO public.menu_write_barrier VALUES(1,0);
   CREATE TABLE pedidos(id int PRIMARY KEY,empresa_id int,punto_entrega_id int,chofer_id int,estado text,monto numeric,fecha_entrega_programada date,menu_channel text);
   INSERT INTO pedidos VALUES(42,7,10,NULL,'pendiente',10,NULL,NULL);
   CREATE TABLE items_pedido(id serial,pedido_id int,producto text,producto_id int,cantidad numeric,precio_unitario numeric);
   INSERT INTO items_pedido(pedido_id,producto,producto_id,cantidad,precio_unitario) VALUES(42,'Menú',55,1,10);
   CREATE TABLE public.menu_cupos_diarios(empresa_id int,producto_id int,fecha date,reservado numeric);`);
  const tx=work=>withTransaction(work,{pool,maxRetries:0});
  const user={uid:5,role:'admin',empresa_id:7};
  const itemsHandler=createUpdatePedidoItemsHandler({withTransaction:tx});
  const edited=response(); await itemsHandler({params:{id:'42'},user,body:{items:[{producto_id:55,cantidad:2,precio_unitario:10}]}},edited);
  assert.equal(edited.statusCode,400,JSON.stringify(edited.body));
  assert.equal((await pool.query('SELECT cantidad FROM items_pedido')).rows[0].cantidad,'1');
  await pool.query("UPDATE pedidos SET estado='cancelado'");
  let notices=0;
  const handler=createUpdatePedidoHandler({withTransactionFn:tx,notifyEstadoFn:async()=>{notices++;},logErrorFn:()=>{}});
  const reopened=response();await handler({params:{id:'42'},user,body:{estado:'pendiente'}},reopened);
  assert.equal(reopened.statusCode,400,JSON.stringify(reopened.body));
  assert.equal((await pool.query('SELECT estado FROM pedidos')).rows[0].estado,'cancelado');
  assert.equal(notices,0);
  const date=new Date().toISOString().slice(0,10);
  await pool.query("UPDATE pedidos SET estado='pendiente',fecha_entrega_programada=$1",[date]);
  await pool.query("UPDATE empresas SET menu_config=menu_config || '{\"timezone\":\"UTC\"}'::jsonb");
  await pool.query('UPDATE productos SET disponibilidad_config=$1::jsonb',[JSON.stringify({enabled:true,weekdays:[0,1,2,3,4,5,6],exceptions:[{date,paused:true}]})]);
  await pool.query('UPDATE items_pedido SET cantidad=3');
  await pool.query('INSERT INTO public.menu_cupos_diarios VALUES(7,55,$1,3)',[date]);
  const reduction=response();await itemsHandler({params:{id:'42'},user,body:{items:[{producto_id:55,cantidad:2,precio_unitario:10}]}},reduction);
  assert.equal(reduction.statusCode,200,JSON.stringify(reduction.body));
  const increase=response();await itemsHandler({params:{id:'42'},user,body:{items:[{producto_id:55,cantidad:4,precio_unitario:10}]}},increase);
  assert.equal(increase.statusCode,409);
  assert.equal((await pool.query('SELECT cantidad FROM items_pedido')).rows[0].cantidad,'2');
 });} finally {delete process.env.SCHEDULED_MENUS_ENABLED;}
});


test('landing reopening and increases retain the stored channel and shared quota',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{await withIsolatedPostgres(async pool=>{
  await pool.query(`CREATE TABLE usuarios(id int,role text,empresa_id int,activo boolean); INSERT INTO usuarios VALUES(5,'admin',7,true);
   CREATE TABLE empresas(id int PRIMARY KEY); INSERT INTO empresas VALUES(7);
   CREATE TABLE productos(id int PRIMARY KEY,empresa_id int,nombre text,activo boolean,deleted_at timestamptz); INSERT INTO productos VALUES(55,7,'Menu',true,NULL);
   CREATE TABLE pedidos(id int PRIMARY KEY,empresa_id int,punto_entrega_id int,chofer_id int,estado text,monto numeric);
   CREATE TABLE items_pedido(id serial PRIMARY KEY,pedido_id int,producto text,producto_id int,cantidad numeric,precio_unitario numeric);`);
  await pool.query(readFileSync(new URL('../src/menu/schema.sql',import.meta.url),'utf8'));
  const today=new Date(),date=today.toISOString().slice(0,10),day=today.getUTCDay();
  const config={enabled:true,mode:'weekly',weekdays:[(day+1)%7],daily_capacity:3,channels:{landing:{weekdays:[day]}}};
  await pool.query(`UPDATE empresas SET menu_config='{"enabled":true,"timezone":"UTC","advance_enabled":true,"max_advance_days":7}'`);
  await pool.query('UPDATE productos SET disponibilidad_config=$1',[JSON.stringify(config)]);
  await pool.query(`INSERT INTO pedidos(id,empresa_id,punto_entrega_id,estado,monto,fecha_entrega_programada,menu_channel,menu_intent_hash)
   VALUES(42,7,10,'cancelado',10,$1,'landing','original'),(43,7,10,'cancelado',10,$1,NULL,NULL)`,[date]);
  await pool.query("INSERT INTO items_pedido(pedido_id,producto,producto_id,cantidad,precio_unitario) VALUES(42,'Menu',55,1,10),(43,'Menu',55,1,10)");
  const tx=work=>withTransaction(work,{pool,maxRetries:0});const user={uid:5,role:'admin',empresa_id:7};
  const states=createUpdatePedidoHandler({withTransactionFn:tx,notifyEstadoFn:async()=>{},logErrorFn:()=>{}});
  const items=createUpdatePedidoItemsHandler({withTransaction:tx});
  const reopen=response();await states({params:{id:'42'},user,body:{estado:'pendiente',menu_channel:'catalog'}},reopen);
  assert.equal(reopen.statusCode,200,JSON.stringify(reopen.body));
  assert.equal((await pool.query('SELECT menu_channel FROM pedidos WHERE id=42')).rows[0].menu_channel,'landing');
  const legacy=response();await states({params:{id:'43'},user,body:{estado:'pendiente'}},legacy);
  assert.equal(legacy.statusCode,409,JSON.stringify(legacy.body));
  const change=async quantity=>{const res=response();await items({params:{id:'42'},user,body:{menu_channel:'catalog',items:[{producto_id:55,cantidad:quantity,precio_unitario:10}]}},res);return res;};
  assert.equal((await change(2)).statusCode,200);
  assert.equal((await pool.query('SELECT reservado FROM public.menu_cupos_diarios')).rows[0].reservado,'2');
  assert.equal((await change(4)).statusCode,409);
  assert.equal((await pool.query('SELECT cantidad FROM items_pedido WHERE pedido_id=42')).rows[0].cantidad,'2');
  for(const override of [{weekdays:[day],open_time:'23:58'},{weekdays:[day],close_time:'00:01'}]){
   await pool.query('UPDATE productos SET disponibilidad_config=$1',[JSON.stringify(config)]);
   const reset=response();await states({params:{id:'42'},user,body:{estado:'pendiente'}},reset);assert.equal(reset.statusCode,200);
   await pool.query('UPDATE productos SET disponibilidad_config=$1',[JSON.stringify({...config,channels:{landing:override}})]);
   assert.equal((await change(3)).statusCode,409);
   await pool.query("UPDATE pedidos SET estado='cancelado' WHERE id=42");
   const closed=response();await states({params:{id:'42'},user,body:{estado:'pendiente'}},closed);assert.equal(closed.statusCode,409);
  }
  assert.equal((await pool.query('SELECT reservado FROM public.menu_cupos_diarios')).rows[0].reservado,'0');
  const future=new Date(`${date}T12:00:00Z`);future.setUTCDate(future.getUTCDate()+1);
  await pool.query('UPDATE productos SET disponibilidad_config=$1',[JSON.stringify({...config,channels:{landing:{weekdays:[future.getUTCDay()],open_days_before:0}}})]);
  await pool.query('UPDATE pedidos SET fecha_entrega_programada=$1 WHERE id=42',[future.toISOString().slice(0,10)]);
  const notYet=response();await states({params:{id:'42'},user,body:{estado:'pendiente'}},notYet);assert.equal(notYet.statusCode,409);
  assert.equal((await pool.query('SELECT estado FROM pedidos WHERE id=42')).rows[0].estado,'cancelado');
 });}finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});
