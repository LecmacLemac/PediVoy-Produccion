import test from 'node:test';
import assert from 'node:assert/strict';

import * as policy from '../src/menuAvailability.js';
const bad = fn => assert.throws(fn, e => e.statusCode === 400 && e.code === 'MENU_INVALID_CONFIG');

test('normalización estricta, defaults y copias sin mutar entrada', () => {
  const c = policy.normalizeCompanyMenuConfig({});
  assert.deepEqual(c, {version:1,enabled:false,timezone:'America/Argentina/Buenos_Aires',advance_enabled:false,max_advance_days:7,service_weekdays:[0,1,2,3,4,5,6],closed_dates:[]});
  const p = policy.normalizeProductAvailabilityConfig({});
  assert.equal(p.daily_capacity,null);
  c.service_weekdays.pop();
  assert.equal(policy.normalizeCompanyMenuConfig({}).service_weekdays.length,7);
  for (const value of [null,[], 'x', {enabled:'true'}, {version:2}, {max_advance_days:'7'}, {max_advance_days:31}, {max_advance_days:-1}, {timezone:'Foo/Bar'}, {service_weekdays:[7]}, {service_weekdays:[1,1]}, {closed_dates:['2026-02-29']}, {closed_dates:['2026-10-15','2026-10-15']}, {unknown:1}]) bad(() => policy.normalizeCompanyMenuConfig(value));
  for (const value of [null,[], {enabled:1}, {mode:'daily'}, {weekdays:['1']}, {dates:['2026-04-31']}, {dates:['2026-01-01','2026-01-01']}, {open_time:'24:00'}, {close_time:'9:30'}, {open_days_before:'1'}, {daily_capacity:'2'}, {daily_capacity:NaN}, {daily_capacity:Infinity}, {daily_capacity:-1}, {daily_capacity:Number.MAX_SAFE_INTEGER+1}, {allow_advance:'false'}, {exceptions:[{date:'2026-10-15',paused:'true'}]}, {exceptions:[{date:'2026-10-15'},{date:'2026-10-15'}]}, {channels:{other:{}}}, {channels:{catalog:{daily_capacity:1}}}, {open_time:'23:00',close_time:'10:00'}]) bad(() => policy.normalizeProductAvailabilityConfig(value));
  const input = {daily_capacity:2.5,exceptions:[{date:'2026-10-15',paused:false},{date:'2026-10-16',capacity:null}],channels:{landing:{weekdays:[4],open_time:'01:00'}}};
  const result = policy.normalizeProductAvailabilityConfig(input);
  assert.deepEqual(result.exceptions,input.exceptions);
  assert.deepEqual(result.channels,input.channels);
  result.exceptions[0].paused = true;
  assert.equal(input.exceptions[0].paused,false);
});

const company = {enabled:true,advance_enabled:true,max_advance_days:7};
const now = new Date('2026-10-15T15:00:00Z');
function dateError(code, deliveryDate, c = company, clock = now) {
  assert.throws(() => policy.validateServiceDate({company:c,deliveryDate,now:clock}), e => e.statusCode === 400 && e.code === code);
}

test('fecha local por timezone y validación estricta de fecha y reloj', () => {
  assert.equal(policy.serviceDateToday({timezone:'Asia/Tokyo'},new Date('2026-10-15T16:00:00Z')),'2026-10-16');
  assert.equal(policy.serviceDateToday({timezone:'America/Los_Angeles'},new Date('2026-10-15T01:00:00Z')),'2026-10-14');
  assert.equal(policy.serviceDateToday({},new Date('2026-10-16T03:00:00Z')),'2026-10-16');
  assert.equal(policy.serviceDateToday({},new Date('2026-10-16T02:59:59.999Z')),'2026-10-15');
  for (const d of [null,'','2026-02-29','2026-10-15T00:00:00Z','2026-1-15',20261015]) dateError('MENU_INVALID_DATE',d);
  assert.throws(() => policy.serviceDateToday({},new Date('invalid')), e => e.code === 'MENU_INVALID_NOW');
  assert.throws(() => policy.serviceDateToday({},'2026-10-15'), e => e.code === 'MENU_INVALID_NOW');
  assert.equal(policy.validateServiceDate({company,now}),'2026-10-15');
});

