/*! simple-cart.js — convierte cualquier botón en "Agregar al carrito" y envía pedido al backend
  Uso:
    <script src="/simple-cart.js" defer></script>
    <!-- En cada producto -->
    <button
      data-add-to-cart
      data-id="SKU-123"
      data-nombre="Bidón 20L"
      data-precio="1800"
      data-cantidad="1">Agregar</button>
    <!-- Badge opcional -->
    <span data-cart-badge></span>
    <!-- Checkout -->
    <form id="cart-form">
      <input id="cart-nombre" placeholder="Nombre y Apellido" required>
      <input id="cart-telefono" placeholder="WhatsApp" required>
      <input id="cart-direccion" placeholder="Dirección" required>
      <button type="button" data-cart-submit>Enviar pedido</button>
    </form>

  Config (opcional):
    window.MultiEmpresas = { apiBase: 'https://tu-backend.tld' }
*/
(function () {
  const cfg = (window.MultiEmpresas = window.MultiEmpresas || {});
  const apiBase = cfg.apiBase || ''; // mismo origen por defecto
  const STORAGE_KEY = (cfg.storageKey || 'me_cart');

  const $ = (s, el=document)=>el.querySelector(s);
  const $$ = (s, el=document)=>Array.from(el.querySelectorAll(s));

  const money = (n)=> new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(+n||0);

  const Cart = {
    get(){ try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } },
    set(items){ localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); Cart.refreshUI(); },
    add({id, nombre, precio, cantidad=1, imagen}){
      const items = Cart.get();
      const i = items.findIndex(x => String(x.id)===String(id));
      if(i>=0){ items[i].cantidad = (items[i].cantidad||0) + (+cantidad||1); }
      else { items.push({id, nombre, precio:+precio||0, cantidad:+cantidad||1, imagen}); }
      Cart.set(items);
    },
    remove(id){
      const items = Cart.get().filter(x => String(x.id)!==String(id));
      Cart.set(items);
    },
    clear(){ Cart.set([]); },
    total(){ return Cart.get().reduce((a,b)=>a + (+b.precio||0)*(+b.cantidad||0), 0); },
    count(){ return Cart.get().reduce((a,b)=>a + (+b.cantidad||0), 0); },
    toText(){
      const lines = Cart.get().map(i => `• ${i.nombre} x${i.cantidad} — ${money(i.precio)} c/u`);
      lines.push(`Total: ${money(Cart.total())}`);
      return lines.join('\n');
    },
    refreshUI(){
      // badge
      $$( '[data-cart-badge]' ).forEach(el => { el.textContent = Cart.count(); });
      // mini lista
      $$( '[data-cart-list]' ).forEach(root => {
        root.innerHTML = '';
        Cart.get().forEach(i => {
          const li = document.createElement('div');
          li.textContent = `${i.nombre} x${i.cantidad} — ${money(i.precio)}`;
          root.appendChild(li);
        });
        const t = document.createElement('div');
        t.style.marginTop='6px';
        t.style.fontWeight='700';
        t.textContent = `Total: ${money(Cart.total())}`;
        root.appendChild(t);
      });
    }
  };

  // Clicks en "Agregar al carrito"
  document.addEventListener('click', (ev)=>{
    const btn = ev.target.closest('[data-add-to-cart]');
    if(!btn) return;
    ev.preventDefault();
    const id = btn.dataset.id || btn.getAttribute('data-id') || crypto.randomUUID();
    const nombre = btn.dataset.nombre || btn.getAttribute('data-nombre') || 'Producto';
    const precio = btn.dataset.precio || btn.getAttribute('data-precio') || 0;
    const cantidad = btn.dataset.cantidad || btn.getAttribute('data-cantidad') || 1;
    const imagen = btn.dataset.imagen || '';
    Cart.add({id, nombre, precio, cantidad, imagen});
    if (!btn.dataset.noToast) {
      // micro toast
      const t = document.createElement('div');
      t.textContent = 'Agregado al carrito';
      t.style.position='fixed'; t.style.bottom='16px'; t.style.right='16px';
      t.style.background='#111'; t.style.color='#fff'; t.style.padding='10px 12px';
      t.style.borderRadius='10px'; t.style.boxShadow='0 6px 24px rgba(0,0,0,.25)';
      document.body.appendChild(t); setTimeout(()=>t.remove(), 1200);
    }
  });

  async function postJSON(url, data){
    const r = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(data)
    });
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }

  async function sendOrder() {
    const nombre = $('#cart-nombre')?.value?.trim();
    const telefono = $('#cart-telefono')?.value?.trim();
    const direccion = $('#cart-direccion')?.value?.trim();
    if(!nombre || !telefono || !direccion) {
      alert('Completar Nombre, WhatsApp y Dirección'); return;
    }
    const items = Cart.get();
    if(items.length===0){ alert('El carrito está vacío'); return; }

    const payload = {
      origen: { host: location.host, path: location.pathname, title: document.title },
      contacto: { nombre, telefono, direccion },
      items: items.map(i => ({ producto: i.nombre, cantidad: i.cantidad, precio_unitario: i.precio, sku: i.id })),
      // Campos compatibles con /public/pedidos del backend existente
      pedido: {
        estado: 'pendiente',
        metodo_pago: 'efectivo',
        monto: Cart.total()
      }
    };

    try {
      const res = await postJSON((apiBase || '') + '/public/pedidos', payload);
      Cart.clear();
      // Redirigimos a tracking si viene
      if (res && res.tracking_url) {
        location.href = res.tracking_url;
        return;
      }
      alert('Pedido enviado. ¡Gracias!');
    } catch (e) {
      console.warn('Fallo POST /public/pedidos, intentamos WhatsApp...', e);
      // Fallback: armar mensaje de WhatsApp
      const target = (window.MultiEmpresas && window.MultiEmpresas.waTarget) || '';
      const msg = encodeURIComponent(`Nuevo pedido desde ${location.hostname}\nCliente: ${nombre}\nTel: ${telefono}\nDir: ${direccion}\n\n${Cart.toText()}`);
      if (target) {
        location.href = `https://wa.me/${target}?text=${msg}`;
      } else {
        alert('No se pudo enviar el pedido. Podés escribirnos por WhatsApp con el detalle:\n\n' + decodeURIComponent(msg));
      }
    }
  }

  document.addEventListener('click', (ev)=>{
    const btn = ev.target.closest('[data-cart-submit]');
    if(!btn) return;
    ev.preventDefault();
    sendOrder();
  });

  // Exponemos API mínima
  window.SimpleCart = {
    add: Cart.add,
    remove: Cart.remove,
    clear: Cart.clear,
    items: Cart.get,
    total: Cart.total,
    count: Cart.count,
    sendOrder,
    refresh: Cart.refreshUI,
  };

  // Primera carga
  Cart.refreshUI();
})();