import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { loadCanonicalIdentity } from '../core/auth.js';
import { runWithSensitiveDbQueries } from '../db.js';
import { SCOPES, allowedScopesForRole, effectiveScopes } from './policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positive = n => Number.isSafeInteger(n) && n > 0;
export function agentError(status, code, message = 'Operación no permitida') {
 return Object.assign(new Error(message), {status,statusCode:status,code});
}
const fail = (status,code,message) => { throw agentError(status,code,message); };
const safe = c => ({id:c.id,name:c.name,scopes:[...c.scopes],empresa_id:c.empresa_id,role_at_issue:c.role_at_issue,created_at:c.created_at,expires_at:c.expires_at,revoked_at:c.revoked_at});
function validOrigin(origin) { try {const u=new URL(origin);return u.protocol==='https:' && u.origin===origin && !u.username && !u.password;}catch{return false;} }

export function createAgentService({query,withTransaction,enabled=false,canonicalOrigin,now=()=>new Date()}) {
 const date = () => new Date(now());
 const transact = work => withTransaction(work, {maxRetries:0});
 const protect = fn => async (...args) => runWithSensitiveDbQueries(async () => {try{return await fn(...args);}catch(e){
  if(e?.code==='42P01') throw agentError(503,'schema_required','Inicialización de agentes requerida');
  if(e?.code==='TRANSACTION_OUTCOME_UNKNOWN') throw agentError(503,'outcome_unknown','Resultado no confirmado; conciliar con la misma clave');
  if(e?.status || e?.statusCode) throw agentError(e.status || e.statusCode, /^[A-Za-z0-9_]+$/.test(e.code || '') ? e.code : 'operation_failed');
  throw agentError(500,'agent_unavailable','Servicio de agentes no disponible');
 }});
 const active = () => {if(enabled!==true) fail(503,'agents_disabled');if(!validOrigin(canonicalOrigin)) fail(503,'canonical_origin_required');};
 async function identity(actor,q,lock=false) {
  if(lock) await q('SELECT id FROM usuarios WHERE id=$1 FOR SHARE',[actor?.uid]);
  const current=await loadCanonicalIdentity(actor?.uid,{query:q});
  if(!current) fail(401,'invalid_identity');
  // Keep link rows locked throughout an operation (including active/tenant validation).
  if(lock && current.chofer_id) await q('SELECT id FROM choferes WHERE id=$1 FOR SHARE',[current.chofer_id]);
  if(lock && current.referente_id) await q('SELECT id FROM referentes WHERE id=$1 FOR SHARE',[current.referente_id]);
  if(lock && (current.chofer_id || current.referente_id)) {
   const recheck=await loadCanonicalIdentity(current.uid,{query:q});
   if(!recheck) fail(401,'invalid_identity');
   return recheck;
  }
  return current;
 }
 async function company(actor,empresaId,q,license=true) {
  const rows=await q('SELECT id,plan_estado,plan_vencimiento FROM empresas WHERE id=$1 FOR SHARE',[empresaId]);
  if(!rows.length) fail(403,'invalid_company');
  if(license) {
   const c=rows[0];
   if(c.plan_estado==='expired' || (c.plan_vencimiento && new Date(c.plan_vencimiento).getTime()<date().getTime())) fail(402,'license_expired');
  }
 }
 async function ownerQuota(q,uid) {
  await q('INSERT INTO agent_owner_quotas(owner_uid) VALUES($1) ON CONFLICT DO NOTHING',[uid]);
  return (await q('SELECT * FROM agent_owner_quotas WHERE owner_uid=$1 FOR UPDATE',[uid]))[0];
 }
 async function consumeOwnerQuota(q,uid,kind) {
  // SQL identifiers are from this closed internal branch, never caller input.
  const creates=kind==='creates', count=creates?'creates_count':'calls_count', start=creates?'creates_start':'calls_start';
  const interval=creates?'1 hour':'1 minute', maximum=creates?30:60;
  const rows=await q(`UPDATE agent_owner_quotas SET ${count}=CASE WHEN ${start} IS NULL OR ${start}<=$2::timestamptz-interval '${interval}' THEN 1 ELSE ${count}+1 END,
   ${start}=CASE WHEN ${start} IS NULL OR ${start}<=$2::timestamptz-interval '${interval}' THEN $2 ELSE ${start} END
   WHERE owner_uid=$1 AND (${start} IS NULL OR ${start}<=$2::timestamptz-interval '${interval}' OR ${count}<$3) RETURNING owner_uid`,[uid,date(),maximum]);
  return rows.length>0;
 }
 async function consumeConnectionQuota(q,id) {
  const rows=await q(`UPDATE agent_connections SET quota_count=CASE WHEN quota_start IS NULL OR quota_start<=$2::timestamptz-interval '1 minute' THEN 1 ELSE quota_count+1 END,
   quota_start=CASE WHEN quota_start IS NULL OR quota_start<=$2::timestamptz-interval '1 minute' THEN $2 ELSE quota_start END
   WHERE id=$1 AND (quota_start IS NULL OR quota_start<=$2::timestamptz-interval '1 minute' OR quota_count<60) RETURNING id`,[id,date()]);
  return rows.length>0;
 }
 async function audit(q,c,tool,scope,outcome) {
  await q('INSERT INTO agent_audit(connection_id,owner_uid,empresa_id,tool,scope,outcome,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[c.id,c.owner_uid,c.empresa_id,tool,scope,outcome,date()]);
 }
 async function authenticateInternal(token,{scope,txQuery=qFallback,lock=false}={}) {
  active(); const q=txQuery;
  if(typeof token!=='string' || token.length>150) fail(401,'invalid_agent_token');
  const match=/^pva_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if(!match || !UUID.test(match[1])) fail(401,'invalid_agent_token');
  const rows=await q('SELECT * FROM agent_connections WHERE id=$1',[match[1]]);
  let c=rows[0];
  const digest=createHash('sha256').update(token).digest();
  const expected=Buffer.from(c?.token_hash || '0'.repeat(64),'hex');
  if(expected.length!==digest.length || !timingSafeEqual(digest,expected) || !c || c.revoked_at || new Date(c.expires_at)<=date()) fail(401,'invalid_agent_token');
  const actor=await identity({uid:c.owner_uid},q,lock);
  if(actor.empresa_id!==c.owner_empresa_id || actor.chofer_id!==c.owner_chofer_id || actor.referente_id!==c.owner_referente_id) fail(401,'identity_changed');
  if(actor.role!=='super' && actor.empresa_id!==c.empresa_id) fail(401,'identity_changed');
  await company(actor,c.empresa_id,q);
  if(lock) {
   await ownerQuota(q,actor.uid);
   const locked=(await q('SELECT * FROM agent_connections WHERE id=$1 FOR UPDATE',[c.id]))[0];
   if(!locked || locked.owner_uid!==actor.uid || locked.empresa_id!==c.empresa_id || locked.revoked_at || new Date(locked.expires_at)<=date() || locked.token_hash!==c.token_hash) fail(401,'invalid_agent_token');
   c=locked;
  }
  const scopes=effectiveScopes(c,actor);
  if(scope && !scopes.includes(scope)) fail(403,'scope_denied');
  return {actor,connection:safe(c),empresaId:c.empresa_id,scopes,query:q};
 }
 const qFallback=query;
 const getPolicy=protect(async actor=>{
  const current=await identity(actor,query);
  return {enabled:enabled===true&&validOrigin(canonicalOrigin),scopes:SCOPES.filter(s=>s.roles.includes(current.role)),maxConnections:10,maxExpiryDays:30,canonicalOrigin:validOrigin(canonicalOrigin)?canonicalOrigin:null};
 });
 const listConnections=protect(async actor=>{
  const current=await identity(actor,query);
  return (await query('SELECT * FROM agent_connections WHERE owner_uid=$1 ORDER BY created_at DESC,id',[current.uid])).map(safe);
 });
 const createConnection=protect(async(actor,input={})=>{
  active();
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['name','scopes','expires_in_days','empresa_id'].includes(k))) fail(400,'invalid_input');
  const {name,scopes,expires_in_days:days=7}=input;
  if(typeof name!=='string' || !name.trim() || name.trim().length>80 || /[\x00-\x1f\x7f]/.test(name) || !Array.isArray(scopes) || !scopes.length || scopes.length>SCOPES.length || new Set(scopes).size!==scopes.length || !Number.isInteger(days) || days<1 || days>30) fail(400,'invalid_input');
  return transact(async q=>{
   const current=await identity(actor,q,true);
   const allowed=allowedScopesForRole(current.role);
   if(scopes.some(s=>!allowed.includes(s))) fail(403,'scope_denied');
   if(current.role!=='super' && Object.hasOwn(input,'empresa_id')) fail(400,'company_override_forbidden');
   const empresaId=current.role==='super'?input.empresa_id:current.empresa_id;
   if(!positive(empresaId)) fail(400,'company_required');
   await company(current,empresaId,q);
   await ownerQuota(q,current.uid);
   const count=await q('SELECT count(*)::integer AS count FROM agent_connections WHERE owner_uid=$1 AND revoked_at IS NULL AND expires_at>$2',[current.uid,date()]);
   if(count[0].count>=10) fail(409,'connection_limit');
   if(!await consumeOwnerQuota(q,current.uid,'creates')) fail(429,'creation_rate_limited');
   const id=randomUUID(), token=`pva_${id}.${randomBytes(32).toString('base64url')}`, created=date(), expires=new Date(created.getTime()+days*86400000);
   const rows=await q(`INSERT INTO agent_connections(id,owner_uid,empresa_id,owner_empresa_id,owner_chofer_id,owner_referente_id,role_at_issue,name,scopes,token_hash,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[id,current.uid,empresaId,current.empresa_id,current.chofer_id,current.referente_id,current.role,name.trim(),scopes,createHash('sha256').update(token).digest('hex'),created,expires]);
   await audit(q,rows[0],'connection_created',null,'ok');
   return {connection:safe(rows[0]),token};
  });
 });
 const revokeConnection=protect(async(actor,id)=>{
  if(!UUID.test(id)) fail(404,'connection_not_found');
  return transact(async q=>{
   const current=await identity(actor,q,true);
   const c=(await q('SELECT * FROM agent_connections WHERE id=$1 AND owner_uid=$2 FOR UPDATE',[id,current.uid]))[0];
   if(!c) fail(404,'connection_not_found');
   if(!c.revoked_at){await q('UPDATE agent_connections SET revoked_at=$2 WHERE id=$1',[id,date()]);await audit(q,c,'connection_revoked',null,'ok');}
   return {ok:true};
  });
 });
 const listAudit=protect(async(actor,{limit=50,before}={})=>{
  const current=await identity(actor,query);
  if(!Number.isInteger(limit)||limit<1||limit>100 || (before!==undefined && (!/^[1-9][0-9]{0,18}$/.test(String(before)) || BigInt(before)>9223372036854775807n))) fail(400,'invalid_cursor');
  const rows=await query('SELECT id,connection_id,empresa_id,tool,scope,outcome,created_at FROM agent_audit WHERE owner_uid=$1 AND ($2::bigint IS NULL OR id<$2::bigint) ORDER BY id DESC LIMIT $3',[current.uid,before??null,limit+1]);
  const more=rows.length>limit; const events=rows.slice(0,limit);
  return {events,next_cursor:more?String(events.at(-1).id):null};
 });
 const execute=protect(async(token,{scope,tool,idempotencyKey,requestHash,write=false}={},work)=>{
  const definition=SCOPES.find(s=>s.scope===scope);
  if(!definition || definition.write!==write || typeof tool!=='string' || !/^[a-z][a-z0-9_:.]{0,79}$/.test(tool) || typeof work!=='function') fail(400,'invalid_operation');
  if(write && (!UUID.test(idempotencyKey || '') || typeof requestHash!=='string' || !/^[a-f0-9]{64}$/.test(requestHash))) fail(400,'idempotency_required');
  const outcome=await transact(async q=>{
   const ctx=await authenticateInternal(token,{txQuery:q,lock:true});
   const c={...ctx.connection,owner_uid:ctx.actor.uid};
   const timestamp=date();
   if(!await consumeOwnerQuota(q,ctx.actor.uid,'calls')) {await audit(q,c,tool,scope,'rate_limited');return {error:agentError(429,'rate_limited')};}
   if(!await consumeConnectionQuota(q,c.id)) {await audit(q,c,tool,scope,'rate_limited');return {error:agentError(429,'rate_limited')};}
   await q('SAVEPOINT agent_operation');
   try {
    if(!ctx.scopes.includes(scope)) fail(403,'scope_denied');
    if(write) {
     const previous=(await q('SELECT tool,request_hash,result FROM agent_idempotency WHERE connection_id=$1 AND idempotency_key=$2',[c.id,idempotencyKey]))[0];
     if(previous) {
      if(previous.tool!==tool || previous.request_hash!==requestHash) fail(409,'idempotency_conflict');
      await audit(q,c,tool,scope,'replayed');
      return {result:previous.result};
     }
    }
    const result=await work(ctx);
    // Mutations expose/cache only a minimal acknowledgement, never domain PII.
    const minimal=value=>{
     const out={};
     if(value && typeof value==='object') {
      for(const key of ['id','pedido_id','chofer_id']) if(positive(value[key])) out[key]=value[key];
      for(const key of ['ok','tomado','changed','already_claimed','already_reopened']) if(typeof value[key]==='boolean') out[key]=value[key];
      if(['pendiente','cancelado','asignado','en_reparto','entregado','confirmado','en_camino'].includes(value.estado)) out.estado=value.estado;
      if(value.pedido && typeof value.pedido==='object') out.pedido=minimal(value.pedido);
     }
     return out;
    };
    const output=write?minimal(result):result;
    if(write) await q('INSERT INTO agent_idempotency(connection_id,idempotency_key,tool,request_hash,result,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[c.id,idempotencyKey,tool,requestHash,JSON.stringify(output),timestamp]);
    await audit(q,c,tool,scope,'ok');
    await q('RELEASE SAVEPOINT agent_operation');
    return {result:output};
   } catch(e) {
    await q('ROLLBACK TO SAVEPOINT agent_operation');
    await audit(q,c,tool,scope,'error');
    return {error:e};
   }
  });
  if(outcome.error) throw outcome.error;
  return outcome.result;
 });
 const authenticate=protect(async(token,options={})=>{
  const work=async q=>{
   const context=await authenticateInternal(token,{txQuery:q,lock:true});
   if(!await consumeOwnerQuota(q,context.actor.uid,'calls') || !await consumeConnectionQuota(q,context.connection.id)) return {error:agentError(429,'rate_limited')};
   if(options.scope && !context.scopes.includes(options.scope)) return {error:agentError(403,'scope_denied')};
   return {context};
  };
  const result=options.txQuery?await work(options.txQuery):await transact(work);
  if(result.error) throw result.error;
  const {actor,connection,empresaId,scopes}=result.context;
  return {actor,connection,empresaId,scopes};
 });
 return {getPolicy,listConnections,createConnection,revokeConnection,listAudit,authenticate,execute};
}
