# Dashboard: Google Maps y reapertura de cancelados

Pantalla: `/pedidos/dashboard.html`.

## Mapa de ubicación

Se reemplaza Leaflet/OpenStreetMap en el modal de ubicación por Google Maps y `AdvancedMarkerElement` arrastrable. El SDK se carga solo al abrir el mapa. Se mantienen clic para colocar el pin, geocodificación backend existente y guardado explícito del punto de entrega. Ni arrastrar ni geocodificar guardan automáticamente.

`GET /api/pedidos/maps-config` requiere autenticación real y rol canónico `admin` o `super`. Solo devuelve `GOOGLE_MAPS_BROWSER_API_KEY` y `GOOGLE_MAPS_MAP_ID` opcional (por defecto `DEMO_MAP_ID`), con `Cache-Control: no-store`. No usa como alternativa ni devuelve `GOOGLE_MAPS_API_KEY`.

Si falta configuración o Google rechaza la clave se muestra un error en español y se deshabilitan las acciones del mapa; el dashboard continúa funcionando. No hay fallback OSM. Al cambiar el tamaño del modal se mantiene el pin seleccionado visible sin perder el zoom. Las acciones del modal permanecen dentro de la pantalla móvil y el cuerpo tiene scroll independiente.

Las respuestas de geocodificación de una apertura anterior no pueden sobrescribir las coordenadas de otro pedido. Se corrige también la recarga después de guardar: se invoca `initLoad()` en lugar de la función inexistente `reload()`.

## Reapertura

El selector del modal permite exclusivamente **Cancelado → Pendiente** a Admin y Superadministrador. Se conservan las correcciones administrativas existentes de método de pago, chofer y zona. Los ítems y la empresa siguen protegidos durante la reapertura. Los pedidos Entregados siguen sin poder reabrirse; no se habilitan saltos de Cancelado a En ruta o Entregado.

El backend conserva la validación de actor canónico activo y tenant bajo locks transaccionales. El admin solo puede reabrir pedidos de su empresa; `super` conserva el alcance global existente. No se alteran roles ni datos de pedidos existentes mediante migraciones.

El cambio de estado emite la notificación existente después de confirmar la transacción. No ejecuta efectos exclusivos de entrega: puntos, comisiones ni marketing postentrega. Un reintento con estado ya Pendiente no vuelve a notificar.

## Verificación

```bash
NODE_ENV=test node --test tests/dashboard*.test.js tests/pedidos-finalized-admin-corrections.test.js tests/pedidos-reopen-cancelled-postgres.test.js tests/pedidos-update-security.test.js
node tests/support/dashboard-google-live-smoke.mjs
```

Las pruebas de PostgreSQL usan una instancia aislada y registros sintéticos, nunca la base configurada en `.env`. Las pruebas UI usan el HTML real con respuestas de negocio sintéticas y un double Google identificado como tal.

El smoke opt-in utiliza el SDK y cartografía Google reales, por lo que puede consumir cargas. Usa exclusivamente la clave browser del `.env` local y el origen permitido `https://www.pedivoy.com`; intercepta todas las solicitudes de la aplicación hacia fixtures locales antes de navegar. No consulta ni escribe en el servidor o la base de producción. Comprueba carga de cartografía, clic real, arrastre con mouse real, guardado contra fixture y diseño móvil/escritorio. Esto valida la integración y la autorización de la clave local, no la configuración Environment ni el despliegue de Render.

Los archivos nuevos de `tests/support/` están excluidos por la regla general del checkout; al publicar este cambio deben incluirse explícitamente con `git add -f -- tests/support/dashboard-google-fixture.mjs tests/support/dashboard-google-live-smoke.mjs`.
