# Menús programados y pedidos anticipados

## Alcance

Implementación opt-in de disponibilidad por producto, canal y fecha de servicio. El cliente empieza en el menú de hoy. La empresa puede habilitar un selector de fechas futuras; cada carrito y pedido tiene una sola fecha comprometida. La fecha de compra y la entrega efectiva permanecen separadas.

No se ejecutan tareas cron para encender/apagar casillas. El servidor evalúa el calendario y la ventana comercial al consultar y nuevamente al confirmar; PostgreSQL mantiene los compromisos de producción. El cupo no sustituye ni descuenta stock físico.

## Configurar la empresa

En `/pedidos/inicio/empresa.html`, bloque independiente de menús:

1. Elegir zona horaria IANA; valor inicial `America/Argentina/Buenos_Aires`.
2. Elegir días de servicio y fechas cerradas.
3. Habilitar anticipados cuando corresponda y un horizonte de hasta 30 días.
4. Guardar explícitamente la configuración del menú. Este guardado no reemplaza `config_operativa` ni el resto del formulario de empresa.

Conviene preparar los productos antes de habilitar el menú de la empresa. La configuración requiere admin/super y se comprueba contra la identidad y empresa vigentes; un tenant arbitrario en la URL o en un JWT viejo no cambia esa autoridad.

## Configurar un producto

En `/pedidos/inicio/producto.html`, editor **Menú programado**:

- **Programar este producto** es opcional. Sin programación se conserva el comportamiento habitual.
- Repetir por días de semana o elegir fechas puntuales de entrega.
- Indicar apertura y cierre como días antes de la entrega + hora local. La apertura se incluye; el cierre no.
- Permitir anticipados en el producto no basta: también debe permitirlos la empresa.
- Cupo diario vacío significa ilimitado; cero significa agotado. Se comparte entre App Catálogo y Web Landing, incluidas cantidades decimales.
- Preparar excepciones de pausa y/o cupo para una fecha. **Pausar por hoy** prepara la excepción; hace falta pulsar **Guardar Producto**. No cancela pedidos existentes.
- En reglas por canal, personalizar recurrencia/ventana de App Catálogo y Web Landing, o heredar las generales. Las casillas manuales de visibilidad y el estado Activo continúan siendo independientes.
- La vista previa consulta lo **guardado**, no el borrador sin guardar.

### Ejemplo: viandas para mañana

Empresa con anticipados habilitados. Producto con los días de elaboración elegidos, apertura **1 día antes a las 09:00**, cierre **el día de entrega a las 11:00**, anticipados permitidos y cupo 40. El cliente puede pedir desde las 09:00 del día anterior hasta antes de las 11:00 del día de servicio. Un día cerrado de empresa o una excepción de pausa prevalece.

Si la apertura queda en cero días antes, habilitar anticipados no adelanta por sí solo la ventana comercial.

## Experiencia del cliente

- App: `/pedidos/app/index.html`.
- Checkout Web: `/pedidos/index.html` y `/pedidos/`.
- Landings canónicas: `/landing/:slug`, `/l/:slug` y página de empresa resuelta en `/`.

El servidor entrega fechas ISO y usa la zona de la empresa, no la del dispositivo. Se muestran sólo los productos disponibles para esa fecha. Al cambiar la fecha con un carrito, se confirma el cambio y se revalidan productos, precios y cantidades; los incompatibles no se quitan silenciosamente. Un fallo de carga conserva el contexto anterior y permite reintentar.

Las landings canónicas reciben un adaptador al servir el HTML, sin modificar los archivos publicados. El cambio de fecha recarga la página para que una respuesta vieja no repinte otra fecha. Los enlaces de compra llevan `fecha_entrega` y `catalog_channel`. Las plantillas y archivos HTML ajenos no se sobrescriben. Accesos estáticos no canónicos siguen recibiendo el filtrado de hoy en los endpoints; el checkout dispone del selector.

El editor Web permite seleccionar fecha de vista previa desde el host. El iframe conserva sandbox de origen opaco y snapshots offline: no obtiene permisos para escribir ni realizar solicitudes autenticadas.

Confirmación, historial App y seguimiento muestran la fecha programada aceptada por el servidor. Esa fecha no se transforma mediante el huso horario del navegador.

## Integridad y compatibilidad

- Feature flag `SCHEDULED_MENUS_ENABLED=1`; por defecto apagada.
- Los flujos legacy no consultan columnas nuevas cuando la flag está apagada.
- Configuraciones vacías no programan productos ni habilitan anticipados.
- La composición final se valida después de promociones y regalos, y el reloj se comprueba después de esperas por locks, antes de COMMIT.
- El canal original se persiste con el pedido: una reapertura o aumento de un pedido Web no se evalúa por error como una venta de App.
- Las cantidades se agregan y restan en base decimal, sin tolerancias arbitrarias; por ejemplo, 0.3 de cupo menos 0.1 deja 0.2 utilizable. Los precios no se modifican por este ajuste de cantidades.
- Los regalos físicos programados consumen cupo. Las líneas contables de descuento no son unidades de producción.
- Una misma clave de confirmación repite el pedido comprometido; cambiar fecha/composición/canal con la misma clave devuelve conflicto, no crea otro pedido.
- Cancelar libera un compromiso activo; reabrir debe obtener cupo y disponibilidad de nuevo. Entregar no libera producción. Los compromisos entregados no se eliminan/reasignan para recuperar cupo.
- No se puede reducir el cupo por debajo de lo ya reservado.
- Los escritores automáticos que no ofrecen fecha (WhatsApp/premios) rechazan productos programados antes de crear un pedido parcial; la vía cliente con fecha sí contempla regalos.
- Pausar o deshabilitar configuración no borra compromisos existentes.
- El stock físico y sus reglas de entrega no se alteran.
- No se amplían permisos de agentes externos, aprobaciones financieras ni envíos de mensajes.

