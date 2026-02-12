// Pedidos/sw.js
let __ctx = { token: null, pedido_id: null };

self.addEventListener('install', () => self.skipWaiting?.());
self.addEventListener('activate', (evt) => evt.waitUntil(self.clients.claim()));

// --- Helpers ---
async function broadcast(type, payload) {
  try {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach(c => c.postMessage({ type, payload }));
  } catch {}
}

function base64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

// --- Mensajes entrantes desde páginas ---
self.addEventListener('message', (event) => {
  const { type, token, pedido_id } = event.data || {};
  if (type === 'rememberContext') {
    __ctx = { token: token || null, pedido_id: pedido_id || null };
  }
  if (type === 'unsubscribeNow') {
    event.waitUntil((async () => {
      try {
        const sub = await self.registration.pushManager.getSubscription();
        if (sub) {
          const endpoint = sub.endpoint;
          await sub.unsubscribe();
          await fetch('/public/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint })
          });
        }
        await broadcast('PUSH_MUTED', {});
      } catch {}
    })());
  }
});

// --- Push recibido ---
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}

  const title = data.title || 'Notificación';
  const body  = data.body  || '';
  const url   = data.url   || '/Pedidos/pedido.html';
  const tag   = data.tag   || (data.pedido_id ? `pedido-${data.pedido_id}` : 'pedido');

  const options = {
    body,
    data: { url, tag, pedido_id: data.pedido_id || null },
    icon: data.icon  || '/Pedidos/img/icon-192.png',
    badge: data.badge || '/Pedidos/img/badge-72.png',
    vibrate: [80, 30, 80],
    tag,
    renotify: true,
    actions: [
      { action: 'view', title: 'Ver pedido' },
      { action: 'mute', title: 'Silenciar' }
    ]
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    await broadcast('PUSH_DELIVERED', { tag, title, body });
  })());
});

// --- Click en la notificación ---
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification?.data || {};
  const baseUrl = data.url || '/Pedidos/pedido.html';
  const pid = data.pedido_id || null;

  const withId = (() => {
    if (!pid) return baseUrl;
    try {
      const u = new URL(baseUrl, self.location.origin);
      if (!u.searchParams.has('id')) u.searchParams.set('id', String(pid));
      return u.toString();
    } catch {
      return baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'id=' + encodeURIComponent(pid);
    }
  })();

  const action = event.action;

  event.waitUntil((async () => {
    if (action === 'mute') {
      try {
        const sub = await self.registration.pushManager.getSubscription();
        if (sub) {
          const endpoint = sub.endpoint;
          await sub.unsubscribe();
          try {
            await fetch('/public/push/unsubscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ endpoint })
            });
          } catch {}
        }
        await broadcast('PUSH_MUTED', {});
      } catch {}
      return;
    }

    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) {
      try { await c.navigate(withId); await c.focus(); return; } catch {}
    }
    await self.clients.openWindow(withId);
  })());
});


// --- Cierre de notificación ---
self.addEventListener('notificationclose', (event) => {
  event.waitUntil(broadcast('PUSH_CLOSED', { tag: event.notification?.data?.tag }));
});

// --- Rotación de suscripción (renovar + registrar en backend con contexto) ---
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      // 1) Traer VAPID pública
      const r = await fetch('/public/push/vapid-key', { cache: 'no-store' });
      const j = await r.json();
      const key = (j && j.key) ? j.key : null;
      if (!key) return;

      // 2) Re-suscribir
      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToUint8Array(key)
      });

      // 3) Registrar en backend **con** el contexto recordado
      await fetch('/public/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: newSub.toJSON(), ...__ctx })
      });

      await broadcast('PUSH_RESUBSCRIBED', {});
    } catch {}
  })());
});
