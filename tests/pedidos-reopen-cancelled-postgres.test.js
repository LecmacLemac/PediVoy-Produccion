import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createUpdatePedidoHandler } from '../src/routes/pedidos.js';
import { withTransaction } from '../src/db.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';
import { buildPedidoSavePlan,applyFinalizedOrderControls } from '../pedidos/dashboard-order-edit.js';

if(process.env.TMPDIR){fs.mkdirSync(process.env.TMPDIR,{recursive:true});process.chdir(process.env.TMPDIR);}

test('admin and super reopen only cancelled orders as pending with tenant scope and protected items',postgresOptions,async()=>{
 await withIsolatedPostgres(async pool=>{
  await pool.query(`CREATE TABLE usuarios(id integer PRIMARY KEY,role text,empresa_id integer,activo boolean);
   CREATE TABLE pedidos(id integer PRIMARY KEY,empresa_id integer,punto_entrega_id integer,monto numeric,estado text,metodo_pago text);
   CREATE TABLE items_pedido(id integer PRIMARY KEY,pedido_id integer,producto text,cantidad numeric,precio_unitario numeric);
   INSERT INTO usuarios VALUES(1,'admin',7,true),(2,'super',NULL,true),(3,'user',7,true);
   INSERT INTO pedidos VALUES(42,7,12,3000,'cancelado','efectivo'),(43,8,13,4000,'cancelado','transferencia'),(44,7,12,3000,'entregado','efectivo');
   INSERT INTO items_pedido VALUES(1,42,'Producto de prueba',2,1500);`);
  const effects=[];
  const handler=createUpdatePedidoHandler({withTransactionFn:work=>withTransaction(work,{pool,maxRetries:0}),notifyEstadoFn:async x=>effects.push(x.estado),notifyEnRutaFn:async()=>effects.push('en_ruta'),awardPointsFn:async()=>effects.push('points'),generateComisionesFn:async()=>effects.push('commissions'),postEntregaFn:async()=>effects.push('marketing')});
  const call=async(uid,role,id,body)=>{const res={statusCode:200,status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;}};await handler({user:{uid,role,empresa_id:role==='super'?null:7},params:{id:String(id)},body},res);return res;};
  assert.equal((await call(1,'admin',42,{estado:'pendiente'})).statusCode,200);
  const saved=(await pool.query('SELECT estado,empresa_id,monto,metodo_pago FROM pedidos WHERE id=42')).rows[0];
  assert.deepEqual(saved,{estado:'pendiente',empresa_id:7,monto:'3000',metodo_pago:'efectivo'});
  assert.equal((await pool.query('SELECT cantidad FROM items_pedido WHERE pedido_id=42')).rows[0].cantidad,'2');
  assert.equal((await call(1,'admin',43,{estado:'pendiente'})).statusCode,404);
  assert.equal((await call(3,'admin',42,{estado:'pendiente'})).statusCode,403);
  assert.equal((await call(2,'super',43,{estado:'pendiente'})).statusCode,200);
  assert.equal((await call(1,'admin',44,{estado:'pendiente'})).statusCode,409);
  assert.equal((await call(2,'super',44,{estado:'pendiente'})).statusCode,409);
  assert.equal((await call(1,'admin',42,{estado:'pendiente'})).statusCode,200); // idempotent: no duplicate side effects
  await pool.query("UPDATE pedidos SET estado='cancelado' WHERE id=42");
  for(const body of [{estado:'entregado'},{estado:'en_ruta'},{estado:'Pendiente'},{estado:'pendiente',items:[]},{estado:'pendiente',empresa_id:8}])assert.equal((await call(1,'admin',42,body)).statusCode,409);
  assert.equal((await pool.query('SELECT estado FROM pedidos WHERE id=42')).rows[0].estado,'cancelado');
  await pool.query('UPDATE usuarios SET activo=false WHERE id=1');
  assert.equal((await call(1,'admin',42,{estado:'pendiente'})).statusCode,403);
  assert.deepEqual(effects,['pendiente','pendiente']);
 });
});

test('cancelled edit enables only pending and cancelled while keeping items locked',()=>{
 const estado={disabled:true,options:['pendiente','en_ruta','entregado','cancelado'].map(value=>({value,disabled:false}))};const notice={};
 const items=[{}];const empresa={};const addItem={};
 applyFinalizedOrderControls({finalized:true,allowReopen:true,estado,empresa,addItem,itemsBody:{querySelectorAll:()=>items},notice});
 assert.equal(estado.disabled,false);assert.equal(empresa.disabled,true);assert.equal(addItem.disabled,true);assert.equal(items[0].disabled,true);
 assert.deepEqual(estado.options.filter(x=>!x.disabled).map(x=>x.value),['pendiente','cancelado']);
 const plan=buildPedidoSavePlan({finalized:true,allowReopen:true,estado:'pendiente',metodoPago:'efectivo',choferId:null,zonaId:null,items:[{producto:'Protected'}]});
 assert.equal(plan.pedidoBody.estado,'pendiente');assert.equal(Object.hasOwn(plan.pedidoBody,'items'),false);
});
