# Google Maps en Telemetría de Marketing

Pantalla: `/pedidos/inicio/marketing-telemetria.html`.

## Configuración y acceso

- La vista conserva su alcance exclusivo de **superadministrador**.
- `GET /api/setup/marketing/maps-config` usa la autenticación canónica y el rol vigente, no sólo los claims del token.
- Devuelve únicamente `{ ok, apiKey, mapId }`, con `Cache-Control: no-store`.
- La clave proviene exclusivamente de `GOOGLE_MAPS_BROWSER_API_KEY`. Nunca se utiliza `GOOGLE_MAPS_API_KEY`, reservada al backend, como alternativa.
- Restringir la clave por sitios web autorizados y a **Maps JavaScript API** en Google Cloud. Una clave de navegador es observable por sus usuarios; la protección son sus restricciones, no ocultarla en la interfaz.
- `GOOGLE_MAPS_MAP_ID` permite configurar el ID propio del mapa. Sin él se utiliza `DEMO_MAP_ID`, como en los otros mapas del proyecto. Para configuración productiva definitiva, usar un ID propio.
- No se necesitan migraciones de base de datos para este cambio.

## Alcance funcional

La migración cambia la representación del mapa, no las APIs de marketing, tracking, costos ni el envío de mensajes. Mantiene la distinción de clientes con/sin conversión, repartidores y selección de un envío desde la tabla.

La conexión visual al repartidor más cercano representa una **línea recta con distancia geográfica**, no una ruta vial ni un tiempo estimado de entrega. No se agrega Directions, Routes ni geocodificación.

Las actualizaciones pasivas deben preservar la cámara. El cambio de empresa descarta los datos y marcadores de la empresa anterior; las respuestas y operaciones diferidas deben validarse contra el contexto seleccionado antes de dibujar.

Un error de configuración o de carga de Google Maps debe mostrar un aviso en español sin impedir consultar tablas e indicadores. No debe activar una base cartográfica alternativa silenciosamente.

## Verificación y publicación

- Probar el endpoint con autenticación real e identidades sintéticas; verificar rechazo de otros roles, baja, claims obsoletos, ausencia de clave y ausencia de fallback al secreto backend.
- Probar la pantalla real con APIs sintéticas y dobles del SDK, separando esa evidencia de una carga real de Google Maps.
- La comprobación optativa del SDK real debe usar exclusivamente la clave de navegador, un origen autorizado y datos sintéticos interceptados; nunca escribir pedidos, clientes o mensajes productivos.
- Publicar y desplegar son autorizaciones separadas. Los cambios locales no equivalen a una función ya disponible en Render.

## Ejecución reproducible

Pruebas sintéticas sin red externa:

```sh
NODE_ENV=test node --test tests/marketing-google-map.test.js tests/marketing-telemetria-maps-config.test.js tests/marketing-setup-security.test.js
```

Smoke optativo de Google real (consume el servicio del proveedor; requiere clave de navegador local y origen autorizado):

```sh
NODE_ENV=test node tests/support/marketing-google-live-smoke.js
```

El smoke intercepta **antes de navegar** todos los recursos y APIs de PediVoy y sirve archivos locales/datos sintéticos. La configuración atraviesa el router real y autenticación super sintética. Sólo SDK y cartografía de Google usan red real. Comprueba tiles, pins, popup con distancia, cámara tras refresh, cambio de empresa, filtros y pantalla móvil. Guarda capturas bajo `$TMPDIR/marketing-google-live/`.

La selección explícita permite autopan del popup después del encuadre para mantenerlo dentro del mapa; el refresco pasivo lo deshabilita para no mover la cámara del usuario.

## Referencias oficiales

- https://developers.google.com/maps/documentation/javascript/advanced-markers/migration
- https://developers.google.com/maps/documentation/javascript/error-messages
- https://developers.google.com/maps/api-security-best-practices
