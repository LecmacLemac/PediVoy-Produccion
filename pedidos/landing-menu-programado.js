/* Menú común para HTML publicados: se instala antes del catálogo inline.
 * No edita las páginas guardadas ni interpreta su código. Cambiar fecha recarga
 * la página: las respuestas de una fecha anterior nunca repintan la siguiente.
 */
(() => {
 'use strict';
 const script=document.currentScript,empresa=Number(script?.dataset.menuEmpresa);
 if(!Number.isSafeInteger(empresa)||empresa<=0||window.__pedivoyLandingMenu)return;
 window.__pedivoyLandingMenu=true;
 const nativeFetch=window.fetch.bind(window),initialURL=new URL(location.href);
 const pathSlug=initialURL.pathname.match(/^\/(?:landing|l)\/([^/]+)\/?$/i)?.[1];
 const slug=String(pathSlug===undefined?(initialURL.searchParams.get('slug')||''):decodeURIComponent(pathSlug)).trim().toLowerCase();
 let metadata=null,selectedDate='',ready;
 const afterDOM=callback=>document.readyState==='loading'?document.addEventListener('DOMContentLoaded',callback,{once:true}):callback();
 const dateLabel=date=>new Intl.DateTimeFormat('es-AR',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));
 const isDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
 function sameCompany(url){
  if(url.searchParams.has('empresa_id'))return url.searchParams.get('empresa_id')===String(empresa);
  return Boolean(slug&&String(url.searchParams.get('slug')||'').trim().toLowerCase()===slug);
 }
 function prepareLink(anchor){
  if(!metadata?.enabled||!selectedDate)return;
  let url;try{url=new URL(anchor.getAttribute('href'),location.href);}catch{return;}
  if(url.origin!==location.origin||!/^\/pedidos(?:\/(?:index\.html)?)?$/.test(url.pathname)||!sameCompany(url))return;
  url.searchParams.set('fecha_entrega',selectedDate);url.searchParams.set('catalog_channel','landing');
  const href=url.pathname+url.search+url.hash;if(anchor.getAttribute('href')!==href)anchor.setAttribute('href',href);
 }
 function paint(error){
  afterDOM(()=>{
   let section=document.getElementById('pedivoyLandingMenu');
   if(!section){section=document.createElement('section');section.id='pedivoyLandingMenu';section.setAttribute('aria-label','Fecha del menú');
    const header=document.querySelector('body > header');if(header)header.after(section);else document.body.prepend(section);
    const style=document.createElement('style');style.textContent='#pedivoyLandingMenu{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;padding:1rem;box-sizing:border-box;max-width:100%;color:var(--text,#152a36);background:var(--bg,#fff);border-bottom:1px solid var(--border,#dce3e8)}#pedivoyLandingMenu select,#pedivoyLandingMenu button{font:inherit;min-height:44px;padding:.5rem;max-width:100%;border:1px solid #8999a3;border-radius:8px;color:inherit;background:inherit}#pedivoyLandingMenu p{margin:0;line-height:1.5}#pedivoyLandingMenu label{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;max-width:100%}';document.head.append(style);
   }
   section.replaceChildren();
   if(error){
    const message=document.createElement('p');message.id='landingMenuError';message.setAttribute('role','alert');message.textContent='No se pudo verificar la fecha del menú. Reintentá antes de pedir.';
    const retry=document.createElement('button');retry.id='landingMenuRetry';retry.type='button';retry.textContent='Reintentar';retry.addEventListener('click',()=>location.reload());section.append(message,retry);
    if(initialURL.searchParams.has('fecha_entrega')){const today=document.createElement('button');today.id='landingMenuToday';today.type='button';today.textContent='Ver menú de hoy';today.addEventListener('click',()=>{const next=new URL(location.href);next.searchParams.delete('fecha_entrega');location.assign(next.href);});section.append(today);}return;
   }
   const title=document.createElement('strong');title.textContent=selectedDate===metadata.today?'Menú de hoy':'Menú del '+dateLabel(selectedDate);section.append(title);
   if(metadata.advance_enabled){
    const label=document.createElement('label');label.append('Pedir para: ');const select=document.createElement('select');select.id='landingMenuDate';select.setAttribute('aria-label','Fecha del menú');
    const dates=[...new Set([metadata.today,...metadata.dates])].sort();for(const date of dates){const option=document.createElement('option');option.value=date;option.textContent=date===metadata.today?'Hoy · '+dateLabel(date):dateLabel(date);option.selected=date===selectedDate;select.append(option);}
    select.addEventListener('change',()=>{select.disabled=true;const next=new URL(location.href);next.searchParams.set('fecha_entrega',select.value);location.assign(next.href);});label.append(select);section.append(label);
   }
   const note=document.createElement('p');note.textContent='Disponibilidad y cupo se confirman al finalizar el pedido.';section.append(note);
   document.querySelectorAll('a[href]').forEach(prepareLink);
   const observer=new MutationObserver(records=>{for(const record of records){if(record.type==='attributes')prepareLink(record.target);for(const node of record.addedNodes){if(node.nodeType!==1)continue;if(node.matches('a[href]'))prepareLink(node);node.querySelectorAll('a[href]').forEach(prepareLink);}}});
   observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['href']});
   document.addEventListener('click',event=>{const anchor=event.target.closest?.('a[href]');if(anchor)prepareLink(anchor);},true);
  });
 }
 window.fetch=async function(input,init){
  const method=String(init?.method||(typeof Request!=='undefined'&&input instanceof Request?input.method:'GET')).toUpperCase();
  let url;try{url=new URL(typeof Request!=='undefined'&&input instanceof Request?input.url:input,location.href);}catch{return nativeFetch(input,init);}
  if(method!=='GET'||url.origin!==location.origin||!/^\/(?:api\/)?public\/productos\/?$/.test(url.pathname)||!sameCompany(url))return nativeFetch(input,init);
  await ready;
  if(!metadata.enabled)return nativeFetch(input,init);
  url.searchParams.set('fecha_entrega',selectedDate);url.searchParams.set('scope','landing');
  const request=typeof Request!=='undefined'&&input instanceof Request?new Request(url.href,input):url.href;
  return nativeFetch(request,init);
 };
 ready=(async()=>{
  const url=new URL('/public/menu',location.origin);url.searchParams.set('empresa_id',String(empresa));
  if(initialURL.searchParams.has('fecha_entrega'))url.searchParams.set('fecha_entrega',initialURL.searchParams.get('fecha_entrega'));
  const response=await nativeFetch(url.href,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error('menu-metadata-unavailable');const value=await response.json();
  if(value.enabled!==true){metadata={enabled:false};return;}
  if(!isDate(value.today)||!isDate(value.selected_date)||!Array.isArray(value.dates)||!value.dates.every(isDate))throw new Error('menu-metadata-invalid');
  const requested=initialURL.searchParams.get('fecha_entrega');
  if(requested&&requested!==value.selected_date)throw new Error('menu-date-not-accepted');
  if(value.selected_date!==value.today&&(!value.advance_enabled||!value.dates.includes(value.selected_date)))throw new Error('menu-date-not-allowed');
  metadata=value;selectedDate=value.selected_date;paint(false);
 })();
 // Handle the metadata promise even when a template has no product request.
 ready.catch(()=>paint(true));
 const guardBuy=event=>{
  const anchor=event.target.closest?.('a[href]');if(!anchor)return;
  let url;try{url=new URL(anchor.href,location.href);}catch{return;}
  if(url.origin!==location.origin||!/^\/pedidos(?:\/(?:index\.html)?)?$/.test(url.pathname)||!sameCompany(url))return;
  if(metadata===null){
   event.preventDefault();event.stopImmediatePropagation();
   if(event.type==='click'&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey)ready.then(()=>{if(anchor.isConnected)anchor.click();}).catch(()=>{});
   return;
  }
  prepareLink(anchor);
 };
 for(const type of ['click','auxclick','contextmenu'])document.addEventListener(type,guardBuy,true);
})();
