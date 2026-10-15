# Google Maps — Clientes

Pantalla: `/pedidos/inicio/clientes.html`.

## Integración

- SDK Google cargado al abrir el formulario de cliente, con `AdvancedMarkerElement` arrastrable.
- Configuración `GET /api/clientes/maps-config` con autenticación real, rol canónico `admin`/`super` y `Cache-Control: no-store`.
- Solo se devuelve `GOOGLE_MAPS_BROWSER_API_KEY` y `GOOGLE_MAPS_MAP_ID` opcional (`DEMO_MAP_ID` por defecto). No se usa ni expone como alternativa la clave backend `GOOGLE_MAPS_API_KEY`.
- Se conservan clic para colocar pin, edición manual de coordenadas, GPS, búsqueda de dirección y CRUD de clientes. No se cambian los permisos ni las consultas de negocio.
- Se conserva el comportamiento de búsqueda de dirección: para clientes existentes guarda automáticamente el pin y la zona; para clientes nuevos exige guardar el formulario. Arrastrar, hacer clic o usar GPS no guarda automáticamente.
- Al abrir otro cliente o cambiar el contexto del formulario, las respuestas tardías de GPS/geocodificación no pueden escribir coordenadas o guardar un pin contra el cliente equivocado.
- No se dibujan posiciones vacías, fuera de rango ni el marcador artificial `(0,0)`.
- Un error del mapa muestra un aviso en español y deshabilita sus acciones; el formulario de datos continúa disponible. No hay fallback OSM/CARTO.
- Un `ResizeObserver` mantiene visible el pin seleccionado al cambiar el tamaño. El mapa deja visibles sus controles y atribución.

## Pruebas

```bash
NODE_ENV=test node --test tests/clientes-google-map.test.js tests/clientes-maps-config.test.js tests/clientes-route.test.js tests/p0-backoffice-authorization.test.js tests/delivery-point-address-normalization.test.js tests/delivery-point-writers-structure.test.js tests/dashboard-maps-config.test.js tests/dashboard-location-pin.test.js
node tests/support/clientes-google-live-smoke.mjs
```

La prueba UI carga el HTML real con registros sintéticos y un double del SDK. Cubre nuevo/editar, clic, arrastre, coordenadas manuales, GPS simulado, geocodificación con guardado del pin existente, guardado del cliente nuevo, respuestas tardías, Superadministrador y errores de configuración/autorización.

El smoke opt-in carga cartografía y SDK Google reales (puede consumir cargas). Usa únicamente la clave browser del `.env` local. Antes de navegar al origen permitido `https://www.pedivoy.com`, intercepta todas las solicitudes de aplicación y las atiende contra HTML/APIs locales con clientes sintéticos. No consulta ni modifica el servidor o la base productiva, ni verifica las variables Environment de Render. Comprueba clic y arrastre reales con mouse, guardado contra fixture y diseño móvil/escritorio.

Verificación ampliada: `tests/delivery-point-global-concurrency-postgres.test.js` no pudo completarse porque su fixture de `productos` carece de la columna `precio` requerida por el flujo de pedidos públicos. No se modificó ese test ni código ajeno a esta integración.

Al publicar deben incluirse los nuevos helpers ignorados por la regla general de `tests/support/`:

```bash
git add -f -- tests/support/clientes-google-fixture.mjs tests/support/clientes-google-live-smoke.mjs
```
