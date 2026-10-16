# Contrato de integración — menús programados v1

## Columnas y activación

- Feature flag: `SCHEDULED_MENUS_ENABLED=1`; por defecto deshabilitado. Sin flag no consultar columnas nuevas en flujos legacy. No migrar ni cambiar `.env` productivo por requests.
- `empresas.menu_config JSONB NOT NULL DEFAULT '{}'`.
- `productos.disponibilidad_config JSONB NOT NULL DEFAULT '{}'` (no reutilizar config_activo).
- `pedidos.fecha_entrega_programada DATE NULL`, reflejada también en fecha_entrega_estimada cuando hay selección comprometida.
- `pedidos.menu_intent_hash TEXT NULL` para comparación de replay programado.
- `pedidos.menu_channel TEXT NULL`, valores `catalog` o `landing`, persistido junto a la fecha para que edición/reapertura use las reglas del canal original.
- Contador transaccional `public.menu_cupos_diarios(empresa_id, producto_id, fecha DATE, reservado NUMERIC)` y reservas por ítem/pedido mantenidas con triggers/constraints. Detalles internos definidos por implementador core; no tocar stock físico.

## Configuración normalizada

Empresa `menu_config`:

```json
{"version":1,"enabled":false,"timezone":"America/Argentina/Buenos_Aires","advance_enabled":false,"max_advance_days":7,"service_weekdays":[0,1,2,3,4,5,6],"closed_dates":[]}
```

Producto `disponibilidad_config`:

```json
{"version":1,"enabled":false,"mode":"weekly","weekdays":[1,2,3,4,5],"dates":[],"allow_advance":true,"open_days_before":0,"open_time":"00:00","close_days_before":0,"close_time":"23:59","daily_capacity":null,"exceptions":[],"channels":{}}
```

- Semana domingo=0. `mode` semanal o fechas. Sin programación: enabled=false.
- `daily_capacity`: NULL ilimitado, cero agotado; cantidad numérica no negativa finita, acotada.
- Excepción: `{date:"YYYY-MM-DD", paused:true|false, capacity:null|numero}`; `capacity` omitido hereda, NULL explícito ilimitado. Fecha única por excepción.
- `channels.catalog` y `channels.landing` opcionales: overrides de weekdays/dates/apertura/cierre; omitir = compartir reglas base. Cupo/excepciones compartidos entre canales.
- Fecha real y hora HH:MM estrictas; zona IANA validada; horizonte 0..30 días. Apertura inclusiva, cierre exclusivo. Anticipación necesita permiso de empresa Y producto. Día cerrado de empresa prevalece.
- No cancelar pedidos existentes al pausar; impedir nuevas altas/aumentos/reaperturas fuera de ventana. No bajar capacidad por debajo de la comprometida.

## Módulo puro `src/menuAvailability.js`

Exports acordados (argumentos objeto):

- `menuFeatureEnabled(env = process.env)`.
- `normalizeCompanyMenuConfig(value)`; `normalizeProductAvailabilityConfig(value)`.
- `serviceDateToday(company, now = new Date())` → YYYY-MM-DD.
- `validateServiceDate({company,deliveryDate,now})` → fecha canónica o error con `statusCode` y `code`.
- `evaluateProductAvailability({company,productConfig,deliveryDate,channel,now,usedQuantity})` → `{available,scheduled,reason,opens_at,closes_at,remaining,timezone,advance_allowed,date}`.
- `menuAddQuantity(a,b)` y `menuSubtractQuantity(a,b)`: aritmética decimal de cantidades/cupo, finitas y acotadas a `Number.MAX_SAFE_INTEGER`; no se utilizan para alterar precios.

Sin IO/DDL en imports. Constructor/normalización estrictos; configuraciones vacías son neutral/legacy. Reloj inyectable en tests. Errores de negocio en español con código estable; no volcar payloads personales.

## Reservas y barrera de escritura

Los triggers deben preservar consistencia de contador/ledger para creación, edición de ítems, cancelación/reapertura y borrado de pedidos. Entregado sigue consumiendo producción; no devolver cupo por entregar. No permitir borrar ítems/pedidos entregados que liberarían producción registrada; proteger identidad de productos referenciados. Una reserva exige fecha comprometida; entrypoints alternativos que no saben pedir una fecha (WhatsApp automático/premios) rechazan productos programados ANTES de escribir, en lugar de crear pedidos parciales.