### Concurrencia

La barrera SQL es global para las escrituras de empresas, productos, pedidos e ítems. Es una decisión de seguridad: impide que escritores anteriores omitan el control de producción y detecta snapshots incompatibles. Mientras la flag está habilitada, `withTransaction` la adquiere antes de ejecutar cualquier callback canónico, incluidas transacciones de lectura que utilicen ese helper. También se toma explícitamente al comenzar las transacciones manuales de confirmación pública, entrega y selección/configuración WhatsApp; no se cambian sus permisos ni notificaciones. Las transacciones deben ser breves y dejar notificaciones fuera del COMMIT. Para una instalación de alto volumen se debe medir contención antes de una activación amplia; no se afirma que la barrera sea por tenant ni que permita escritura paralela entre empresas.

## Publicación y activación — operación separada

Mientras se cambia la configuración WhatsApp/supervisor, el advisory de empresa puede permanecer ocupado fuera de la transacción SQL. Con menús habilitados, el enqueue usa admisión no bloqueante para evitar el ciclo advisory/barrera. Un conflicto produce un error reintentable antes de escribir outbox; el dueño revierte y reintenta la transacción completa. Los reintentos canónicos son acotados: si la configuración sigue ocupada, se informa fallo en lugar de confirmar una selección de pago parcial u omitir su notificación.

La implementación local no activa producción. Publicar el código y desplegar/activar en Render son autorizaciones distintas.

1. Revisar y publicar el conjunto de código completo, incluidas migración y pruebas; conservar los cambios ajenos fuera del conjunto.
2. Verificar servicio/base destino y recuperación disponible. Usar Node 22.12+ de la rama 22.x.
3. Con `DATABASE_URL` provista de forma segura por el operador, ejecutar explícitamente:

   ```sh
   node scripts/init-menu-availability.js --apply
   ```

   El runner no carga `.env` ni imprime la conexión. Usa una transacción, advisory lock y relaciones calificadas `public`; se puede repetir. No hacer DDL desde un endpoint ni importar el servidor para migrar.
4. Leer de vuelta columnas/tablas/triggers esperados y verificar que no hubo backfill de pedidos históricos.
5. Desplegar el código revisado y establecer `SCHEDULED_MENUS_ENABLED=1` en el entorno destino. Requiere confirmación del operador; no se hizo en este trabajo.
6. Preparar producto(s), habilitar el menú de una empresa piloto y probar con datos sintéticos/empresa de prueba, sin enviar pedidos a clientes reales.
7. Verificar catálogo de hoy, futuro, compra, agotado, replay y cancelación/reapertura. Observar errores/esperas de locks antes de ampliar.

`initDb.sql` incluye el esquema para bootstrap completo. El inicializador existente recorta antes de las semillas en bases ya creadas: no sustituye el runner explícito para una instalación existente.

Para retirar la opción, deshabilitar primero el menú de la empresa con el backend nuevo. No apagar sólo la flag mientras quedan empresas con programación activa: la barrera SQL permanece deliberadamente fail-closed. No borrar tablas ni compromisos como mecanismo de rollback.

## Archivos principales

- Política pura: `src/menuAvailability.js`.
- Integración de lectura/validación: `src/services/menuOrderAvailability.js`.
- Configuración, preview y calendario: `src/routes/menu.js`.
- Schema/runner: `src/menu/schema.sql`, `scripts/init-menu-availability.js`.
- UI administrativa: `pedidos/inicio/menu-admin.js`.
- Carritos: `pedidos/menu-programado.js`.
- Adaptador landing: `pedidos/landing-menu-programado.js`, `src/services/landingMenuAdapter.js`.
- Preview aislada: `pedidos/landing-preview.js`.

## Verificación local

Las pruebas `tests/menu-*.test.js` usan relojes controlados, identidades sintéticas, Chromium y PostgreSQL desechable UTF8. La integración `tests/menu-integration-postgres-browser.test.js` carga el bootstrap real y conecta los HTML reales Web/App con configuración canónica, catálogos, confirmación, reservas y seguimiento. La sesión de cliente App y los notificadores están sustituidos explícitamente por fixtures; no es una prueba de autenticación de cliente ni de WhatsApp real. Los permisos administrativos sí se ejercitan con JWT sintético y recarga canónica de usuario en PostgreSQL.

La prueba cubre selección futura, aislamiento de empresa, fecha persistida, replay, descuento contable, agotamiento y ausencia de nuevas notificaciones ante rechazo. Las pruebas de esquema cubren migración repetida, search_path adverso y carrera por último cupo. Los resultados finales de la batería se informan después de la revisión, no se infieren de tests aislados.
