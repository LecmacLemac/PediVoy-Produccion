'use strict';
(() => {
 const $ = id => document.getElementById(id);
 let policy, actor, cursor = null, secret = '', canonicalOrigin = '', creating = false, lifecycleGeneration = 0;
 const status = message => { $('status').textContent = message; $('status').dataset.ready = 'true'; };
 const errorMessage = error => error.status === 402 ? 'Tu licencia está vencida. Podés consultar y revocar conexiones existentes; no crear ni usar accesos.' : error.status === 403 ? 'No tenés permiso para esta operación.' : error.message || 'No se pudo completar la operación. Intentá nuevamente.';
 async function api(path, body) {
   let response;
   try { response = await fetch(path, {credentials:'include',mode:'same-origin',method:body === undefined?'GET':'POST',headers:{Accept:'application/json',...(body === undefined?{}:{'Content-Type':'application/json'})},...(body === undefined?{}:{body:JSON.stringify(body)})}); }
   catch { throw new Error('No se pudo conectar con PediVoy. Revisá tu conexión.'); }
   if(response.status === 401) { location.replace('/pedidos/login.html?next=%2Fpedidos%2Fmi-agente.html'); throw Object.assign(new Error('Tu sesión venció.'),{status:401}); }
   let data; try { data=await response.json(); } catch { throw new Error('PediVoy devolvió una respuesta no válida.'); }
   if(!response.ok) {
     // Render only known local messages: backend diagnostics may contain sensitive data.
     const code = typeof data.error === 'object' ? data.error?.code : data.error;
     throw Object.assign(new Error(code === 'FEATURE_DISABLED' ? 'La integración no está habilitada en esta instancia.' : 'No se pudo completar la operación. Revisá permisos y vigencia.'),{status:response.status});
   }
   return data;
 }
 function node(tag,text,className) { const el=document.createElement(tag);if(text !== undefined)el.textContent=String(text);if(className)el.className=className;return el; }
 function configuration(token) { return JSON.stringify({mcpServers:{pedivoy:{command:'node',args:[$('bridge-path').value.trim() || '/ruta/absoluta/agent-bridge.mjs'],env:{PEDIVOY_AGENT_URL:canonicalOrigin || 'https://tu-instancia.example',PEDIVOY_AGENT_TOKEN:token}}}},null,2); }
 function clearSecret() { secret='';$('token').value='';$('secret-config').value='';$('secret-config').hidden=true;$('copy-config').hidden=true;$('copy-status').textContent=''; }
 $('token-dialog').addEventListener('close',clearSecret);
 $('token-dialog').addEventListener('cancel',clearSecret);
 $('close-token').addEventListener('click',()=>{clearSecret();$('token-dialog').close();});
 function invalidateSecret(){lifecycleGeneration++;clearSecret();if($('token-dialog').open)$('token-dialog').close();}
 window.addEventListener('pagehide',invalidateSecret);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)invalidateSecret();});
 async function copy(value) { try { await navigator.clipboard.writeText(value);$('copy-status').textContent='Copiado. El portapapeles contiene un secreto; borrá su contenido cuando termines.'; } catch { $('copy-status').textContent='No se pudo copiar. Seleccioná el campo y copialo manualmente.'; } }
 $('copy-token').addEventListener('click',()=>{if(secret)void copy(secret);});
 $('export-config').addEventListener('click',()=>{if(!secret)return;$('secret-config').value=configuration(secret);$('secret-config').hidden=false;$('copy-config').hidden=false;});
 $('bridge-path').addEventListener('input',()=>{$('secret-config').value='';$('secret-config').hidden=true;$('copy-config').hidden=true;});
 $('copy-config').addEventListener('click',()=>{if(secret&&!$('secret-config').hidden)void copy($('secret-config').value);});
 function selectedScopes(){return [...$('scopes').querySelectorAll('input:checked')].map(e=>e.value);}
 function updateCreate(){
   const active=(policy?.enabled === true && canonicalOrigin && !creating);
   const count=Number($('connection-count').dataset.active || 0);
   $('create-fields').disabled=!active;
   $('create').disabled=!active || (Number.isFinite(Number(policy?.maxConnections)) && count>=Number(policy.maxConnections));
   $('write-warning').hidden=!selectedScopes().some(s=>policy.scopes.find(p=>p.scope===s)?.write);
 }
 function renderPolicy(){
   const role=actor.rol || actor.role;
   $('role').textContent=`Rol: ${role}`;
   try { const url=new URL(policy.canonicalOrigin);if(url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash)canonicalOrigin=url.origin; } catch { canonicalOrigin=''; }
   $('config-example').textContent=configuration('PEGAR_TOKEN_DE_LA_CONEXION');
   $('company-field').hidden=role!=='super';$('empresa-id').required=role==='super';
   const max=Math.min(30,Number(policy.maxExpiryDays)||30);$('expiry').max=String(max);$('expiry').value=String(Math.min(7,max));$('expiry-help').textContent=`Hasta ${max} días. Podés revocar antes.`;
   $('scopes').replaceChildren();
   for(const scope of policy.scopes || []){
     if(Array.isArray(scope.roles)&&!scope.roles.includes(role))continue;
     const label=node('label',undefined,'scope'),input=node('input');input.type='checkbox';input.value=scope.scope;input.checked=scope.write!==true;
     input.addEventListener('change',updateCreate);
     const text=node('span');text.append(node('strong',`${scope.label}${scope.write?' · Escritura':''}`),node('small',scope.description),node('code',scope.scope));label.append(input,text);$('scopes').append(label);
   }
   updateCreate();
 }
 async function loadConnections(){
   const data=await api('/api/mi-agente/connections');const items=data.connections || [];$('connections').replaceChildren();
   const active=items.filter(c=>!c.revoked_at && (!c.expires_at || Date.parse(c.expires_at)>Date.now())).length;
   $('connection-count').dataset.active=String(active);$('connection-count').textContent=`${active} activas · Máximo ${policy?.maxConnections ?? 'según tu cuenta'}`;
   if(!items.length)$('connections').append(node('p','Todavía no conectaste ningún agente.'));
   for(const connection of items){
     const row=node('article',undefined,'connection');row.append(node('h3',connection.name));
     const expired=connection.expires_at && Date.parse(connection.expires_at)<=Date.now();
     row.append(node('span',connection.revoked_at?'Revocada':expired?'Vencida':'Activa','badge'),node('p',`Permisos: ${(connection.scopes || []).join(', ')}`,'muted'),node('p',`Vence: ${formatDate(connection.expires_at)}`,'muted'));
     if(!connection.revoked_at){const revoke=node('button','Revocar acceso');revoke.type='button';revoke.dataset.revoke=String(connection.id);revoke.addEventListener('click',async()=>{
       if(!confirm(`¿Revocar el acceso de «${connection.name}»? Su agente dejará de poder usar esta conexión.`))return;
       revoke.disabled=true;try{await api(`/api/mi-agente/connections/${encodeURIComponent(connection.id)}/revoke`,{});await loadConnections();status('Conexión revocada.');}catch(e){status(errorMessage(e));revoke.disabled=false;}
     });row.append(revoke);}
     $('connections').append(row);
   } updateCreate();
 }
 function formatDate(value){if(!value)return 'Sin registro';const date=new Date(value);return Number.isNaN(date.getTime())?'Sin registro':date.toLocaleString('es-AR');}
 async function loadAudit(reset=false){
   $('more-audit').disabled=true;
   try{
     const suffix=!reset&&cursor?`&before=${encodeURIComponent(cursor)}`:'';
     const data=await api(`/api/mi-agente/audit?limit=20${suffix}`);
     if(reset)$('audit').replaceChildren();
     for(const event of data.events || [])$('audit').append(node('li',`${formatDate(event.created_at)} · ${event.tool || 'Operación'} · ${event.outcome || 'Sin estado'} · Conexión ${event.connection_id ?? '—'}`));
     cursor=data.next_cursor || null;$('more-audit').hidden=!cursor;$('audit-empty').hidden=$('audit').children.length>0;
   }finally{$('more-audit').disabled=false;}
 }
 $('more-audit').addEventListener('click',()=>loadAudit().catch(e=>status(errorMessage(e))));
 $('refresh').addEventListener('click',async()=>{ $('refresh').disabled=true;try{await loadConnections();await loadAudit(true);}catch(e){status(errorMessage(e));}finally{$('refresh').disabled=false;} });
 $('create-form').addEventListener('submit',async event=>{
   event.preventDefault();if(creating || $('create').disabled)return;
   const scopes=selectedScopes(),name=$('name').value.trim(),days=Number($('expiry').value);
   if(!name || !scopes.length){status('Indicá un nombre y seleccioná al menos un permiso.');return;}
   if(!Number.isInteger(days)||days<1||days>Number($('expiry').max)){status('Revisá la vigencia de la conexión.');return;}
   const body={name,scopes,expires_in_days:days};
   if((actor.rol || actor.role)==='super'){const id=Number($('empresa-id').value);if(!Number.isSafeInteger(id)||id<=0){status('Indicá un ID de empresa positivo.');return;}body.empresa_id=id;}
   creating=true;updateCreate();clearSecret();
   const generation=lifecycleGeneration;
   try{
     const result=await api('/api/mi-agente/connections',body);
     // Hiding invalidates this disclosure even if the user returns before the POST resolves.
     // The connection may already exist: discard the token, never retry the creation.
     if(generation!==lifecycleGeneration || document.hidden){
       result.token='';clearSecret();
       status('La conexión se creó o puede haberse creado; token descartado. Revisá el listado y revocá la conexión antes de crear otra.');
       try{await loadConnections();}catch{/* Keep the reconciliation warning; refresh/revoke remain available. */}
       return;
     }
     if(typeof result.token!=='string'||!result.token)throw new Error('La conexión no devolvió un token válido. Revisá el listado antes de volver a crear.');
     secret=result.token;result.token='';$('token').value=secret;$('token-dialog').showModal();$('name').value='';
     status('Conexión creada. Guardá el token antes de cerrar.');
     try{await loadConnections();}catch{status('Conexión creada. No se pudo actualizar el listado; no vuelvas a crearla.');}
   }catch(e){status(errorMessage(e));}finally{creating=false;updateCreate();}
 });
 async function init(){
   try{
     const me=await api('/api/me');actor=me.user;if(!actor)throw new Error('No se pudo verificar tu identidad.');
     let policyError;
     try{policy=await api('/api/mi-agente/policy');renderPolicy();}catch(e){policyError=e;policy={enabled:false,scopes:[]};updateCreate();}
     const results=await Promise.allSettled([loadConnections(),loadAudit(true)]);
     const error=policyError || results.find(r=>r.status==='rejected')?.reason;
     if(error)status(errorMessage(error));
     else status(policy.enabled&&canonicalOrigin?'Acceso personal verificado. Elegí sólo los permisos que tu agente necesita.':'Integración no disponible: está deshabilitada o falta configurar el origen HTTPS. Podés consultar y revocar conexiones existentes.');
   }catch(e){status(errorMessage(e));}
 }
 void init();
})();