test('fecha: pasado, horizonte inclusivo, anticipación y cierre empresa', () => {
  dateError('MENU_DATE_PAST','2026-10-14');
  assert.equal(policy.validateServiceDate({company,deliveryDate:'2026-10-22',now}),'2026-10-22');
  dateError('MENU_DATE_OUT_OF_RANGE','2026-10-23');
  dateError('MENU_ADVANCE_DISABLED','2026-10-16',{...company,advance_enabled:false});
  dateError('MENU_DATE_OUT_OF_RANGE','2026-10-16',{...company,max_advance_days:0});
  dateError('MENU_COMPANY_CLOSED','2026-10-15',{...company,closed_dates:['2026-10-15']});
  dateError('MENU_COMPANY_CLOSED','2026-10-15',{...company,service_weekdays:[0]});
  assert.equal(policy.validateServiceDate({company:{...company,service_weekdays:[0]},deliveryDate:'2026-10-18',now}),'2026-10-18');
  // Horizonte medido por fechas civiles, no por bloques de 24 horas durante DST.
  const dstCompany = {...company,timezone:'America/New_York',max_advance_days:1};
  assert.equal(policy.validateServiceDate({company:dstCompany,deliveryDate:'2026-03-09',now:new Date('2026-03-08T05:30:00Z')}),'2026-03-09');
});

const product = {enabled:true};
const evaluate = (overrides = {}) => policy.evaluateProductAvailability({company,productConfig:product,now,deliveryDate:'2026-10-15',...overrides});

test('programación semanal, fechas explícitas y precedencia del cierre empresa', () => {
  assert.equal(evaluate().available,true);
  assert.equal(evaluate().scheduled,true);
  assert.equal(evaluate({productConfig:{...product,weekdays:[0]}}).reason,'MENU_PRODUCT_NOT_SCHEDULED');
  assert.equal(evaluate({productConfig:{...product,mode:'dates',dates:['2026-10-15'],weekdays:[]}}).available,true);
  assert.equal(evaluate({productConfig:{...product,mode:'dates',dates:[]}}).reason,'MENU_PRODUCT_NOT_SCHEDULED');
  assert.equal(evaluate({company:{...company,closed_dates:['2026-10-15']},productConfig:{...product,exceptions:[{date:'2026-10-15',paused:false}]}}).reason,'MENU_COMPANY_CLOSED');
  assert.equal(evaluate({deliveryDate:'2026-10-14'}).reason,'MENU_DATE_PAST');
  assert.equal(evaluate({deliveryDate:'2026-10-23'}).reason,'MENU_DATE_OUT_OF_RANGE');
  for (const p of [{}, {enabled:false,daily_capacity:0}]) {
    const result = evaluate({productConfig:p,company:{...company,closed_dates:['2026-10-15']}});
    assert.equal(result.available,true);
    assert.equal(result.scheduled,false);
    assert.equal(result.remaining,null);
  }
  assert.equal(evaluate({company:{enabled:false},productConfig:{...product,daily_capacity:0}}).available,true);
});

test('ventana con apertura inclusiva y cierre exclusivo en Buenos Aires', () => {
  const p = {...product,open_time:'12:00',close_time:'13:00'};
  for (const [time,available,reason] of [['14:59:59.999',false,'MENU_NOT_OPEN'],['15:00:00.000',true,null],['15:59:59.999',true,null],['16:00:00.000',false,'MENU_CLOSED']]) {
    const result = evaluate({productConfig:p,now:new Date(`2026-10-15T${time}Z`)});
    assert.equal(result.available,available);
    assert.equal(result.reason,reason);
    assert.equal(result.opens_at,'2026-10-15T15:00:00.000Z');
    assert.equal(result.closes_at,'2026-10-15T16:00:00.000Z');
  }
});

test('anticipados exigen ambos permisos y respetan ventana relativa a entrega', () => {
  const p = {...product,open_days_before:2,open_time:'09:00',close_days_before:1,close_time:'18:00'};
  const result = evaluate({productConfig:p,deliveryDate:'2026-10-16'});
  assert.equal(result.available,true);
  assert.equal(result.advance_allowed,true);
  assert.equal(result.opens_at,'2026-10-14T12:00:00.000Z');
  assert.equal(result.closes_at,'2026-10-15T21:00:00.000Z');
  assert.equal(evaluate({productConfig:{...p,allow_advance:false},deliveryDate:'2026-10-16'}).reason,'MENU_ADVANCE_DISABLED');
  assert.equal(evaluate({company:{...company,advance_enabled:false},productConfig:p,deliveryDate:'2026-10-16'}).reason,'MENU_ADVANCE_DISABLED');
  assert.equal(evaluate({productConfig:product,deliveryDate:'2026-10-16'}).reason,'MENU_NOT_OPEN');
  assert.equal(evaluate({productConfig:{...product,allow_advance:false}}).available,true);
});

