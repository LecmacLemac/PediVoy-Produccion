# Verificación de menús programados

## Entorno y límites

- Checkout local PediVoy. HEAD de referencia previo al trabajo: `ecb0753b85f4cc17dd86e96e37817c300815daef`.
- Node 22.23.3, Chromium y PostgreSQL desechable UTF8. Las integraciones Docker usan contenedores de prueba propios.
- Dotenv y conexión predeterminada cercados; ningún caso necesita la base instalada/productiva. Notificadores de integración sustituidos por callbacks inertes.
- Sin publicación, despliegue, activación en Render ni pedidos reales.

## Cierre focalizado final

**469/469 pruebas aprobadas**, cero fallos, cancelaciones u omisiones, en `menu-acceptance-final.tap`, ejecutadas por el parent después de las últimas correcciones. Incluye todos los tests `menu-*.test.js`, schema/runner/SQL canónico, autenticidad e inventario, transacciones, Empresa, entregas, selección/encolado WhatsApp y regresiones de checkout/identidad/recompensas.

- Cerrado el ciclo advisory/barrera: con la feature habilitada, el enqueue solicita el mismo advisory de empresa sin esperar mediante `pg_try_advisory_xact_lock`. Un resultado ocupado o malformado aborta con `40001` antes de leer configuración/escribir outbox; el dueño debe revertir y reintentar la transacción completa. El helper canónico hace reintentos acotados; un caller manual conserva su responsabilidad de rollback/reintento. No se confirma método de pago parcial ni se omite la notificación para aparentar éxito. Flag-off conserva la consulta bloqueante original.
- La carrera se reprodujo roja con PostgreSQL real y pasó después con retry canónico, rollback/retry del caller y el procesador de pago real/notificador predeterminado. Readback de cupos, reservas e ítems intacto; una notificación tras recuperación y ninguna adicional por replay.
- Cerrados ambos hallazgos de landings, con clic central/contextual y slug en mayúsculas.
- El harness de checkout espera a que el botón esté habilitado después de mostrar la dirección, antes de un `requestSubmit()` programático. Conserva todas las aserciones de bloqueo/envío único; no modifica la UI productiva para hacer pasar la prueba.

Este visto bueno es **local y del alcance verificado**. La batería amplia conserva los fallos previos documentados abajo; no equivale a activación ni a afirmar que todo el proyecto está verde.

## Resultados comprobados

### Batería integrada de menús y seguridad

**187/187 aprobadas**, sin fallos, cancelaciones ni omisiones en `menu-final-integrated.tap`.

```sh
node --test --test-concurrency=3 \
  tests/menu-*.test.js \
  tests/db-transaction.test.js \
  tests/agent-schema-migration.test.js \
  tests/agent-authority-contracts.test.js \
  tests/init-db-canonical-schema-postgres.test.js \
  tests/p0-global-mutation-inventory.test.js
```

Esta corrida precede a dos regresiones adicionales de landings y al cierre del conflicto entre locks de configuración WhatsApp y la barrera de menús. Los resultados posteriores se registran por separado; no se suman corridas superpuestas.

### Integración de extremo a extremo

`tests/menu-integration-postgres-browser.test.js` conecta los HTML reales de Web y App con los routers y el bootstrap SQL reales. Verifica:

- Hoy por defecto y selección futura; productos/tenant correctos.
- Configuración administrativa mediante **Bearer JWT sintético**, recarga canónica en DB y rechazo cross-tenant aun con claims de super falsos.
- Fecha programada y estimada persistidas, replay sin duplicación y seguimiento por capability.
- Promoción monetaria como línea contable sin consumir producción extra; agotamiento sin nueva notificación.
- Cupo decimal 0.3 consumido por cantidades 0.1 + 0.2 y replay con cantidad agrupada 0.3.

**Caso aprobado después de añadir la comprobación decimal real.** La sesión de cliente App es un fixture explícito: no prueba OTP real. No se prueba entrega real de WhatsApp. Capturas sintéticas en scratch: `menu-scheduled-integration/web-desktop.png` y `app-mobile.png`.

### Landings: hallazgos independientes corregidos

- Slug aceptado en mayúsculas conserva fecha/canal en productos y enlaces.
- Metadatos fallidos bloquean compra también mediante clic central y menú contextual.
- Contexto de otra empresa no se modifica; error ofrece reintento/cambio explícito a hoy.
- Vista previa conserva sandbox opaco, snapshots offline y protección de tenant/generación.

**9/9 aprobadas**, sin omisiones, en `menu-landing-review-fixed.tap`, incluyendo la integración real PostgreSQL/navegador y regresión del editor Web.

### Transacciones y decimales

- **188/188 aprobadas** en `menu-manual-transactions.tap`: DB, empresa, configuración WhatsApp, entrega y selección de pago, incluyendo barrera antes del callback/row lock y default-off.
- **68/68 aprobadas** en `menu-decimal-regression.tap`: política, cantidades decimales y UI pública. Aritmética en base decimal, sin epsilon.
- La revisión independiente reprodujo posteriormente un ciclo advisory/barrera entre guardado de configuración y notificación transaccional. Sus pruebas positivas previas no cubrían ese ciclo; no se consideran aprobación final de ese hallazgo.

### Pruebas antiguas estabilizadas sin cambios de producción

**41/41 aprobadas** tanto sobre el HEAD original como sobre el checkout actual tras corregir fixtures. Verificación del parent: `menu-fixtures-parent-verified.tap`.

Se conservaron las comprobaciones tenant de las seis consultas reales de transferencias, se completaron columnas de fixtures OTP/productos/pedidos y se acotó la simulación de interrupción a prefijos incompletos antes del COMMIT. El caso de rollback de recompensas exige haber intentado realmente el reclamo. Una expectativa temporal fija de confirmación utiliza ahora reloj congelado en lugar de depender del día de ejecución.

## Batería amplia: no está íntegramente verde

Corrida `menu-final-broad-suite.tap`: **3109 tests; 3097 aprobadas, 10 fallidas, 2 omitidas, 0 canceladas**. Además se excluyeron explícitamente dos archivos que bloquean el cierre incluso en el HEAD original:

- `tests/delivery-point-global-concurrency-postgres.test.js`.
- `tests/whatsapp-payment-choice-postgres.test.js`.

Los 10 fallos corresponden a seis casos de `whatsapp-cloud-persistence.test.js` y cuatro de `wpp-general-postgres-integration.test.js`. **Los mismos 10 fallos se reprodujeron en el HEAD original**, con 9/19 aprobadas tanto allí como en el checkout actual, bajo el mismo entorno. Evidencia: `menu-wpp-additional-baseline.tap` y `menu-wpp-additional-red.tap`.

No se ocultaron estos fallos ni se declara que toda la suite del proyecto haya pasado. La corrida amplia se realizó antes de las últimas correcciones de landings/configuración; el cierre necesita sus pruebas focalizadas posteriores.

## Operación

Ver `docs/menus-programados.md` para configuración, migración explícita y activación opt-in. Mantener separadas implementación local, publicación y operación productiva. No activar una empresa real hasta cerrar los hallazgos pendientes y verificar la versión exacta que se desplegará.
