import express from 'express';
import { menuFeatureEnabled, normalizeCompanyMenuConfig } from '../menuAvailability.js';
import { loadMenuCompany, publicMenuDates, menuBusinessFailure, menuError, lockMenuWriteBarrier } from '../services/menuOrderAvailability.js';
import { resolvePublicPedidoEmpresaId } from '../services/publicPedidoTenant.js';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';
import { lockCanonicalBackofficeActor, parseCanonicalPositiveInt4 } from './pedidoBackofficeMutation.js';

function failure(res,error) {
  const business=menuBusinessFailure(error);
  if(business) return res.status(business.status).json({error:business.error,code:business.code});
  const status=Number(error?.statusCode)||500;
  return res.status(status).json({error:status<500?error.message:'No se pudo procesar el menú'});
}

export function createMenuRouter({query,withTransaction,withAuth,checkLicencia}) {
  const router=express.Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.use(withAuth,requireCanonicalBackofficeRole);
  if(checkLicencia) router.use(checkLicencia);
  const target=async(req,q)=>{
    const {tenantEmpresa}=await lockCanonicalBackofficeActor(q,req.user);
    const requested=req.query.empresa_id == null?null:parseCanonicalPositiveInt4(req.query.empresa_id,'Empresa inválida');
    if(tenantEmpresa && requested && tenantEmpresa!==requested) throw menuError('MENU_TENANT_FORBIDDEN','Acceso denegado',403);
    const id=tenantEmpresa||requested;
    if(!id) throw menuError('MENU_TENANT_REQUIRED','Debe elegir una empresa',400);
    return id;
  };
  router.get('/config',async(req,res)=>{
    try {
      const result=await withTransaction(async q=>{
        const empresa_id=await target(req,q);
        if(!menuFeatureEnabled()) return {enabled:false,empresa_id,config:null};
        return {enabled:true,empresa_id,config:await loadMenuCompany(q,empresa_id)};
      });
      return res.json(result);
    } catch(error){return failure(res,error);}
  });
  router.put('/config',async(req,res)=>{
    try {
      const result=await withTransaction(async q=>{
        await lockMenuWriteBarrier(q);
        const empresa_id=await target(req,q);
        if(!menuFeatureEnabled()) throw menuError('MENU_DISABLED','Menús programados deshabilitados',409);
        if(req.user.role !== 'super') {
          const licenses = await q('SELECT plan_estado, plan_vencimiento FROM empresas WHERE id=$1 FOR SHARE',[empresa_id]);
          if(licenses.length !== 1) throw menuError('MENU_TENANT_NOT_FOUND','Empresa no encontrada',404);
          const license=licenses[0];
          if(license.plan_estado === 'expired' || (license.plan_vencimiento && new Date(license.plan_vencimiento).getTime() < Date.now())) {
            throw menuError('MENU_LICENSE_EXPIRED','licencia_vencida',402);
          }
        }
        const config=normalizeCompanyMenuConfig(req.body);
        const rows=await q('UPDATE empresas SET menu_config=$1::jsonb WHERE id=$2 RETURNING id',[JSON.stringify(config),empresa_id]);
        if(rows.length!==1) throw menuError('MENU_TENANT_NOT_FOUND','Empresa no encontrada',404);
        return {enabled:true,empresa_id,config};
      });
      return res.json(result);
    } catch(error){return failure(res,error);}
  });
  router.get('/preview',async(req,res)=>{
    try {
      const result=await withTransaction(async q=>{
        const empresaId=await target(req,q);
        if(!menuFeatureEnabled()) return {enabled:false};
        const id=parseCanonicalPositiveInt4(req.query.producto_id,'Producto inválido');
        const channel=req.query.canal||'catalog';
        if(!['catalog','landing'].includes(channel)) throw menuError('MENU_CHANNEL_INVALID','Canal inválido',400);
        const products=await q('SELECT id, disponibilidad_config FROM productos WHERE id=$1 AND empresa_id=$2 AND deleted_at IS NULL',[id,empresaId]);
        if(products.length!==1) throw menuError('MENU_PRODUCT_NOT_FOUND','Producto no encontrado',404);
        // Preview must retain unavailable evaluations too, unlike public filtering.
        const {evaluateProductAvailability,validateServiceDate}=await import('../menuAvailability.js');
        const company=await loadMenuCompany(q,empresaId);
        const now=new Date();
        const date=validateServiceDate({company,deliveryDate:req.query.fecha_entrega,now});
        const used=await q('SELECT reservado FROM public.menu_cupos_diarios WHERE empresa_id=$1 AND producto_id=$2 AND fecha=$3::date',[empresaId,id,date]);
        return {enabled:true,producto_id:id,config:products[0].disponibilidad_config,menu:evaluateProductAvailability({company,productConfig:products[0].disponibilidad_config,deliveryDate:date,channel,now,usedQuantity:Number(used[0]?.reservado||0)})};
      });
      return res.json(result);
    } catch(error){return failure(res,error);}
  });
  return router;
}

export function createPublicMenuRouter({query,resolveEmpresaIdFn=resolvePublicPedidoEmpresaId}) {
  const router=express.Router();
  router.get('/menu',async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
      const empresaId=await resolveEmpresaIdFn(req,query);
      return res.json(await publicMenuDates(query,{empresaId,deliveryDate:req.query.fecha_entrega}));
    } catch(error){return failure(res,error);}
  });
  return router;
}