test('canales: recurrencia y ventanas override, sin alterar configuración base', () => {
  const p = {...product,weekdays:[1],channels:{landing:{weekdays:[4],open_time:'11:00',close_time:'13:00'}}};
  assert.equal(evaluate({productConfig:p,channel:'catalog'}).reason,'MENU_PRODUCT_NOT_SCHEDULED');
  const landing = evaluate({productConfig:p,channel:'landing'});
  assert.equal(landing.available,true);
  assert.equal(landing.opens_at,'2026-10-15T14:00:00.000Z');
  assert.equal(evaluate({productConfig:p,channel:'landing',now:new Date('2026-10-15T16:00:00Z')}).reason,'MENU_CLOSED');
  assert.deepEqual(p.weekdays,[1]);
  const dated = {...product,mode:'dates',dates:['2026-10-16'],channels:{catalog:{dates:['2026-10-15']}}};
  assert.equal(evaluate({productConfig:dated,channel:'catalog'}).available,true);
  assert.equal(evaluate({productConfig:dated,channel:'landing'}).reason,'MENU_PRODUCT_NOT_SCHEDULED');
  assert.throws(() => evaluate({channel:'admin'}), e => e.code === 'MENU_INVALID_CHANNEL' && e.statusCode === 400);
  assert.throws(() => evaluate({channel:null}), e => e.code === 'MENU_INVALID_CHANNEL');
});

