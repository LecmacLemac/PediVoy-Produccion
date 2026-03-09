# Auditoría Operativa — PediVoy (2026-03-09)

## Resumen ejecutivo
- Estado técnico general: **estable** (tests pasan).
- Riesgo principal: **señal operativa incompleta por ausencia de datos** (tesorería/compras/incidencias/CRM en varios cortes).
- Riesgo de entorno: `engines.node=20.x` vs runtime actual `22.x`.

## Evidencia rápida
- `npm test` → 12/12 OK.
- `scripts/check-node.js` falla en Node 22 (espera 20).
- Smoke security requiere app levantada (`http://127.0.0.1:3000`).

## Prioridades inmediatas (72h)
1. **Entorno QA consistente**
   - Correr con Node 20.x o usar `ALLOW_NODE_MISMATCH=1` solo para diagnóstico local temporal.
2. **Visibilidad de datos operativos**
   - Ejecutar `npm run ops:data-health` por empresa y corregir tablas en 0.
3. **Cierre diario obligatorio**
   - Ejecutivo + Tesorería + Compras + Incidencias con checklist de cierre.

## Mejoras para expansión (30-90 días)
1. Packs verticales vendibles (B2B distribuidora, gastronomía, farmacia barrial).
2. Onboarding guiado por rubro (catálogo demo + prompts + KPI objetivo).
3. KPI de activación trial (`primer pedido < 30 min`) y conversión semanal.
4. Alertas automáticas “sin datos” para evitar falsos verdes.
5. Pipeline comercial con disciplina diaria (`próxima acción` obligatoria).

## Comandos operativos
```bash
# Salud de datos operativos (global)
npm run ops:data-health

# Salud por empresa
node scripts/ops-data-health.js <empresa_id>
```
