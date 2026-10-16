# Menú del día y pedidos anticipados — Implementation Plan

> Ejecución local completada y verificada. Este es el plan original; el contrato definitivo está en `docs/scheduled-menus-contract.md`, la operación en `docs/menus-programados.md` y los resultados finales en `docs/menus-programados-verificacion.md`. No implica publicación ni activación productiva.

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Permitir que una empresa programe los productos visibles para hoy y habilite pedidos anticipados por fecha, con una sola fecha de servicio por carrito y validación autoritativa de horarios/cupos al confirmar.

**Architecture:** Una política compartida de disponibilidad evalúa fecha de servicio, ventanas de venta, canal, excepciones y configuración de empresa. La publicación no modifica las casillas manuales mediante cron: catálogo y checkout consultan la misma política. Los límites de producción se verifican transaccionalmente; las rutas administrativas y alternativas no deben eludir las reservas. Los productos sin programación mantienen su contrato anterior.

**Tech Stack:** Node.js 22, Express, PostgreSQL, JavaScript de navegador, Node test runner y Chromium/Puppeteer con fixtures sintéticos.

---

## Reglas de producto acordadas

- Vista inicial: **Menú de hoy**. Empresa puede habilitar carta futura y definir horizonte de anticipación.
- Un producto puede seguir **Siempre disponible**, tener recurrencia **Semanal** o **Fechas específicas**.
- Programación de App Catálogo y Web Landing, reutilizable o diferenciada por canal.
- Apertura y cierre de pedidos relativos al día de servicio; zona horaria de empresa, inicialmente Argentina.
- Excepciones por fecha: pausa y, si corresponde, cupo excepcional. No modificar la semana completa por una excepción puntual.
- Cupo opcional por producto y fecha, compartido entre canales. La confirmación debe serializar reservas y evitar sobreventa concurrente.
- Carrito y pedido tienen una única fecha de entrega/retiro; cambiarla requiere confirmación/revalidación de productos. Mostrar fecha en carrito, confirmación y seguimiento.
- Una solicitud con carrito viejo no puede comprar un producto fuera de horario ni superar el cupo. Cancelación libera capacidad y reapertura debe recuperarla sin superar el límite.
- Preservar promociones, stock/retornables, precio canónico, aislamiento empresarial, identidad del punto de entrega e idempotencia existentes.
- La programación no implica notificar clientes automáticamente, aprobar pagos ni desplegar.

## Gate de arquitectura (antes de distribuir implementación)

1. Inventariar rutas reales de catálogo y creación, edición/cancelación/reapertura de pedidos. Trazar `fecha_entrega_estimada` y `items_pedido`.
2. Inventariar el checkout canónico y las landings, incluidas plantillas y archivos generados con modificaciones previas ajenas.
3. Fijar un único contrato de fechas/configuración/errores para todos los implementadores; documentarlo en este plan antes de integrar.
4. Definir cómo preservar consumidores legacy y cómo cubrir cuota en rutas alternativas, sin presentar la ocultación del frontend como seguridad.

## Task 1 — Política pura y validación

**Files:** crear módulo compartido bajo `src/` y tests `tests/menu-availability-policy.test.js`.

- Escribir prueba roja con reloj inyectado para producto sin programación, semanal, fecha específica y canal deshabilitado.
- Implementar normalización estricta: fechas reales, horarios, días, horizon, timezone y cantidades/cupos válidos; rechazar payload ambiguo.
- Probar apertura/cierre exactos, día local distinto de UTC, excepciones, pausa y anticipación apagada.
- Exponer funciones puras reutilizables por catálogo y checkout; no acceder a red/DB ni hacer DDL al importar.
- Ejecutar prueba verde con Node 22.

## Task 2 — Esquema y migración explícita

**Files:** crear esquema standalone y runner `scripts/init-menu-availability.js`; integrar bloque equivalente en `initDb.sql` preservando CRLF y transacciones.

