import express from 'express';
import {agentError} from '../agents/service.js';

export function createMiAgenteRouter({withAuth,service,canonicalOrigin}) {
 const router=express.Router();
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 router.use(withAuth);
 router.use((req,res,next)=>{
  if(!req.user?.uid) return next(agentError(401,'invalid_identity'));
  if(['POST','PUT','PATCH','DELETE'].includes(req.method)) {
   if(typeof canonicalOrigin!=='string' || !canonicalOrigin || req.get('Origin')!==canonicalOrigin) return next(agentError(403,'origin_denied'));
   if(!req.is('application/json')) return next(agentError(415,'json_required'));
  }
  next();
 });
 router.use(express.json({limit:'8kb',strict:true}));
 router.use((req,_res,next)=>{
  if(req.body && Buffer.byteLength(JSON.stringify(req.body),'utf8')>8192) return next(agentError(413,'payload_too_large'));
  next();
 });
 const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
 const onlyQuery=(req,allowed=[])=>{if(Object.keys(req.query).some(k=>!allowed.includes(k))) throw agentError(400,'invalid_input');};
 const object=body=>body && typeof body==='object' && !Array.isArray(body);
 router.get('/policy',wrap(async(req,res)=>{onlyQuery(req);res.json(await service.getPolicy({uid:req.user.uid}));}));
 router.get('/connections',wrap(async(req,res)=>{onlyQuery(req);res.json({connections:await service.listConnections({uid:req.user.uid})});}));
 router.post('/connections',wrap(async(req,res)=>{
  onlyQuery(req);
  if(!object(req.body) || Object.keys(req.body).some(k=>!['name','scopes','expires_in_days','empresa_id'].includes(k))) throw agentError(400,'invalid_input');
  res.status(201).json(await service.createConnection({uid:req.user.uid},req.body));
 }));
 router.post('/connections/:id/revoke',wrap(async(req,res)=>{
  onlyQuery(req);
  if(!object(req.body) || Object.keys(req.body).length) throw agentError(400,'invalid_input');
  await service.revokeConnection({uid:req.user.uid},req.params.id);
  res.json({ok:true});
 }));
 router.get('/audit',wrap(async(req,res)=>{
  onlyQuery(req,['limit','before']);
  if(req.query.limit!==undefined && (typeof req.query.limit!=='string' || !/^[0-9]{1,3}$/.test(req.query.limit))) throw agentError(400,'invalid_input');
  if(req.query.before!==undefined && typeof req.query.before!=='string') throw agentError(400,'invalid_cursor');
  res.json(await service.listAudit({uid:req.user.uid},{limit:req.query.limit===undefined?50:Number(req.query.limit),before:req.query.before}));
 }));
 router.use((err,_req,res,_next)=>{
  const parser=err?.type==='entity.too.large'?413:err?.type==='entity.parse.failed'?400:null;
  const status=parser || (Number.isInteger(err?.status)&&err.status>=400&&err.status<=599?err.status:500);
  const code=parser===413?'payload_too_large':parser===400?'invalid_json':status===500?'agent_unavailable':err.code;
  res.status(status).json({error:code || 'operation_failed',code:code || 'operation_failed',message:'Operación no permitida'});
 });
 return router;
}
export default createMiAgenteRouter;
