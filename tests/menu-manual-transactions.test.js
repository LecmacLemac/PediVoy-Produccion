import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createWhatsAppPaymentChoiceProcessor} from '../src/whatsappCloud/paymentChoiceProcessor.js';
import {runTransactionOnLockedClient} from '../src/wpp/companyConfigLock.js';
import {createRepartidorApiRouter} from '../src/routes/repartidorApi.js';
const barrier='SELECT id FROM public.menu_write_barrier WHERE id=1 FOR UPDATE';
function flag(t){const old=process.env.SCHEDULED_MENUS_ENABLED;process.env.SCHEDULED_MENUS_ENABLED='1';t.after(()=>old===undefined?delete process.env.SCHEDULED_MENUS_ENABLED:process.env.SCHEDULED_MENUS_ENABLED=old);}
function clientFixture(){const calls=[];return {calls,client:{query:async sql=>{calls.push(typeof sql==='string'?sql:sql.text);return {rows:[]};},release:()=>calls.push('RELEASE')}};}

test('selección de pago WhatsApp manual toma barrera antes de outbox/pedido, sin alterar la resolución del contexto',async t=>{
 flag(t);const {client,calls}=clientFixture();const process=createWhatsAppPaymentChoiceProcessor({pool:{connect:async()=>client},notifyTransferInTransaction:async()=>assert.fail('No debe notificar sin contexto')});
 const result=await process({empresaId:7,messageId:'wamid.payment.inbound-1',contextMessageId:'wamid.order.confirmation-1',buttonPayload:'pedivoy_payment_cash_v1',assertLease:async()=>{}});
 assert.equal(result.outcome,'context_not_found');assert.equal(calls[0],'BEGIN');assert.equal(calls[1],barrier);assert.match(calls[2],/FROM wpp_outbox/);
});

test('guardado manual configuración WhatsApp entra a barrera antes de ejecutar el callback con locks',async t=>{
 flag(t);const {client,calls}=clientFixture();await runTransactionOnLockedClient(client,async()=>{calls.push('WORK');return 42;});assert.deepEqual(calls,['BEGIN',barrier,'WORK','COMMIT']);
});

test('entrega repartidor manual toma barrera antes del lock de pedido y conserva 404/rollback',async t=>{
 flag(t);const {client,calls}=clientFixture();const app=express();app.use(express.json());
 app.use('/api/repartidor',createRepartidorApiRouter({query:async()=>[],pool:{connect:async()=>client},withAuth:(req,_res,next)=>{req.user={uid:9,role:'repartidor',empresa_id:7,chofer_id:3};next();},getEmpresaIdFromToken:()=>7,withTransaction:work=>work(async()=>[])}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/repartidor/pedidos/1/entregar`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,404);assert.equal(calls[0],'BEGIN');assert.equal(calls[1],barrier);assert.match(calls[2],/FROM pedidos p/);assert.ok(calls.includes('ROLLBACK'));
});