- Prueba roja contra PostgreSQL desechable de esquema ausente, doble aplicación y ausencia de alteraciones a registros legacy.
- Configuración de empresa y producto versionada con defaults neutrales. Almacenamiento y constraints de reserva según arquitectura elegida.
- Migración transaccional, idempotente, nombres cualificados, lock de migración y sin DDL agregado a requests/imports.
- Mantener la función deshabilitada por defecto hasta migración explícita y activación autorizada.
- Probar concurrencia, cancelación/reapertura y restricciones tenant cuando corresponda.

## Task 3 — Administración de empresa y productos

**Files:** `src/routes/productos.js`, `src/routes/empresas.js` o módulo de configuración montado bajo autorización canónica; `pedidos/inicio/producto.html`, `pedidos/inicio/empresa.html`.

- Prueba roja de permisos y alcance por empresa antes de guardar configuración.
- Editor semanal/fechas, apertura/cierre, canales y cupo opcional; excepciones y pausa por fecha.
- Preferencias de empresa para habilitar anticipación y horizonte.
- Vista previa y estados comprensibles; producto sin programación conserva formulario/visibilidad actual.
- Probar formulario real en móvil/escritorio, validación, guardado/recarga y rechazo de empresa ajena.

## Task 4 — Catálogo por fecha

**Files:** `src/routes/publicLegacyCatalog.js`, `src/routes/publicLanding.js`, demás fuentes canónicas detectadas; módulo de política compartido.

- Prueba roja de menú de hoy y fecha futura seleccionada, timezone y aislamiento tenant.
- Aplicar política en servidor, con caché que no prolongue visibilidad más allá del cambio horario.
- Metadatos mínimos para selector de fecha/horizonte; no exponer configuración interna ni datos privados.
- No dejar una ruta pública alternativa que liste el producto programado ignorando su disponibilidad.

## Task 5 — Confirmación autoritativa y capacidad

**Files:** `src/routes/publicLegacyCreatePedido.js`, rutas canónicas alternativas identificadas en auditoría y módulo transaccional de disponibilidad.

- Pruebas rojas de payload forjado, producto fuera de horario, fecha mixta, empresa ajena y pedidos concurrentes que compiten por el último cupo.
- Normalizar la fecha seleccionada y validarla con entrega de empresa/zona. Reutilizar la fecha existente cuando corresponda, sin confundir compra con servicio.
- Revalidar productos/precios con locks coherentes y confirmar reserva dentro de la misma transacción del pedido.
- Reintento idempotente no duplica cupo; cancelación/reapertura y edición no generan sobreventa ni reservas huérfanas.
- Mantener efectos externos fuera de reintentos transaccionales nuevos; no fabricar respuestas exitosas ante resultado ambiguo.

## Task 6 — Experiencia pública y confirmación

**Files:** `pedidos/index.html`, catálogo público real y consumidores landing identificados; preferir módulos compartidos y no sobrescribir páginas con cambios ajenos.

- Selector accesible **Hoy / Pedir para otro día** sólo cuando la empresa lo habilite.
- Fecha seleccionada vinculada al carrito y al envío; confirmar cambio con productos cargados, preservar el carrito ante fallo de red y descartar respuestas tardías.
- Mostrar fechas de servicio sin interpretarlas como UTC; manejar agotado/cierre al confirmar y permitir al cliente corregir el carrito.
- Prueba navegador con HTML real para hoy/futuro, cambio de fecha, móvil, carrito y confirmación; sin enviar pedidos reales.

## Task 7 — Gate de cierre

- Integración real: editor -> router auth -> PostgreSQL desechable -> catálogo por fecha -> carrito -> creación -> reserva -> confirmación.
- Batería legacy de productos, catálogo, pedidos, precios, tenant, stock, idempotencia y mutaciones; inventario y contratos conservados.
- Revisión independiente de cumplimiento y seguridad. Corregir hallazgos con prueba roja y reejecutar.
- Verificar sintaxis, diff y distribución de archivos nuevos. Documentar operación, migración, rollback y límites reales.
- No declarar terminado con componentes aislados sin integración en las pantallas. Informar código local, publicación y despliegue por separado.
- Sin commit/push ni migración productiva hasta solicitud explícita del usuario.
