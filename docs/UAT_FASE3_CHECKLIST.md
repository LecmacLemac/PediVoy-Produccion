# UAT rápido · Fase 3 (Ejecutivo + Incidencias)

Objetivo: validar en ~20 minutos que Fase 3 está usable para operación diaria.

## Alcance

- Tablero ejecutivo (`pedidos/inicio/ejecutivo.html`)
- Centro de incidencias (`pedidos/inicio/incidencias.html`)
- Filtros SLA, historial, quick-resolve y export CSV
- Contexto multi-tenant (admin y super admin)

---

## Preparación (3 min)

1. Tener al menos 1 empresa con datos de prueba.
2. Tener 2 usuarios en la empresa (uno admin operativo + opcional super admin).
3. Confirmar que se puede iniciar sesión en `/pedidos/login.html`.

---

## Casos UAT (12)

> Estado sugerido por caso: `OK` / `PENDIENTE` / `FALLA`.

### UAT-01 · Carga tablero ejecutivo
- **Paso:** abrir `ejecutivo.html` y presionar **Actualizar**.
- **Esperado:** se renderizan KPI, semáforo, recomendaciones, control de cierre, automatizaciones y resumen.

### UAT-02 · Checklist UAT en ejecutivo
- **Paso:** verificar bloque **Checklist UAT · Fase 3** y usar **Recalcular checklist**.
- **Esperado:** muestra resultado `X/Y checks OK` + items con estado visual (✅/❌).

### UAT-03 · Copia checklist UAT
- **Paso:** botón **Copiar checklist**.
- **Esperado:** contenido pegable en portapapeles con formato `[OK]/[PEND]`.

### UAT-04 · Carga centro de incidencias
- **Paso:** abrir `incidencias.html` y refrescar.
- **Esperado:** aparecen KPI, pendientes, alertas y bandeja sin errores.

### UAT-05 · Alta de incidencia
- **Paso:** crear incidencia con título, severidad y responsable.
- **Esperado:** aparece en bandeja, en KPIs y en historial con evento `creada`.

### UAT-06 · Edición de incidencia
- **Paso:** editar severidad/estado/responsable/vencimiento.
- **Esperado:** cambios visibles en bandeja y evento en historial (`actualizada` o `estado`).

### UAT-07 · Quick-resolve
- **Paso:** en “Mis pendientes hoy”, resolver una incidencia con botón **Resolver**.
- **Esperado:** estado pasa a `resuelta`, se actualiza KPI y se registra evento `resuelta`.

### UAT-08 · Filtros estándar
- **Paso:** combinar filtros de **Estado**, **Severidad** y **Solo mías**.
- **Esperado:** lista refleja exactamente los filtros seleccionados.

### UAT-09 · Filtro SLA en bandeja
- **Paso:** probar `Vencida`, `Vence hoy`, `En plazo`, `Sin SLA`.
- **Esperado:** resultados coherentes con columna SLA (`Vencida`, `Vence hoy`, `En plazo`, `Sin SLA`).

### UAT-10 · Export CSV (sin filtros)
- **Paso:** botón **Exportar CSV** sin filtros.
- **Esperado:** descarga archivo CSV UTF-8 con columnas esperadas y datos legibles en Excel/Sheets.

### UAT-11 · Export CSV (con filtros)
- **Paso:** aplicar filtros (incluido SLA) y exportar.
- **Esperado:** CSV respeta mismos filtros que la bandeja.

### UAT-12 · Super admin por empresa
- **Paso:** loguear como super admin, elegir empresa en selector y repetir UAT-01, UAT-04 y UAT-11.
- **Esperado:** no hay mezcla de datos entre empresas; todo responde al `empresa_id` activo.

---

## Criterio de salida

Se considera UAT aprobado si:
- 12/12 casos `OK`, o
- 10+ `OK` sin fallas críticas (multi-tenant, export, actualización/resolución de incidencias).

---

## Hallazgos (completar durante prueba)

- Fecha:
- Probador:
- Build/commit:
- Hallazgos críticos:
- Hallazgos menores:
- Decisión: `Aprobado` / `Aprobado con observaciones` / `No aprobado`
