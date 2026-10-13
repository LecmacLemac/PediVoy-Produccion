# Google Maps — seguimiento público

Pantalla: `/pedidos/seguimiento.html?t=<token>` (también acepta `token`). Reutiliza `GOOGLE_MAPS_BROWSER_API_KEY`; no usa ni publica la clave backend `GOOGLE_MAPS_API_KEY`.

La consulta `GET /api/public/tracking/:token?map_config=1` devuelve exclusivamente configuración browser después de la misma búsqueda tenant-safe y validación de TTL del seguimiento. No permite acceder mediante ID de pedido. Mantiene rate limiting, no consulta ubicación/items para obtener configuración y usa `Cache-Control: no-store`. La respuesta normal sin ese parámetro no cambia.

SDK con AdvancedMarkerElement para destino/repartidor y línea visual directa entre ambos (no es una ruta calculada ni consume Directions/Routes). Conserva estado, pago, resumen, contacto, tarjeta compacta, polling de 8 segundos, recuperación de conexión y regla existente de ocultar GPS de más de 5 minutos. No recarga ni recentra el mapa en cada consulta. La atribución Google queda arriba de la tarjeta.

Errores del mapa se muestran en español sin impedir que los datos del pedido se consulten o se vean. No hay fallback automático OpenStreetMap. Enlaces inválidos o expirados no obtienen configuración.

Pruebas:

```bash
NODE_ENV=test node --test tests/seguimiento-google-map.test.js tests/seguimiento-maps-config.test.js tests/seguimiento-public-ui.test.js tests/public-tracking-route.test.js tests/public-legacy-tracking-security.test.js tests/tracking-route.test.js
node tests/support/seguimiento-google-live-smoke.mjs
```

El smoke opt-in realiza carga Google real (posible consumo). Usa clave browser del `.env`, token/pedido/ubicaciones explícitamente sintéticos y router local real para validar capability. Monta HTML local en el origen permitido en el navegador; las solicitudes tracking se redirigen al harness local, sin modificar producción ni consultar su base. No verifica las variables Environment de Render. Guarda una captura en scratch.
