# Piloto Google Maps — repartidor

Alcance: solo `/pedidos/repartidor.html`. Los demás mapas no cambian.

## Configuración

- `GOOGLE_MAPS_BROWSER_API_KEY`: clave dedicada al navegador. El endpoint autenticado `/api/repartidor/maps-config` la entrega exclusivamente a un repartidor válido. La clave es visible en el navegador por diseño: restringirla a los dominios permitidos y a Maps JavaScript API en Google Cloud antes de publicar.
- `GOOGLE_MAPS_API_KEY`: sigue siendo la clave backend para geocodificación. **No se usa como fallback público**.
- `GOOGLE_MAPS_MAP_ID`: ID de mapa opcional. El piloto usa `DEMO_MAP_ID` si no está configurado; crear un ID propio antes del uso definitivo.

Reiniciar el proceso luego de configurar variables. Render usa su propia configuración de Environment; un `.env` local no configura producción.

Si falta la clave de navegador, la pantalla muestra un mensaje en español. No hay fallback automático a OpenStreetMap.

## Pruebas sin base de producción

```bash
NODE_ENV=test node --test tests/repartidor-google-map.test.js tests/repartidor-maps-config.test.js tests/repartidor-mapa-popup.test.js tests/repartidor-ux-operativa.test.js tests/repartidor-exact-role-guard.test.js
```

Prueba opt-in que realiza una carga real (puede generar consumo de Google):

```bash
node tests/support/repartidor-google-live-smoke.mjs
```

El smoke sirve HTML y scripts reales de la pantalla en un servidor local aislado. Solo reemplaza el arranque de datos de producción; usa identidad y pedidos sintéticos explícitos, middleware real de autenticación y SDK real de Google. Nunca inicia la aplicación completa ni consulta/modifica la base del negocio.

Para esta comprobación local aislada, el smoke puede tomar temporalmente `GOOGLE_MAPS_API_KEY` del `.env` si no hay una browser key; solo la mantiene en memoria y la entrega al navegador local de prueba. **El código productivo no tiene ese fallback**. No escribe credenciales, no modifica `.env` ni registra URLs con claves.

Verifica cargas del mapa, errores de autorización, popup con acciones, filtros operativos e histórico, marcador GPS/precisión/centrado y cambio de tamaño móvil. GPS usa coordenadas sintéticas, no verifica hardware ni permisos de un teléfono real. No ejecuta Iniciar ruta ni envía mensajes a clientes.

Screenshot guardado en el directorio scratch como `repartidor-google-piloto.png`, con datos de prueba.
