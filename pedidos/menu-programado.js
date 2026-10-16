/* Shared public-menu controller. Dates and eligibility come only from server. */
(function (global) {
  'use strict';
  const styles = document.createElement('style');
  styles.textContent = `
    .pv-menu-selector{--menu-accent:var(--primary,var(--brand,#2563eb));box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 14px;align-items:end;max-width:100%;margin:12px 0 18px;padding:14px;border:1px solid var(--line,var(--border,#e2e8f0));border-radius:16px;background:var(--surface,#fff);color:var(--text,var(--ink,#1e293b))}
    .pv-menu-selector[hidden],.pv-menu-selector [hidden],.pv-menu-cart-date[hidden]{display:none!important}
    .pv-menu-selector label{display:block;margin:0;font-size:13px;font-weight:700;color:inherit}
    .pv-menu-selector select{box-sizing:border-box;display:block;width:100%;max-width:100%;min-height:44px;margin:7px 0 0;padding:10px 34px 10px 12px;border:1px solid var(--line,var(--border,#e2e8f0));border-radius:12px;background-color:var(--surface-soft,#f8fafc);color:inherit;font:inherit;font-size:14px}
    .pv-menu-selector button{box-sizing:border-box;width:auto;max-width:100%;min-height:44px;margin:0;padding:10px 14px;border:1px solid var(--line,var(--border,#e2e8f0));border-radius:12px;background:var(--surface-soft,#f8fafc);color:inherit;font:inherit;font-size:13px;font-weight:700;cursor:pointer;white-space:normal}
    .pv-menu-selector button:hover:not(:disabled){border-color:var(--menu-accent);color:var(--menu-accent)}
    .pv-menu-selector :is(select,button):focus-visible{outline:3px solid var(--menu-accent);outline-offset:3px}
    .pv-menu-selector :disabled{opacity:.6;cursor:wait}
    .pv-menu-selector [role=status]{grid-column:1/-1;grid-row:2;margin:0;font-size:12px;line-height:1.5;color:var(--muted,#64748b);overflow-wrap:anywhere}
    .pv-menu-cart-date{box-sizing:border-box;width:fit-content;max-width:100%;padding:8px 12px;margin:0 0 12px;border:1px solid var(--line,var(--border,#e2e8f0));border-radius:12px;color:var(--text,var(--ink,#1e293b));background:var(--surface-soft,#f8fafc);font-size:13px;font-weight:700}
    @media(max-width:480px){.pv-menu-selector{grid-template-columns:minmax(0,1fr);padding:12px}.pv-menu-selector button{width:100%}.pv-menu-selector [role=status]{grid-row:auto}}
  `;
  document.head.append(styles);
  function formatDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(String(value || ''));
    return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
  }
  function acceptedDate(order) {
    return formatDate(order?.fecha_entrega_programada || order?.serviceDate || '');
  }
  // Compare NUMERIC quantities in decimal space, not with a permissive epsilon.
  function addQuantity(a,b) {
    if (![a,b].every(value=>Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER)) return NaN;
    const parts=value=>{const [coefficient,exponent='0']=String(value).split('e');const [integer,fraction='']=coefficient.split('.');let units=BigInt(integer+fraction),scale=fraction.length-Number(exponent);if(scale<0){units*=10n**BigInt(-scale);scale=0;}return {units,scale};};
    const left=parts(a),right=parts(b),scale=Math.max(left.scale,right.scale);
    const result=Number(`${left.units*10n**BigInt(scale-left.scale)+right.units*10n**BigInt(scale-right.scale)}e-${scale}`);
    return result<=Number.MAX_SAFE_INTEGER?result:NaN;
  }
  function create(options) {
    const initialDate = new URLSearchParams(location.search).get('fecha_entrega') || '';
    let metadata = null, date = '', products = [], generation = 0, abort = null, busy = false, committedTenant = '', loadFailed = false;
    const host = options.root;
    const panel = document.createElement('section');
    panel.hidden = true;
    panel.className = 'pv-menu-selector';
    const label = document.createElement('label'); label.textContent = 'Menú para entrega: ';
    const select = document.createElement('select'); select.dataset.menuDate = ''; select.setAttribute('aria-label', 'Fecha de entrega');
    label.append(select);
    const status = document.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.dataset.menuStatus='';
    const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.menuRetry = '';

    retry.addEventListener('click', () => load(date || initialDate));
    panel.append(label,status,retry);host?.append(panel);
    const cartLabel = document.createElement('p'); cartLabel.className='pv-menu-cart-date';cartLabel.dataset.menuCartDate='';cartLabel.hidden=true;
    options.cartRoot?.prepend(cartLabel);
    function render() {
      panel.hidden = !metadata?.enabled && !loadFailed; cartLabel.hidden = !metadata?.enabled;
      label.hidden = !metadata?.enabled;
      retry.textContent = loadFailed ? 'Reintentar menú' : 'Actualizar disponibilidad';
      retry.disabled = busy || !!options.locked?.();
      if (!metadata?.enabled) return;
      select.replaceChildren();
      const dates = metadata.advance_enabled ? [...metadata.dates] : [metadata.today].filter(d=>metadata.dates.includes(d));
      if (date === metadata.today && !dates.includes(date)) dates.unshift(date);
      for (const value of dates) {
        const item=document.createElement('option');item.value=value;item.textContent=value===metadata.today?`Hoy · ${formatDate(value)}${metadata.dates.includes(value)?'':' · Cerrado'}`:formatDate(value);select.append(item);
      }
      select.value=date; select.disabled=busy || !!options.locked?.();
      cartLabel.textContent=`Entrega: ${formatDate(date)}`;
    }
    function setBusy(value) {busy=value;render();options.onBusy?.(value);}
    function current(token, tenant) {return token===generation && tenant===options.tenant();}
    function invalid(items, rows) {
      const totals = new Map();
      for (const item of items) {
        const key = String(item.producto_id || item.id);
        totals.set(key, addQuantity(totals.has(key) ? totals.get(key) : 0, Number(item.cantidad)));
      }
      return items.filter(item=>{
        const key = String(item.producto_id || item.id);
        const p=rows.find(p=>String(p.id)===key);
        return !p || p.menu?.available===false || !Number.isFinite(totals.get(key)) || (p.menu?.remaining != null && totals.get(key)>Number(p.menu.remaining));
      });
    }
    async function load(target, initial=false) {
      if (options.locked?.()) return false;
      const token=++generation,tenant=options.tenant();abort?.abort();abort=new AbortController();
      const oldDate=date;
      loadFailed=false;setBusy(true);status.textContent='Cargando menú…';
      try {
        let meta;
        try { meta=await options.request(options.url('/public/menu'),{signal:abort.signal}); }
        catch (error) { if (!metadata && initial && error.status===404) meta={enabled:false}; else throw error; }
        if(!current(token,tenant))return false;
        let chosen='';
        if(meta.enabled) {
          if (!Array.isArray(meta.dates) || ![meta.today, meta.selected_date, ...meta.dates].every(value => {
            if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
            const parsed = new Date(value + 'T12:00:00Z');
            return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
          })) throw new Error('El servidor no devolvió fechas válidas.');
          chosen=target || meta.selected_date || meta.today;
          const closedToday = chosen === meta.today && (!target || (date === chosen && committedTenant === tenant));
          if((!meta.dates.includes(chosen) && !closedToday)||(!meta.advance_enabled&&chosen!==meta.today)) {
            if (!metadata) { metadata=meta; date=''; }
            throw new Error('La fecha de entrega ya no está habilitada. Elegí otra fecha.');
          }
        }
        const rows=meta.enabled && !meta.dates.includes(chosen) ? [] : await options.request(options.url('/public/productos',{scope:options.channel,...(meta.enabled?{fecha_entrega:chosen}:{})}),{signal:abort.signal});
        if(!current(token,tenant))return false;
        if(!Array.isArray(rows))throw new Error('No se pudo cargar el menú.');
        const items=options.cart();
        if(!initial&&items.length&&(chosen!==oldDate||tenant!==committedTenant)) {
          if(!global.confirm(`¿Cambiar la entrega del carrito a ${formatDate(chosen)}? Todos los productos se revisarán para esa fecha.`))return false;
        }
        const missing=meta.enabled?invalid(items,rows):[];
        if(missing.length && !global.confirm(`No disponibles para ${formatDate(chosen)}: ${missing.map(i=>i.nombre||i.producto).join(', ')}. ¿Quitarlos y continuar? Cancelar conserva tu carrito y fecha.`))return false;
        if(!current(token,tenant))return false;
        metadata=meta;date=chosen;products=rows;committedTenant=tenant;
        if(meta.enabled) {
          const keep=items.filter(i=>!missing.includes(i));
          for(const item of keep) {
            const p=rows.find(p=>String(p.id)===String(item.producto_id||item.id));
            if('precio' in item)item.precio=Number(p.precio);else item.precio_unitario=Number(p.precio);
          }
          items.splice(0,items.length,...keep);
        }
        options.onCommit(rows);
        if(meta.enabled) {const u=new URL(location.href);u.searchParams.set('fecha_entrega',date);history.replaceState(null,'',u);}
        status.textContent=meta.enabled?(meta.dates.includes(date)?`Entrega: ${formatDate(date)}. Disponibilidad sujeta a confirmación.`:'Menú cerrado hoy. Elegí otra fecha habilitada o actualizá la disponibilidad más tarde.'):'';
        return true;
      } catch(error) {
        if(current(token,tenant)&&error.name!=='AbortError') {loadFailed=true;status.textContent=(error.name==='TypeError' ? 'No se pudo cargar el menú.' : error.message || 'No se pudo cargar el menú.') + ' Conservamos tu carrito y fecha.';options.onError?.(status.textContent);}
        if(initial)throw error;
        return false;
      } finally {if(current(token,tenant)){if(status.textContent==='Cargando menú…')status.textContent='Cambio cancelado. Conservamos tu carrito y fecha.';setBusy(false);render();}}
    }
    select.addEventListener('change',()=>load(select.value));
    return {
      init:()=>load(initialDate,true),
      change:target=>load(target),
      get enabled(){return !!metadata?.enabled;}, get date(){return date;}, get today(){return metadata?.today || '';}, get busy(){return busy;},
      payload() {if(committedTenant && options.tenant()!==committedTenant)throw new Error('La empresa cambió. Volvé a cargar su menú antes de pedir.');if(busy)throw new Error('Esperá a que termine de cargar el menú.');if(!metadata?.enabled)return {};if(!date)throw new Error('Elegí una fecha de entrega.');if(!metadata.dates.includes(date))throw new Error('El menú está cerrado para esta fecha.');if(invalid(options.cart(),products).length)throw new Error('Revisá el carrito: hay productos sin disponibilidad o cupo.');return {fecha_entrega:date,catalog_channel:options.channel};},
      allows(product,quantity=1){return !busy && (!committedTenant || committedTenant===options.tenant()) && (!metadata?.enabled || (metadata.dates.includes(date) && products.some(p=>String(p.id)===String(product.producto_id||product.id)&&p.menu?.available!==false&&(p.menu?.remaining==null||Number(p.menu.remaining)>=quantity))));},
      refresh:()=>load(date || initialDate),
      render,
    };
  }
  global.PediVoyMenu = Object.freeze({create,formatDate,acceptedDate});
})(window);
