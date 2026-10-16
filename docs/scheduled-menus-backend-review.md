# Revisión focalizada backend de menús programados

> Registro de una revisión intermedia. Sus pendientes de canal, barrera, históricos/descuentos e integración de navegador fueron resueltos y verificados posteriormente. El estado final y los límites de la suite amplia están en `docs/menus-programados-verificacion.md`; este documento conserva la evidencia histórica, no una lista vigente de bloqueantes.

## Correcciones reproducidas RED → GREEN

- Confirmación nueva sin `fecha_entrega`: resolver hoy en zona de empresa. El hash guarda la fecha efectiva; replay sin fecha al día siguiente utiliza la fecha ya comprometida, no el nuevo hoy. Misma fecha explícita reproduce; otra fecha/composición da conflicto.
- `PUT /api/menu/config`: revalidar licencia bajo bloqueo de empresa dentro de la misma transacción; se mantiene bypass super existente, identidad/rol/tenant canónicos y separación de `config_operativa`/`config_entrega`.
- Fecha explícita con flag de aplicación apagado: rechazar antes de SQL/efectos legacy. Empresa con menú apagado tampoco acepta fecha explícita aunque retenga `advance_enabled=true`.
- Visibilidad comercial de productos programados: comprobar `mostrar_en_catalogo`/`mostrar_en_landing` en filtrado público, incluso `scope=all`, y en ítems manuales de confirmación. Los IDs manuales se capturan antes de promociones/premios; regalos físicos del servidor siguen pasando calendario/cupo sin exigir visibilidad comercial.
- Logística: el lead time usa reloj fresco después de lecturas potencialmente bloqueantes, igual que calendario/ventana.
- Historial público: el endpoint real es `src/routes/publicClientApp.js` `/orders`. Ahora proyecta fecha programada/estimada con flag activo, preserva tenant+perfil y no consulta columnas nuevas con flag apagado.
- Orden de locks: `lockMenuWriteBarrier` al inicio de transacción de confirmación pública, configuración PUT y CRUD de productos, antes de namespaces y filas, alineado con la barrera global de los triggers. No toca contadores desde aplicación.

## Cobertura real adicional

- Replay de COMMIT con ACK perdido: primera respuesta 503 `TRANSACTION_OUTCOME_UNKNOWN`, replay encuentra una orden/reserva, no duplica notificaciones. La política existente deja cero notificaciones en ese caso; no se modificó.
- PostgreSQL desechable para confirmación, promoción/regalo oculto, cupo último concurrente, autorización/licencia, historial y persistencia de productos.
- Se conservan pruebas de composición final, cierre tras escrituras, rechazo de writers WhatsApp/juegos sin fecha y mutaciones canónicas.

## Hallazgos que requieren integración del padre/core

1. **Canal original no persistido**: `pedidos` sólo tiene fecha/hash, no canal. `validatePersistedMenuOrder` sigue usando catálogo por defecto; editar/aumentar/reabrir una orden landing puede evaluarse con reglas incorrectas. Agregar `menu_channel` nullable validado catalog/landing en migración+initDb (no propiedad de este revisor), escribirlo en confirmación y usarlo en evaluador de persistidos, con fixture real por canal. Un hash opaco no recupera el canal.
2. **Resto de escritores**: la adquisición temprana de barrera está integrada en confirmación/config/productos. Revisar entrypoints de pedidos, ítems, WhatsApp/juegos y cualquier otro writer de las cuatro tablas antes de namespaces/row locks para evitar abortos transitorios por inversión de locks. Los triggers mantienen seguridad/cupo, pero un aborto no equivale a éxito operativo.
3. Triggers de históricos sin fecha, descuentos contables null-ID y validación SQL amplia corresponden al revisor core; no se modificaron esquema ni initDb aquí.
4. No se verificaron navegador+PG montado ni integración completa de frontend; corresponden al padre.

## Verificación y observaciones de harness

Node usado: `/home/lemac/.nvm/versions/node/v22.22.0/bin/node`.

Logs de ejecución bajo `/home/lemac/.hermes/cache/scratch/`:

- `menu-backend-final.log`: suite backend focalizada.
- `menu-legacy-final.log`: idempotencia, identidad producto/PostgreSQL, validación de ruta y OTP legacy.
- `menu-backend-regression.log`: ejecución ampliada inicial, con un arranque transitorio fallido de `pg_ctl` (corrida serial posterior elimina esa interferencia) y el snapshot de fecha legacy señalado abajo.
- `menu-head-probe.log`: misma falla del snapshot con `publicLegacyCreatePedido.js` exacto de HEAD en árbol scratch aislado; prueba preexistencia.

`tests/public-create-pedido-success.test.js` espera `Jueves 8` pero usa reloj vivo; devuelve `Jueves 15`. Reproducido contra HEAD, no modificado ni debilitado. El resto de ese archivo pasa. Los stubs SMS de confirmación imprimen `SMS.NOTIFY.ERROR status n/a`; son avisos del harness, no envíos reales. No se alteró política de notificaciones.

Sin consultas a DB configurada/productiva, sin cambios de `.env`, schema/initDb, frontend, `landingRoutes`, grants de agentes ni despliegue.