La confirmación pública valida la composición final tras promociones/regalos, persiste fecha única y revalida ventana con reloj fresco después de cualquier espera por locks y antes de COMMIT. El cupo está acotado atómicamente, no por SUM sin serialización. Doble submission idempotente no duplica reserva; distinta fecha/intención con la misma clave es 409. No repetir efectos externos dentro de nuevos reintentos.

## APIs de configuración

- `GET /api/menu/config?empresa_id=`: auth canónica admin/super, `{enabled:boolean,empresa_id,config}`. Flag apagado retorna enabled=false sin necesitar esquema nuevo.
- `PUT /api/menu/config?empresa_id=`: auth admin/super + tenant; body config normalizada. Guardado acotado, no reemplazar config_operativa.
- CRUD `/api/productos`: `disponibilidad_config` adicional sólo con feature habilitada. Guardar junto a edición de producto en la transacción existente y preservar campo cuando cliente legacy lo omite.
- `GET /api/menu/preview?producto_id=&fecha_entrega=&canal=catalog|landing`: estado guardado y disponibilidad; auth admin/super tenant. No confundir preview de configuración guardada con un guardado automático.

## APIs públicas

- `/public/menu` y `/api/public/menu`: misma resolución tenant canónica que productos, sin auth humana. Respuesta `{enabled,timezone,today,selected_date,advance_enabled,max_advance_days,dates:["YYYY-MM-DD"]}`; días habilitados de empresa en horizonte. Flag/empresa apagada: enabled=false, no cambios legacy.
- Productos existentes siguen devolviendo arrays; parámetro `fecha_entrega=YYYY-MM-DD`. Canal inferido del scope (catalog/landing), nunca tenant por un valor arbitrario del cliente. Filtrar servidores por disponibilidad y canal manteniendo orden. Campo adicional por producto `menu` con evaluación mínima permitida.
- POST `/public/pedidos` agrega `fecha_entrega` y `catalog_channel` (`catalog` o `landing`). Una sola fecha de cabecera; rechazar fechas por ítem. El canal no otorga privilegios ni permite usar otra empresa.
- Sin empresa menú habilitada ni productos programados y sin fecha nueva: flujo original. Con fecha solicitada, validar fecha/horizonte/reglas de empresa, producto y logística; no desplazarla silenciosamente.
- Respuesta del pedido y seguimiento: `fecha_entrega_programada`, además de fecha_entrega_estimada; fecha efectiva de entrega permanece independiente.

## Frontend público

- Integrar selector reusable en `pedidos/app/index.html` + `main.js` y `pedidos/index.html`.
- Hoy por defecto. Carta futura visible sólo con advance_enabled. Una fecha por carrito, confirmar cambio con artículos y revalidar composición; no borrar silenciosamente productos ni aceptar respuestas atrasadas.
- Payload lleva fecha/canal sólo en modo habilitado. Confirmación/seguimiento muestran fecha aceptada por servidor. Repetición y `add=` respetan contexto; enlaces de landing a checkout transmiten fecha seleccionada.
- Landings HTML dirty no sobrescribir. Parent implementará adaptador común/inyección controlada para landings servidas; backend filtra menú de hoy en todos los endpoints aunque HTML legacy no tenga selector.

## Frontend admin

- Producto: mostrar programación opcional, días/fechas, apertura/cierre, anticipados, cupo, excepciones y overrides de canal; vista previa explícita guardada y estado actual. UI accessible, sin persistir por abrir/cambiar un control.
- Empresa: bloque separado para menú/anticipación/horizonte/timezone/service-days/closed-dates usando /api/menu/config. Guardar explícitamente y preservar otros formularios/configuraciones.

## Verificación y límites de operación

Node 22, PostgreSQL desechable, Chromium con fixtures. Migración doble, shadow search_path, no imports/HTTP DDL, default-off y legado intacto. Probar todos los canales/tenants, cierre exacto y medianoche, carreras último cupo, replay, regalo, cancelación/reapertura/edición/borrado y stale UI. No DB productiva, notificaciones reales, cambios de permisos, commit/push ni despliegue.
