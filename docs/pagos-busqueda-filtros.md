# Pagos: búsqueda y filtros combinables

Pantalla: `/pedidos/pagos.html`.

## Alcance autorizado

Búsqueda global de cliente, teléfono, número de pedido y referencia/operación; separación entre estado y tipo; rango de fechas con accesos Hoy, últimos siete días y mes actual. Se conserva el panel de revisión manual, el aislamiento por empresa y las reglas de aprobación existentes. Buscar o cambiar filtros no debe aprobar pagos, generar mensajes ni modificar registros de negocio.

## Contrato de consulta

Las fuentes de datos son:

- Transferencias: `GET /api/transferencias`.
- QR: `GET /api/admin/qr/pagos`.
- Pedidos pendientes de comprobante: `GET /api/transferencias/sin-comprobante`.

Parámetros compartidos:

- `q`: búsqueda de hasta 120 caracteres; nombre sin distinción de mayúsculas/acentos, teléfono normalizado a dígitos, pedido por ID exacto (con o sin `#`) y referencias que correspondan a cada fuente. Los caracteres `%`, `_` y `\` se buscan literalmente, no como comodines de SQL.
- `desde` y `hasta`: fechas reales `YYYY-MM-DD`, límites inclusivos interpretados en `America/Argentina/Buenos_Aires`. Se permite un solo límite. Un rango invertido o malformado se rechaza.
- `fecha`: compatibilidad con clientes anteriores que consultan un día concreto.
- `empresa_id`, `chofer_id` y `cuenta_bancaria_id`: mantienen los controles existentes; el usuario administrador nunca adquiere acceso a otra empresa por enviar un filtro.
- `before_id` y `before_fecha`: cursor por fuente para orden descendente de fecha e ID. `cursor_fecha` conserva la precisión de PostgreSQL cuando la fecha serializada por el driver pierde microsegundos. Las fechas nulas se ordenan al final y usan exclusivamente el sentinel `-infinity` con `before_id`; el servidor compara la misma tupla normalizada que utiliza al ordenar, para no perder ni repetir filas.

Los filtros se aplican **antes** del límite/paginación en el servidor, no sobre una única tanda cargada en el navegador. Todos los valores de búsqueda usan parámetros SQL, con condiciones de empresa fuera de los grupos `OR`. El listado de transferencias excluye efectivo antes del `LIMIT`, usando la precedencia comprobante → pedido → valor predeterminado; de ese modo una página de efectivo no oculta transferencias coincidentes.

## Combinaciones de tipo y estado

| Selección | Fuentes elegibles |
| --- | --- |
| Todos los tipos | Transferencias, QR y sin comprobante |
| Transferencias | Registros de transferencias |
| QR | Pagos QR |
| Sin comprobante | Pedidos sin comprobante |
| Pendientes | Fuentes elegibles no verificadas, incluidos sin comprobante |
| Verificados | Transferencias y QR |
| En revisión | Sólo transferencias |
| Sin pedido | Sólo transferencias no asociadas |
| Cuenta bancaria | Sólo transferencias |

Se utiliza la intersección entre los filtros, no una sustitución silenciosa. Por ejemplo, QR + En revisión no debe consultar transferencias ignorando el tipo elegido.

## Paginación, concurrencia y alcance de indicadores

Cada fuente mantiene su cursor y estado de agotamiento. Una fuente agotada no debe comenzar nuevamente al pedir más registros de otra; las filas usan identidades diferenciadas por fuente. Las cargas anteriores no deben sobrescribir una búsqueda más reciente, avanzar cursores después de fallar ni mezclar datos al cambiar de empresa.

Los indicadores y la exportación actual corresponden a los **registros cargados**. No se presenta ese subtotal como el total global de coincidencias. La exportación no implica una consulta bancaria ni confirma fondos recibidos.

Los botones rápidos usan el día del negocio en Argentina, no la fecha UTC del dispositivo. La pantalla debe funcionar con teclado, mostrar errores distinguibles de un resultado vacío y permitir limpiar los filtros.

## Verificación requerida

- Navegador con HTML real y fuentes sintéticas: filtros combinados, Enter, accesos de fechas, móvil/escritorio, respuestas tardías, fuente agotada, error/reintento y ausencia de escrituras al filtrar.
- PostgreSQL desechable: búsqueda más allá de la primera página, caracteres literales e intentos de inyección, límites horarios, separación de empresas y cursor compuesto con fechas fuera del orden de IDs y empates en microsegundos.
- Regresión del panel de revisión: importes separados, cuentas propias de la empresa del comprobante, aprobación manual, estado ambiguo bloqueado y `enviarAviso=0` intactos.
- No se requieren pruebas sobre pedidos, pagos o clientes productivos.

## Pruebas reproducibles

```sh
NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null \
DATABASE_URL=postgres://invalid:invalid@127.0.0.1:1/unused \
node --test tests/pagos-search-range-postgres.test.js tests/pagos-filtros.test.js \
tests/pagos-revision-panel.test.js tests/transferencias-*.test.js \
tests/transferencia-storage.test.js tests/p0-transferencias-tenant-postgres.test.js \
tests/pagos-provider.test.js tests/p0-global-mutation-inventory.test.js
```

Usar la rama Node 22 compatible con el proyecto. El test PostgreSQL crea una base UTF-8 desechable y también ejercita Chromium con el HTML real, cookie con autenticación canónica y las tres consultas reales. Incluye un comprobante fuera de los primeros 200 registros, nombre con acentos, rango de fechas, tipos/estados y referencias. Guarda capturas sintéticas de escritorio y móvil en `$TMPDIR/pagos-search-integration/`.

Los fixtures de licencia aíslan el chequeo de vigencia; no representan una consulta a una licencia productiva. No se inicia la aplicación completa ni se usa el `.env` del checkout para la base de datos de pruebas.

## Publicación

Implementación local, publicación en GitHub y despliegue en Render son pasos separados. Esta mejora no autoriza cambios de permisos, migraciones productivas ni operaciones financieras reales.
