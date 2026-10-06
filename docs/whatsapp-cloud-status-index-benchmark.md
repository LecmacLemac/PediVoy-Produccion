# Benchmark: índice normalizado de status de WhatsApp Cloud

Fecha: 2026-10-06
Motor: PostgreSQL 18.6
Dataset: 200.000 filas de `public.whatsapp_cloud_events`, repartidas entre dos tenants.

## Consulta medida

Se usó la selección productiva del CTE `status_events` de
`public.whatsapp_cloud_messages_reconcile_status_locked`, incluida la igualdad
normalizada:

```sql
BTRIM(event.message_id) = NULLIF(BTRIM('  wamid.benchmark.200000  '), '')
```

El predicado parcial fue el mismo de producción: evento `status`, estado en
`sent/delivered/read/failed` y `message_id` normalizado no vacío.

## Resultado antes/después

| Índice | Plan | Tiempo de ejecución | Buffers compartidos hit |
|---|---|---:|---:|
| Legacy `(empresa_id, message_id)` | `Gather` → `Seq Scan` | 20,018 ms | 3.150 |
| Canónico `(empresa_id, BTRIM(message_id))` | `Bitmap Heap Scan` → `Bitmap Index Scan` | 0,077 ms | 1 |

El índice canónico fue identificado explícitamente en el plan como
`whatsapp_cloud_events_status_message_idx`. El plan posterior no contiene
`Seq Scan` ni `Gather`.

## INCLUDE

`status`, `source_timestamp` y `received_at` se incluyen porque son exactamente
los valores leídos por el CTE productivo después de resolver tenant e ID
normalizado. No forman parte de la identidad de búsqueda ni del orden; por eso
son columnas `INCLUDE`, no claves del btree.

Los valores son una ejecución local reproducible del gate PostgreSQL con
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`; no constituyen un SLA.
