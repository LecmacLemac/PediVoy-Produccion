# Modularización (estado actual)

## Objetivo
Reducir acople de `server.js`/`backend.js`, mover responsabilidades a módulos y dejar el arranque más simple.

## Qué cambió

### 1) Bootstrap/arranque
- `server.js` ahora es mínimo (env + deps + createApp + start).
- Nuevo pipeline en `src/bootstrap/`:
  - `env.js` (`getServerEnv`, `assertProductionEnv`)
  - `startServer.js`
  - `createDomainDeps.js`
  - `createWppDeps.js`
  - `createServerDeps.js`
  - `index.js` (barrel exports)

### 2) Core auth/multi-tenant
`src/services.js` quedó como capa de compatibilidad (re-exports).
La lógica real se movió a:
- `src/core/auth.js`
- `src/core/tenant.js`
- `src/core/licencias.js`
- `src/core/geo.js`
- `src/core/format.js`
- `src/services/messaging.js`

### 3) Montaje de rutas
- `src/routes/mountApiModules.js` centraliza el montaje de módulos API.
- `src/app.js` quedó como wiring claro (middlewares base + static + mount API + WPP).

### 4) Extracción de público legacy
Se migraron endpoints públicos de `backend.js` a routers dedicados:
- `src/routes/publicLegacyCatalog.js`
  - `/public/config`
  - `/public/empresa`
  - `/public/productos`
  - `/public/contacto`
  - `/public/ultimo-pedido`
- `src/routes/publicLegacyPedidos.js`
  - `/public/pedido-chofer-wpp`
  - `/public/pedido-estado`
  - `/public/push/vapid-key`
  - `/public/push/subscribe`
  - `/public/push/unsubscribe`
- `src/routes/publicLegacyMarketplace.js`
  - `/public/marketplace`
- `src/routes/publicLegacyCreatePedido.js`
  - `/public/pedidos`

### 5) Backend legacy reducido
`backend.js` ahora contiene solo funciones de soporte activo:
- `notifyEstadoPedidoPush`
- `notifyByPedido`
- `pointInAnyZone`
- `getEmpresaById`

Se eliminó el bloque masivo de rutas legacy (antes `registerOrderRoutes`).

## Recomendación siguiente
- Renombrar routers `publicLegacy*` a nombres definitivos (`publicCatalog`, `publicPedidos`, etc.) una vez estabilizado.
- Agregar tests de smoke para endpoints públicos críticos (`/public/pedidos`, `/public/config`, `/public/pedido-estado`).
