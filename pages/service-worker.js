/* Service Worker for push notifications */
self.addEventListener('push', function(event) {
  const payload = event.data.json();
  if (payload && payload.body) {
    const notification = new Notification('New Ad', {
      body: payload.body,
      icon: '/icon.png',
      vibrate: [200, 400, 600]
    });
  }
});

self.addEventListener('notificationclick', function(event) {
  event.waitUntil(
    clients.matchAll({type: 'window'}).then(clients => {
      const client = clients[0];
      if (client) client.focus();
      return client.show();
    })
  );
});