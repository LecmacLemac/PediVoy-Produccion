import test from 'node:test';
import assert from 'node:assert/strict';
import { menuIntentHash, validateMenuOrder, filterMenuCatalog, rejectUndatedScheduledItems, menuBusinessFailure } from '../src/services/menuOrderAvailability.js';

test('default off performs no new-schema query and preserves catalog arrays', async () => {
  const old = process.env.SCHEDULED_MENUS_ENABLED;
  delete process.env.SCHEDULED_MENUS_ENABLED;
  try {
    const query = async () => { throw new Error('unexpected SQL'); };
    const rows = [{id:1,nombre:'Legacy'}];
    assert.equal(await filterMenuCatalog(query,{empresaId:1,products:rows}), rows);
    assert.equal(await validateMenuOrder(query,{empresaId:1,items:[]}), null);
    await rejectUndatedScheduledItems(query,{empresaId:1,items:[]});
  } finally { if(old === undefined) delete process.env.SCHEDULED_MENUS_ENABLED; else process.env.SCHEDULED_MENUS_ENABLED=old; }
});

test('explicit requested date is rejected without schema access while application feature is off', async()=>{
 delete process.env.SCHEDULED_MENUS_ENABLED;
 const query=async()=>{throw new Error('unexpected SQL');};
 await assert.rejects(validateMenuOrder(query,{empresaId:1,items:[],deliveryDate:'2026-10-15'}),{code:'MENU_DISABLED'});
 await assert.rejects(filterMenuCatalog(query,{empresaId:1,products:[],deliveryDate:'2026-10-15'}),{code:'MENU_DISABLED'});
});

test('intent hash ignores line ordering and merges quantities but binds date and channel', () => {
 const base={deliveryDate:'2026-10-15',channel:'catalog',items:[{producto_id:7,cantidad:1},{producto_id:7,cantidad:2}]};
 const hash=menuIntentHash(base);
 assert.equal(hash,menuIntentHash({...base,items:[{producto_id:7,cantidad:3}]}));
 assert.notEqual(hash,menuIntentHash({...base,deliveryDate:'2026-10-16'}));
 assert.notEqual(hash,menuIntentHash({...base,items:[{producto_id:7,cantidad:4}]}));
 assert.notEqual(hash,menuIntentHash({...base,channel:'landing'}));
 assert.equal(menuIntentHash({...base,items:[{producto_id:7,cantidad:0.1},{producto_id:7,cantidad:0.2}]}),menuIntentHash({...base,items:[{producto_id:7,cantidad:0.3}]}));
});

test('disabled company remains neutral despite paused product and no service days', async () => {
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try {
  const rows=[{id:1,nombre:'Legacy'}];
  const q=async sql=>{
   if(sql.includes('FROM empresas'))return [{menu_config:{enabled:false,service_weekdays:[]}}];
   throw Error('disabled company must not read quota or product configuration');
  };
  assert.equal(await filterMenuCatalog(q,{empresaId:7,products:rows,now:new Date('2026-10-15T15:00:00Z')}),rows);
 } finally {delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('public filtering enforces manual visibility even when original query requests all',async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try {
  const configs=[{id:1,mostrar_en_catalogo:false,mostrar_en_landing:true,disponibilidad_config:{enabled:true,weekdays:[0,1,2,3,4,5,6]}},{id:2,mostrar_en_catalogo:false,mostrar_en_landing:false,disponibilidad_config:{}}];
  const q=async sql=>sql.includes('FROM empresas')?[{menu_config:{enabled:true,timezone:'UTC'}}]:sql.includes('FROM productos')?configs:[];
  const products=[{id:1},{id:2}];
  assert.deepEqual((await filterMenuCatalog(q,{empresaId:7,products,channel:'catalog',now:new Date('2026-10-15T12:00Z')})).map(p=>p.id),[2]);
  assert.deepEqual((await filterMenuCatalog(q,{empresaId:7,products,channel:'landing',now:new Date('2026-10-15T12:00Z')})).map(p=>p.id),[1,2]);
 } finally {delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('logistical lead time uses the fresh clock after a blocking quota read',async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try {
  let current=new Date('2026-10-15T23:59:00Z');
  const q=async sql=>{
   if(sql.includes('FROM empresas'))return [{menu_config:{enabled:true,timezone:'UTC',advance_enabled:true}}];
   if(sql.includes('FROM productos'))return [{id:1,disponibilidad_config:{}}];
   if(sql.includes('menu_cupos_diarios')){current=new Date('2026-10-16T00:01:00Z');return [];}
   throw Error('unexpected query');
  };
  await assert.rejects(validateMenuOrder(q,{empresaId:7,items:[{producto_id:1,cantidad:1}],deliveryDate:'2026-10-16',now:()=>current,logistics:{dias_habiles:[0,1,2,3,4,5,6],tiempo_entrega_dias:1}}),{code:'MENU_LOGISTICS_CLOSED'});
 } finally {delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('disabled tenant cannot accept an explicit scheduled date despite retained advance configuration',async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try {
  const q=async sql=>sql.includes('FROM empresas')?[{menu_config:{enabled:false,timezone:'UTC',advance_enabled:true}}]:sql.includes('FROM productos')?[{id:1,disponibilidad_config:{}}]:[];
  await assert.rejects(validateMenuOrder(q,{empresaId:7,items:[{producto_id:1,cantidad:1}],deliveryDate:'2026-10-16',now:new Date('2026-10-15T12:00Z')}),{code:'MENU_DISABLED'});
 }finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('database menu errors are sanitized to business conflicts', () => {
 assert.deepEqual(menuBusinessFailure({code:'23514',constraint:'menu_capacity_guard',message:'private SQL'}),{status:409,error:'El menú cambió o no tiene cupo disponible',code:'MENU_CONFLICT'});
 assert.equal(menuBusinessFailure({code:'42P01',message:'private SQL'}),null);
});
