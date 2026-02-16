# PediVoy Pro Expansion 90D

Fecha: 2026-02-15  
Objetivo: Expandir PediVoy desde logística/agua/soda hacia múltiples verticales (B2C y B2B) con mínima fricción de implementación.

---

## 1) North Star (qué significa crecer bien)

### Meta 90 días
- 3 nuevos verticales activos (además de agua/soda)
- 20 cuentas trial nuevas con onboarding < 48h
- Conversión trial→pago >= 25%
- Churn a 30 días < 10%

### KPI core
- TTV (time-to-value): minutos hasta primer pedido real
- Pedidos/día por empresa
- % clientes activos con recompra 30d
- Tiempo promedio de despacho
- % cobro al día

---

## 2) Verticales a atacar (orden recomendado)

## Ola 1 (rápida, alta compatibilidad)
1. Distribuidoras B2B (ferretería, limpieza, mayorista)
2. Gastronomía de cercanía (takeaway + reparto)
3. Farmacia/Boutique salud barrial (sin prescripción compleja)

## Ola 2
4. Retail local (kioscos/tiendas con delivery)
5. Insumos para oficinas y empresas

---

## 3) Producto: piezas clave para vender más sectores

## A. Packs por vertical (productización)
Cada pack incluye:
- Catálogo demo prearmado
- Prompt IA preconfigurado
- Reglas de precio/promos
- Flujo de pedido recomendado
- Dashboard con KPI relevantes del rubro

## B. Motor de reglas no-code
- Reglas por cliente, zona, cantidad, día/hora
- Promos automáticas por volumen
- Mínimo de compra configurable
- Ventanas de entrega por barrio/zona

## C. Cobranzas y cuentas corrientes
- Estado de deuda por cliente
- Alertas automáticas de vencimiento
- Reporte “a cobrar hoy/semana”
- Link de pago y conciliación simple

## D. CRM operativo
- Segmentación de clientes (activos/inactivos/riesgo)
- Campañas de reactivación
- Recordatorios automáticos de recompra

## E. Integraciones ligeras
- CSV import/export robusto
- Webhooks
- Pasarela de pago (MP ya base)
- Conector básico a facturación (fase 2)

---

## 4) Plan de ejecución por semanas

## Semanas 1-2 (Fundación comercializable)
- Definir 3 packs verticales (Ola 1)
- Crear wizard de onboarding por rubro
- Cargar plantillas de prompts por vertical
- Documentar playbook de demo comercial (15 min)

Entregables:
- `/docs/verticals/PACK_DISTRIBUIDORA_B2B.md`
- `/docs/verticals/PACK_GASTRONOMIA.md`
- `/docs/verticals/PACK_FARMACIA_BARRIO.md`

## Semanas 3-4 (Reglas + cobranzas)
- Motor de reglas MVP (precio, mínimo, zona)
- Cobranzas MVP (deuda, vencidos, alertas)
- Dashboard de dueño (3 pantallas clave)

Entregables:
- endpoints + UI admin
- smoke tests de reglas/cobranzas

## Semanas 5-6 (CRM y retención)
- Segmentador de clientes
- Campañas de reactivación por WhatsApp
- Métrica de recompra 30d y alertas de caída

## Semanas 7-8 (Go-to-market)
- Landing comercial por vertical
- Kit de ventas: demo data + caso + pricing
- Flujo trial guiado con objetivo “primer pedido en 30 min”

## Semanas 9-10 (Escala)
- Automatizar onboarding con importador CSV
- Mejorar observabilidad por empresa/vertical
- Ajustar pricing por valor generado

## Semanas 11-12 (Optimización)
- A/B de onboarding
- A/B de campañas reactivación
- Endurecer funnels trial→pago

---

## 5) Pricing y empaquetado (sugerencia)

- Starter: pedidos + WhatsApp + dashboard básico
- Growth: reglas + cobranzas + campañas
- Pro: multi-sucursal + integraciones + soporte prioritario

Upsells claros:
- setup asistido
- playbook comercial por rubro
- automatizaciones avanzadas

---

## 6) Riesgos y mitigación

Riesgo: producto muy genérico
- Mitigación: packs verticales concretos (no “todo para todos”)

Riesgo: onboarding largo
- Mitigación: wizard + importador + demo data

Riesgo: trial sin activación
- Mitigación: objetivo de activación explícito + alertas de fricción

---

## 7) Checklist de “ready to sell”

- [ ] 3 packs verticales listos y probados
- [ ] Demo de 15 min guionada
- [ ] Onboarding < 30 min con datos reales
- [ ] Cobranzas básicas funcionando
- [ ] Dashboard dueño con KPI accionables
- [ ] Smoke postdeploy y security green

---

## 8) Acciones inmediatas (próximas 72h)

1. Definir vertical #1 foco: Distribuidora B2B
2. Crear pack completo (catálogo + prompts + métricas)
3. Construir wizard simple “crear negocio por rubro”
4. Preparar 1 caso demo con números

Resultado esperado en 72h:
- Tener una oferta demostrable, repetible y vendible para un nuevo sector.
