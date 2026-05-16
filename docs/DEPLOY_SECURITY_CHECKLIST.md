# Deploy Security Checklist (PediVoy / Hidro)

## Antes de deploy
- [ ] `NODE_ENV=production`
- [ ] `JWT_SECRET` fuerte (>=32 chars)
- [ ] `DATABASE_URL` con SSL en producción
- [ ] `OPENAI_API_KEY` presente y rotada
- [ ] `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` configuradas (si Push activo)
- [ ] `DEBUG_*` desactivados en producción

## API pública
- [ ] Rate limit activo en `/public/pedidos`
- [ ] Rate limit activo en `/public/push/*`
- [ ] Validación de payload con Zod en endpoints críticos
- [ ] Límites de body (`json/urlencoded`) definidos

## Observabilidad
- [ ] `x-request-id` habilitado
- [ ] Endpoint de métricas protegido (`withAuth + isSuper`)
- [ ] Alertas (`/api/metrics/alerts`) revisadas
- [ ] Export Prometheus (`/api/metrics/prometheus`) integrado en monitoreo

## Datos
- [ ] Índice único de idempotencia en pedidos (`empresa_id + submission_id`)
- [ ] Backups de DB configurados y testeados
- [ ] Prueba de restore realizada recientemente

## Release
- [ ] `npm test` pasando
- [ ] Smoke público (`npm run test:smoke:public`) pasando
- [ ] Verificado `/health` y `/api/health`
- [ ] Rollback plan definido