test('cupos compartidos y excepciones con herencia, cero y null ilimitado', () => {
  for (const channel of ['catalog','landing']) {
    const p = {...product,daily_capacity:2.5};
    assert.equal(evaluate({productConfig:p,channel,usedQuantity:1.25}).remaining,1.25);
    assert.equal(evaluate({productConfig:p,channel,usedQuantity:2.5}).reason,'MENU_CAPACITY_EXHAUSTED');
    assert.equal(evaluate({productConfig:p,channel,usedQuantity:3}).remaining,0);
    assert.equal(evaluate({productConfig:{...product,daily_capacity:0},channel}).available,false);
    assert.equal(evaluate({productConfig:{...p,exceptions:[{date:'2026-10-15',capacity:null}]},channel,usedQuantity:100}).remaining,null);
    assert.equal(evaluate({productConfig:{...p,exceptions:[{date:'2026-10-15',capacity:1}]},channel,usedQuantity:1}).reason,'MENU_CAPACITY_EXHAUSTED');
    assert.equal(evaluate({productConfig:{...p,exceptions:[{date:'2026-10-15',paused:false}]},channel,usedQuantity:1}).remaining,1.5);
    assert.equal(evaluate({productConfig:{...p,exceptions:[{date:'2026-10-15',paused:true}]},channel}).reason,'MENU_PAUSED');
    assert.equal(evaluate({productConfig:{...p,exceptions:[{date:'2026-10-16',paused:true,capacity:0}]},channel}).remaining,2.5);
  }
  for (const usedQuantity of [null,'1',-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(() => evaluate({usedQuantity}), e => e.code === 'MENU_INVALID_QUANTITY' && e.statusCode === 400);
});

test('timezone extranjero, offset fraccionario y medianoche exacta', () => {
  const c = {...company,timezone:'Asia/Kathmandu'};
  const value = evaluate({company:c,productConfig:{...product,open_time:'00:00',close_time:'01:00'},now:new Date('2026-10-14T18:15:00Z')});
  assert.equal(value.available,true);
  assert.equal(value.opens_at,'2026-10-14T18:15:00.000Z');
  assert.equal(value.closes_at,'2026-10-14T19:15:00.000Z');
  assert.equal(value.timezone,'Asia/Kathmandu');
  assert.equal(evaluate({now:new Date('2026-10-15T03:00:00Z')}).available,true);
});

test('ventanas entre días civiles mantienen DST: 23 y 25 horas, no 24 fijas', () => {
  const c = {...company,timezone:'America/New_York'};
  const p = {...product,weekdays:[0,1,2,3,4,5,6],open_days_before:1,open_time:'00:00',close_time:'00:00'};
  for (const [date,clock,opens,closes] of [
    ['2026-03-09','2026-03-08T06:00:00Z','2026-03-08T05:00:00.000Z','2026-03-09T04:00:00.000Z'],
    ['2026-11-02','2026-11-01T06:00:00Z','2026-11-01T04:00:00.000Z','2026-11-02T05:00:00.000Z']
  ]) {
    const result = evaluate({company:c,productConfig:p,deliveryDate:date,now:new Date(clock)});
    assert.equal(result.available,true);
    assert.equal(result.opens_at,opens);
    assert.equal(result.closes_at,closes);
    assert.equal(evaluate({company:c,productConfig:p,deliveryDate:date,now:new Date(closes)}).reason,'MENU_CLOSED');
  }
});

test('DST: rechaza hora inexistente o ambigua, tanto apertura como cierre', () => {
  const c = {...company,timezone:'America/New_York'};
  for (const [date,time,clock] of [
    ['2026-03-08','02:30','2026-03-08T05:00:00Z'],
    ['2026-11-01','01:30','2026-11-01T04:00:00Z']
  ]) {
    for (const times of [{open_time:time,close_time:'04:00'},{open_time:'00:00',close_time:time}]) {
      const result = evaluate({company:c,productConfig:{...product,weekdays:[0],...times},deliveryDate:date,now:new Date(clock)});
      assert.equal(result.available,false);
      assert.equal(result.reason,'MENU_INVALID_LOCAL_TIME');
      assert.equal(result.opens_at,null);
      assert.equal(result.closes_at,null);
    }
  }
});

test('normalización rechaza listas dispersas y ventanas inválidas por override', () => {
  const sparse = new Array(1);
  bad(() => policy.normalizeCompanyMenuConfig({service_weekdays:sparse}));
  bad(() => policy.normalizeCompanyMenuConfig({closed_dates:sparse}));
  bad(() => policy.normalizeProductAvailabilityConfig({dates:sparse}));
  bad(() => policy.normalizeProductAvailabilityConfig({channels:{landing:{open_time:'23:59',close_time:'23:59'}}}));
  bad(() => policy.normalizeProductAvailabilityConfig({open_days_before:0,close_days_before:1}));
  bad(() => policy.normalizeProductAvailabilityConfig({exceptions:[{date:'2026-10-15',capacity:'0'}]}));
  bad(() => policy.normalizeCompanyMenuConfig({enabled:() => true}));
  bad(() => policy.normalizeProductAvailabilityConfig({enabled:Symbol('invalid')}));
  bad(() => policy.normalizeProductAvailabilityConfig({channels:{landing:{open_time:() => '09:00'}}}));
  bad(() => policy.normalizeProductAvailabilityConfig({channels:{landing:{dates:['2026-10-15','2026-10-15']}}}));
});

test('import y evaluación no consultan entorno; sólo feature helper lo hace', async () => {
  const originalEnv = process.env;
  process.env = new Proxy(originalEnv, {get(target,key) {
    if (key === 'SCHEDULED_MENUS_ENABLED') throw new Error('Lectura de flag fuera del helper');
    return Reflect.get(target,key);
  }});
  try {
    const fresh = await import('../src/menuAvailability.js?pure-import-test');
    assert.equal(fresh.evaluateProductAvailability({company,productConfig:product,now}).available,true);
    assert.equal(fresh.normalizeCompanyMenuConfig({}).enabled,false);
    assert.equal(fresh.menuFeatureEnabled({SCHEDULED_MENUS_ENABLED:'1'}),true);
    assert.throws(() => fresh.menuFeatureEnabled(), /Lectura de flag/);
  } finally { process.env = originalEnv; }
});

test('contrato: seis exports puros y legado neutral', () => {
  for (const name of ['menuFeatureEnabled','normalizeCompanyMenuConfig','normalizeProductAvailabilityConfig','serviceDateToday','validateServiceDate','evaluateProductAvailability']) assert.equal(typeof policy[name], 'function', name);
  assert.equal(policy.menuFeatureEnabled({}), false);
  assert.equal(policy.menuFeatureEnabled({SCHEDULED_MENUS_ENABLED:'1'}), true);
  assert.equal(policy.menuFeatureEnabled({SCHEDULED_MENUS_ENABLED:1}), false);
  assert.equal(policy.normalizeCompanyMenuConfig({}).enabled, false);
  assert.equal(policy.normalizeProductAvailabilityConfig({}).enabled, false);
  const value = policy.evaluateProductAvailability({company:{},productConfig:{},now:new Date('2026-10-15T15:00:00Z')});
  assert.deepEqual(value, {available:true,scheduled:false,reason:null,opens_at:null,closes_at:null,remaining:null,timezone:'America/Argentina/Buenos_Aires',advance_allowed:false,date:'2026-10-15'});
});
