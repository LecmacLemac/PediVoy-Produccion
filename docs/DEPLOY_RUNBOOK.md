# Deploy Runbook (Staging → Producción) — PediVoy/Hidro

## 0) Pre-check local
1. `npm test`
2. `npm run test:smoke:public` (si hay entorno levantado)
3. Verificar `docs/DEPLOY_SECURITY_CHECKLIST.md`

## 1) Variables y entorno
- `NODE_ENV=production`
- `JWT_SECRET` fuerte (>=32)
- `DATABASE_URL` correcta (SSL prod)
- `OPENAI_API_KEY` válida
- `VAPID_*` si Push activo
- Umbrales opcionales métricas:
  - `METRICS_ALERT_ERROR_RATE`
  - `METRICS_ALERT_P95_MS`

## 2) Deploy a staging
1. Deploy de rama candidata.
2. Verificar:
   - `/health` y `/api/health`
   - flujo de pedido en UI
   - `/api/metrics/http` (con super)
   - `/api/metrics/alerts` (con super)
3. Ejecutar smoke manual de endpoints públicos críticos.

## 3) Go/No-Go
Go a producción si:
- tests OK
- smoke OK
- sin alertas críticas (`level=high`) sostenidas
- no errores 5xx fuera de umbral esperado

## 4) Deploy a producción
1. Publicar misma build validada en staging.
2. Verificación post-deploy (primeros 10 min):
   - health endpoints
   - creación de pedido real controlado
   - métricas p95/errorRate en rangos normales

## 5) Rollback (si falla)
Disparar rollback si:
- 5xx sostenido > umbral operativo
- caída del flujo de creación de pedido
- problemas de autenticación o sesiones

Pasos:
1. Revertir a release estable previa.
2. Validar health + pedido + login.
3. Revisar métricas y logs con `reqId` para RCA.
4. Abrir incidente técnico y bloquear nuevos cambios hasta fix.

## 6) Post-mortem mínimo
- Qué se rompió
- Por qué no se detectó antes
- Qué test/alerta faltó
- Acción preventiva concreta (test, validación, monitoreo)
