# Google Maps — seguimiento administrativo de choferes

Alcance: `/pedidos/inicio/choferes.html`, pestaña Tracking.

Configuración: reutiliza `GOOGLE_MAPS_BROWSER_API_KEY` y `GOOGLE_MAPS_MAP_ID` opcional (por defecto `DEMO_MAP_ID` para el piloto). No publica ni sustituye `GOOGLE_MAPS_API_KEY` del backend. Endpoint nuevo `/api/choferes/maps-config`, protegido con autenticación real y guard existente admin/super; respuesta `Cache-Control: no-store`.

Se conservan las consultas de tracking, filtros por empresa/chofer, incidentes ACK, historial y refresco de 15 segundos. El renderer mantiene camioneta, domicilio, popup y trazas de 15 posiciones recientes. El refresco no vuelve a centrar la cámara; primera carga y cambios explícitos de filtro ajustan encuadre. Al cambiar de empresa, se limpia la memoria visual de trazas. No hay fallback automático a OpenStreetMap.

Pruebas:

```bash
NODE_ENV=test node --test tests/choferes-google-map.test.js tests/choferes-maps-config.test.js tests/p0-operational-admin-security.test.js tests/tracking-route.test.js
node tests/support/choferes-google-live-smoke.mjs
```

El smoke es opt-in y genera consumo de una carga Google real. Lee exclusivamente la clave browser del `.env`; no la escribe ni muestra. Sirve configuración desde una ruta administrativa local con identidad sintética autenticada. Monta el HTML y renderer locales en un navegador sobre el origen autorizado `www.pedivoy.com`, interceptando las consultas de negocio con fixtures explícitamente sintéticos y sin escrituras en producción. Prueba SDK, mapa, marcadores, popup, traza y preservación de cámara al refrescar. No verifica los valores Environment de Render ni datos GPS reales de producción.
