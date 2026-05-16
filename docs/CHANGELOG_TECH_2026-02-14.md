# Changelog Técnico — 2026-02-14

## Resumen
Durante esta sesión se reforzó PediVoy/Hidro en 4 ejes: **calidad**, **seguridad**, **operabilidad** y **confiabilidad transaccional**.

## Cambios por área

### 1) Calidad y testing
- Test runner real en `npm test` con `node --test`.
- Tests unitarios de helpers públicos (`toNum`, `inRange`, `round`, `normalizeText`, `buildOrderSummary`).
- Tests de rutas públicas:
  - `/public/pedidos` payload inválido.
  - `/public/pedidos` flujo válido (integración con mocks DB).
  - `/public/pedidos` rate limiting.
  - `/public/pedidos` idempotencia por `submission_id`.
  - `/public/push/subscribe` validación e inserción.
  - `/public/push/unsubscribe` baja de suscripción.

### 2) Seguridad y hardening
- Headers de seguridad globales:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy` restrictiva
- Límites de body:
  - Global `json/urlencoded`: `1mb`.
  - Guard extra para `/public/pedidos` (`413` si excede límite).
- Rate limit por IP:
  - `/public/pedidos`
  - `/public/push/*`
- Validación fuerte con Zod en endpoints críticos públicos.

### 3) Observabilidad
- `x-request-id` en requests/responses.
- Logging HTTP por request (método, URL, status, ms, reqId).
- Error logging estructurado con contexto.
- Endpoints de métricas:
  - `/api/metrics/http` (protegido)
  - `/api/metrics/alerts` (protegido)
  - `/api/metrics/prometheus` (protegido)
- Dashboard UI de observabilidad:
  - `pedidos/observabilidad.html`

### 4) Confiabilidad de pedidos
- Flujo de creación de pedido con transacción (`BEGIN/COMMIT/ROLLBACK`).
- Liberación segura de conexión en `finally`.
- Idempotencia reforzada con:
  - `pg_advisory_xact_lock` por `empresa_id + submission_id`.
  - Índice único parcial en DB: `(empresa_id, submission_id)` cuando `submission_id IS NOT NULL`.

## Commits relevantes
- `0692e23` chore(quality): add health alias, global error handler and unit tests
- `c590936` feat(observability): add request id logging and zod validation for public pedidos
- `84ea0a4` feat(public): add rate limiting, structured error logs and create-order integration tests
- `df8d704` feat(pedidos): add transactional create flow and idempotency safeguards
- `bfa5151` feat(security): add hardening headers, payload guards and HTTP metrics endpoint
- `8d8377e` feat(metrics): protect endpoints, add alerts and prometheus export
- `ff32439` feat(public-push): add validation and rate limiting plus deploy security checklist
- `d0c2ea4` test(public-push): add coverage for subscribe and unsubscribe validation flows
- `40b4b57` feat(admin): add observability dashboard page for metrics and alerts

## Legacy pendiente (audit)
Rutas legacy públicas todavía activas:
- `publicLegacyCatalog.js`
- `publicLegacyMarketplace.js`
- `publicLegacyPedidos.js`
- `publicLegacyCreatePedido.js`

Estado: **estables y endurecidas**, pero nombradas como legacy. Recomendado migrarlas gradualmente a `public*.js` sin prefijo legacy para cerrar deuda técnica semántica.
