# WhatsApp Cloud Utility Templates Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Enviar las tres notificaciones proactivas de pedido por plantillas Utility de WhatsApp Cloud, incluso fuera de la ventana de 24 horas, conservando byte por byte los textos de WhatsApp Web y corrigiendo la correlación de estados Meta `failed`/`delivered`/`read` cuando el WAMID termina en `=`.

**Architecture:** Los productores siguen construyendo el texto Web existente y agregan sólo una intención lógica de plantilla con parámetros semánticos; `src/wpp/enqueue.js` resuelve el transporte y continúa siendo el único `INSERT INTO wpp_outbox`. Para filas Cloud, el worker resuelve el nombre/idioma aprobado desde la configuración server-side de la empresa y envía `type=template`; nunca cae a Web ni a texto libre ante un error. La migración y la validación de WAMID preservan el identificador Meta exacto y reparan únicamente correlaciones históricas inequívocas, padding-only y del mismo tenant.

**Tech Stack:** Node.js 22 ESM, Express, PostgreSQL real, Meta WhatsApp Cloud Graph API, HTML/JavaScript sin framework, `node:test`, Puppeteer para browser gates.

---

## Invariantes no negociables

1. `wpp_outbox` sigue siendo la única frontera outbound y existe un solo `INSERT INTO wpp_outbox` productivo, en `src/wpp/enqueue.js`.
2. Los textos que reciben `company`/WhatsApp Web para confirmación, en ruta y transferencia no cambian ni un carácter; las plantillas se usan sólo cuando el transporte server-side resuelto es `cloud`.
3. Un caller nunca elige `transport_origin`, nombre Meta, idioma ni estructura Graph. Sólo los productores internos allowlisted pueden entregar una intención lógica conocida.
4. No hay fallback Cloud→Web ni template→texto. Configuración incompleta, rechazo Meta, timeout o resultado ambiguo terminan en estados Cloud sanitizados y sin retry automático.
5. `admin` continúa limitado a `req.user.empresa_id`; sólo `super` configura credenciales y mapping de plantillas. No existe empresa por defecto, vista global ni tenant aportado por un producer.
6. Los parámetros de plantilla se generan server-side desde datos ya autorizados del pedido/empresa. No se aceptan nombres, direcciones, cuentas, teléfonos, tokens o WAMID desde endpoints nuevos.
7. Toda consulta que transporte teléfono, texto, parámetros de plantilla, datos bancarios o WAMID se marca `{ sensitive: true }`; logs, errores, CLI, respuestas HTTP y backups no agregan exposición de esos valores.
8. El token de Graph permanece cifrado y redactado. El app secret permanece sólo en ambiente. El mapping de plantilla contiene únicamente nombres/idiomas no secretos y jamás componentes con PII.
9. El WAMID aceptado se guarda exactamente como llegó de Meta. No se recorta, reescribe ni elimina `=`. Identificadores inválidos se rechazan antes de persistir.
10. La reparación histórica no adivina: sólo actualiza pares únicos por `empresa_id`, cuya única diferencia sea uno o dos `=` finales, sin colisión exacta ni ambigüedad inversa.
11. `failed`, `delivered` y `read` se correlacionan por `(empresa_id, provider_message_id)` exacto y la UI muestra el estado durable real, de forma monotónica y sin exponer provider IDs.
12. Aplicar RED→GREEN→REFACTOR por slice vertical; luego revisión independiente de especificación y, sólo después, revisión independiente de calidad/seguridad.

## Plantillas Meta propuestas para aprobación

Los nombres físicos son propuestas; cada empresa los mapea server-side a sus nombres realmente aprobados. Categoría solicitada: `UTILITY`. Idioma inicial: `es_AR`. Los parámetros no pueden contener secretos técnicos, URLs Meta ni identificadores internos.

### 1. `pedivoy_order_confirmation_v1`

**Body exacto:**

```text
Hola {{1}}, confirmamos tu pedido.

Detalle:
{{2}}

Total: {{3}}
Entrega: {{4}}
Fecha: {{5}}
Horario: {{6}}
Repartidor: {{7}}
Teléfono del repartidor: {{8}}

Gracias por tu compra.
```

**Parámetros body, en orden:**

1. `customer_name`
2. `items_block`
3. `total`
4. `address`
5. `delivery_date`
6. `delivery_window`
7. `driver_name`
8. `driver_phone`

**Regla del bloque dinámico:** agrupar por producto como hoy, máximo 8 líneas y máximo 600 caracteres UTF-16 después de normalizar CRLF a LF. Cada línea usa `«cantidad x producto — subtotal»`. Si quedan productos, la última línea reservada es `«… y N productos más»`; nunca cortar una línea ni un surrogate pair. Promociones/retornables que no entren permanecen únicamente en el texto Web sin alterar.

### 2. `pedivoy_order_en_route_v1`

**Body exacto:**

```text
Hola {{1}}, tu pedido ya está en camino hacia {{2}}.
Usá el botón para seguir la entrega en vivo.
```

**Parámetros body, en orden:**

1. `customer_name`
2. `address`

**Botón URL dinámico exacto:**

- Label: `Seguir pedido`
- URL registrada en Meta: `https://www.pedivoy.com/pedidos/seguimiento.html?t={{1}}`
- Parámetro button `url`, index `0`: `tracking_token`

El parámetro enviado es sólo el token opaco, nunca una URL completa ni un dominio aportado por el cliente. Mientras esta plantilla esté activa, Cloud usa el origen canónico `www.pedivoy.com`; el texto Web conserva `landing_domain` y su URL actual sin cambios.

### 3. `pedivoy_transfer_payment_v1`

**Body exacto:**

```text
Hola {{1}}, para completar el pago de {{2}}, transferí a:

Alias: {{3}}
CBU: {{4}}
Banco: {{5}}
Titular: {{6}}
Empresa: {{7}}

Luego respondé a este mensaje con el comprobante.
```

**Parámetros body, en orden:**

1. `customer_name`
2. `amount`
3. `alias`
4. `cbu`
5. `bank`
6. `holder`
7. `company_name`

Si no existe una cuenta activa completa, la intención Cloud falla cerrada antes de encolar; no se envía una plantilla con placeholders vacíos y no se cae a texto/Web.

## Contrato durable propuesto

Agregar a `wpp_outbox`:

- `cloud_template_key TEXT NULL`: sólo `order_confirmation`, `order_en_route`, `transfer_payment`.
- `cloud_template_parameters JSONB NULL`: objeto semántico validado; nunca contiene nombre físico de plantilla, idioma, access token, phone-number ID ni URL completa.

Reglas:

- Filas `company`/`general`: ambas columnas `NULL`.
- Filas `cloud` proactivas: key y objeto presentes y coherentes.
- Filas `cloud` de reply humano/bot dentro de conversación: ambas columnas `NULL` y mantienen el camino `sendText` existente.
- El mapping vive en `empresas.config_integraciones.whatsapp.templates`:

```json
{
  "order_confirmation": { "name": "pedivoy_order_confirmation_v1", "language": "es_AR" },
  "order_en_route": { "name": "pedivoy_order_en_route_v1", "language": "es_AR" },
  "transfer_payment": { "name": "pedivoy_transfer_payment_v1", "language": "es_AR" }
}
```

- Nombres: `^[a-z0-9_]{1,512}$`.
- Idioma inicial allowlisted: exactamente `es_AR`; ampliar sólo con una tarea futura y pruebas de contenido aprobado.
- Los tres mappings son independientes. Una plantilla ausente invalida únicamente esa intención, no la mensajería Cloud conversacional ni las otras plantillas.

---

## Task 1: Congelar contratos actuales y crear helpers de intención

**Objective:** Capturar en tests el texto Web existente y definir una API interna estricta para las tres intenciones Cloud sin cambiar producción aún.

**Files:**
- Create: `src/whatsappCloud/utilityTemplates.js`
- Create: `tests/whatsapp-cloud-utility-templates.test.js`
- Modify: `tests/public-create-pedido-success.test.js`
- Modify: `tests/notificaciones-pedidos.test.js`

**Step 1: Escribir tests RED del catálogo lógico**

Probar que sólo acepta las keys exactas, exige todos los campos, rechaza extras, objetos/arrays hostiles, strings vacíos, control chars y límites excedidos. Probar orden exacto de body/button components y que el bloque de ítems cumple 8 líneas/600 caracteres con marcador `… y N productos más`.

**Step 2: Congelar el texto Web actual**

Agregar fixtures exactos para:

- `armarMensajeConfirmado` incluyendo fecha/horario/repartidor/teléfono.
- `createNotificarEnRuta` con URL de tracking actual.
- `createNotificarPedidoTransferencia` con alias/CBU/banco/titular/empresa.

El expected debe ser el string completo, no regex parciales.

**Step 3: Verificar RED**

Run:

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/whatsapp-cloud-utility-templates.test.js \
  tests/public-create-pedido-success.test.js \
  tests/notificaciones-pedidos.test.js
```

Expected: FAIL porque `utilityTemplates.js` y los builders estrictos todavía no existen; los tests de snapshot Web existentes continúan verdes.

**Step 4: Implementar helpers puros mínimos**

En `utilityTemplates.js` exportar constantes de keys/campos, `buildOrderConfirmationIntent`, `buildOrderEnRouteIntent`, `buildTransferPaymentIntent`, `boundOrderItemsBlock`, `validateUtilityTemplateIntent`, `validateTemplateMapping` y `buildMetaTemplateComponents`. No importar DB, Express ni Graph.

**Step 5: Verificar GREEN y refactor**

Repetir el comando; expected: PASS. Refactorizar duplicación manteniendo un schema cerrado por key.

**Step 6: Commit**

```bash
git add src/whatsappCloud/utilityTemplates.js tests/whatsapp-cloud-utility-templates.test.js \
  tests/public-create-pedido-success.test.js tests/notificaciones-pedidos.test.js
git commit -m "test(whatsapp-cloud): define utility template contracts"
```

## Task 2: Persistencia Cloud opcional sin una segunda frontera outbound

**Objective:** Extender el único enqueue para persistir intención sólo cuando el transporte resuelto es Cloud, preservando texto/dedupe Web.

**Files:**
- Modify: `initDb.sql`
- Modify: `src/wpp/enqueue.js`
- Modify: `src/services/messaging.js`
- Modify: `tests/wpp-enqueue-shared.test.js`
- Modify: `tests/wpp-outbox-postgres-integration.test.js`
- Modify: `tests/wpp-producers.test.js`

**Step 1: Escribir tests RED de enqueue**

Casos:

- Empresa Web + intención válida: INSERT conserva exactamente `mensaje`, `cloud_template_* = NULL`.
- Empresa Cloud + intención válida: INSERT conserva `mensaje` para proyección/auditoría y guarda key/parámetros canónicos.
- Empresa Cloud + intención inválida: falla antes del INSERT con código allowlisted.
- General/reply sin intención: comportamiento actual.
- Caller intenta pasar nombre físico, idioma, transporte o componentes Graph: rechazo.
- Dedupe sigue siendo tenant/transport/message scoped y devuelve resultado explícito.

**Step 2: Escribir migración RED en PostgreSQL real**

Probar ejecución doble, checks de key/JSON/transport, preservación de filas legacy y rechazo de metadata template en filas no Cloud. La migración debe usar `lock_timeout`/`statement_timeout` antes del lock y no modificar el INSERT productivo.

**Step 3: Verificar RED**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/wpp-enqueue-shared.test.js \
  tests/wpp-outbox-postgres-integration.test.js \
  tests/wpp-producers.test.js
```

Expected: FAIL por columnas/API ausentes.

**Step 4: Implementar mínimo**

- Agregar `utility_template` opcional a `enqueueWppMessage`.
- Validarlo en `prepareEnqueue`.
- Después de tomar lock de configuración y resolver `transportOrigin`, persistir metadata sólo para `cloud`; borrarla para `company/general`.
- Extender el mismo `INSERT` de `src/wpp/enqueue.js`; no crear INSERT alternativo.
- Marcar la query sensible.

**Step 5: Verificar GREEN**

Repetir comando; expected: PASS.

**Step 6: Gate mecánico de frontera**

```bash
python3 - <<'PY'
from pathlib import Path
hits=[]
for p in Path('src').rglob('*.js'):
    text=p.read_text(encoding='utf-8')
    count=text.lower().count('insert into wpp_outbox')
    hits += [str(p)]*count
assert hits == ['src/wpp/enqueue.js'], hits
print(hits)
PY
```

Expected: `['src/wpp/enqueue.js']`.

**Step 7: Commit**

```bash
git add initDb.sql src/wpp/enqueue.js src/services/messaging.js \
  tests/wpp-enqueue-shared.test.js tests/wpp-outbox-postgres-integration.test.js tests/wpp-producers.test.js
git commit -m "feat(whatsapp-cloud): persist utility template intent"
```

## Task 3: Mapping tenant-scoped seguro y panel superadmin

**Objective:** Guardar nombres/idioma aprobados por empresa sin permitir que productores o admins ajenos elijan plantillas.

**Files:**
- Modify: `src/routes/empresas.js`
- Modify: `pedidos/inicio/empresa.html`
- Modify: `tests/empresas-route.test.js`
- Modify: `tests/empresa-whatsapp-panel.test.js`
- Modify: `tests/postgres-backup.test.js`

**Step 1: Escribir tests RED server-side**

Probar allowlist cerrada `whatsapp.templates`, merge parcial que conserva token cifrado/integraciones hermanas, nombres/idioma normalizados, rechazo de keys extra y valores inválidos. Confirmar:

- Admin no puede mutar mapping propio ni ajeno.
- Super puede guardar por empresa.
- GET/POST/PUT/backup nunca devuelven token plaintext/ciphertext, app secret ni claves arbitrarias.
- El mapping safe puede volver al panel sólo como nombre/idioma; nunca se devuelve payload ni parámetros de pedidos.

**Step 2: Escribir tests RED de UI**

Agregar tres grupos visibles sólo para super, inputs de nombre e idioma, estado de completitud por plantilla y confirmación al activar mapping. El formulario no contiene ejemplos con PII ni persiste datos en browser storage.

**Step 3: Verificar RED**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/empresas-route.test.js \
  tests/empresa-whatsapp-panel.test.js \
  tests/postgres-backup.test.js
```

Expected: FAIL por mapping/UI ausentes.

**Step 4: Implementar mínimo**

Extender `allowlistedWhatsappConfig`, `securePaymentIntegraciones`, redacción y helpers del panel. No hacer obligatorias las tres plantillas para activar Cloud; exponer readiness independiente y fallar sólo al usar una intención sin mapping.

**Step 5: Verificar GREEN**

Repetir comando; expected: PASS.

**Step 6: Commit**

```bash
git add src/routes/empresas.js pedidos/inicio/empresa.html \
  tests/empresas-route.test.js tests/empresa-whatsapp-panel.test.js tests/postgres-backup.test.js
git commit -m "feat(whatsapp-cloud): configure tenant utility templates"
```

## Task 4: Graph API de templates sin fallback

**Objective:** Añadir envío `type=template` exacto, sanitizado y clasificado con la misma semántica de outcome que texto.

**Files:**
- Modify: `src/whatsappCloud/graphClient.js`
- Modify: `tests/whatsapp-cloud-consumer.test.js`

**Step 1: Escribir tests RED de payload Graph**

Probar para las tres plantillas:

- `messaging_product`, recipient individual, `type: template`.
- `template.name`, `language.code` y components exactos.
- En ruta incluye component `button`, `sub_type: url`, `index: "0"`, parameter text igual sólo al token.
- No aparece texto Web, URL completa, token Graph, phone-number ID, nombre físico no validado ni campos extra.
- 400/429/408/5xx/network conservan clasificación actual y nunca llaman `sendText` como fallback.

**Step 2: Verificar RED**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test tests/whatsapp-cloud-consumer.test.js
```

Expected: FAIL porque `sendTemplate` no existe.

**Step 3: Implementar mínimo**

Extraer el POST común sin cambiar deadlines/cancelación; agregar `sendTemplate` que recibe sólo una plantilla ya resuelta/validada. Mantener bodies no-ok sin parsear y resultados allowlisted.

**Step 4: Verificar GREEN**

Repetir comando; expected: PASS.

**Step 5: Commit**

```bash
git add src/whatsappCloud/graphClient.js tests/whatsapp-cloud-consumer.test.js
git commit -m "feat(whatsapp-cloud): send approved utility templates"
```

## Task 5: Consumer resuelve mapping durable y elige template o texto

**Objective:** Consumir filas proactivas como template, mantener replies como texto y fallar cerrado si el mapping desaparece o es inválido.

**Files:**
- Modify: `src/whatsappCloud/outboxRepository.js`
- Modify: `src/whatsappCloud/consumer.js`
- Modify: `src/whatsappCloud/runtime.js`
- Modify: `tests/whatsapp-cloud-consumer.test.js`
- Modify: `tests/whatsapp-cloud-consumer-postgres.test.js`
- Modify: `tests/whatsapp-cloud-runtime.test.js`

**Step 1: Escribir tests RED verticales**

- Claim devuelve key/parámetros sin loggearlos.
- `loadDurableCloudConfig` devuelve sólo mapping validado del tenant junto con phone/token cifrado.
- Fila con intención usa `sendTemplate` exactamente una vez y jamás `sendText`.
- Fila sin intención usa `sendText` como hoy.
- Mapping faltante/inválido → `definitive_failed`, `cloud_template_config_invalid`, cero Graph, cero fallback.
- Payload inválido durable → `definitive_failed`, código sanitizado, cero Graph.
- Timeout tras dispatch → `outcome_unknown`, sin retry/fallback.

**Step 2: Verificar RED**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/whatsapp-cloud-consumer.test.js \
  tests/whatsapp-cloud-consumer-postgres.test.js \
  tests/whatsapp-cloud-runtime.test.js
```

Expected: FAIL por claim/config/branch ausentes.

**Step 3: Implementar mínimo**

Resolver key→mapping sólo después de cargar config durable. Construir components con `utilityTemplates.js`, marcar dispatch antes de Graph y limpiar referencias locales a token/parámetros sensibles después del llamado. No incluir parámetros en logs ni errores.

**Step 4: Verificar GREEN**

Repetir comando; expected: PASS.

**Step 5: Commit**

```bash
git add src/whatsappCloud/outboxRepository.js src/whatsappCloud/consumer.js \
  src/whatsappCloud/runtime.js tests/whatsapp-cloud-consumer.test.js \
  tests/whatsapp-cloud-consumer-postgres.test.js tests/whatsapp-cloud-runtime.test.js
git commit -m "feat(whatsapp-cloud): dispatch tenant utility templates"
```

## Task 6: Confirmación de pedido como template Cloud

**Objective:** Enviar la confirmación proactiva con los ocho parámetros aprobados en Cloud y conservar exactamente el texto Web actual.

**Files:**
- Modify: `src/routes/publicLegacyCreatePedido.js`
- Modify: `src/whatsappCloud/utilityTemplates.js`
- Modify: `tests/public-create-pedido-success.test.js`
- Modify: `tests/public-create-pedido-product-identity-postgres.test.js`

**Step 1: Escribir tests RED**

- Web: captura exacta del string previo, incluidas promos, retornables, alias transferencia y repartidor.
- Cloud intent: nombre, bloque agrupado/acotado, total ARS, dirección completa, fecha, horario o `A coordinar`, chofer o `A asignar`, teléfono o `No informado`.
- El monto sale del pedido/ítems server-side; no del body cliente luego de resolución de identidad/precios.
- 9+ productos y nombres largos producen truncado determinista sin exceder límites.
- El enqueue post-commit recibe texto + intención; no nombre Meta ni transporte.

**Step 2: Verificar RED**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/public-create-pedido-success.test.js \
  tests/public-create-pedido-product-identity-postgres.test.js \
  tests/whatsapp-cloud-utility-templates.test.js
```

Expected: FAIL porque el producer no agrega intención.

**Step 3: Implementar mínimo**

Construir la intención junto al texto existente, después de resolver datos canónicos. No modificar `armarMensajeConfirmado` ni los append actuales de promociones/alias.

**Step 4: Verificar GREEN y snapshot byte-for-byte**

Repetir comando; expected: PASS y snapshot Web idéntico.

**Step 5: Commit**

```bash
git add src/routes/publicLegacyCreatePedido.js src/whatsappCloud/utilityTemplates.js \
  tests/public-create-pedido-success.test.js tests/public-create-pedido-product-identity-postgres.test.js
git commit -m "feat(whatsapp-cloud): template order confirmations"
```

## Task 7: Pedido en ruta con botón URL dinámico

**Objective:** Enviar nombre/dirección y token de tracking como botón Meta, manteniendo el texto y URL Web existentes.

**Files:**
- Modify: `src/services/notificacionesPedidos.js`
- Modify: `tests/notificaciones-pedidos.test.js`
- Modify: `tests/whatsapp-cloud-utility-templates.test.js`

**Step 1: Escribir tests RED**

- Texto Web exacto con dominio default y custom domain.
- Intención Cloud contiene sólo `customer_name`, `address`, `tracking_token`.
- Token recién creado usa el valor devuelto por `UPDATE ... RETURNING`, no el candidato perdido en una carrera.
- Rechazar token vacío, con URL, query adicional, whitespace/control chars o longitud fuera del límite.
- `en_ruta_notificado_at` se marca sólo después de enqueue confirmado; error Cloud no se disfraza de notificación enviada.

**Step 2: Verificar RED**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/notificaciones-pedidos.test.js \
  tests/whatsapp-cloud-utility-templates.test.js
```

Expected: FAIL por intención/button ausentes.

**Step 3: Implementar mínimo**

Pasar `utility_template` al mismo `enqueueWppMessageFn`. No cambiar `buildTrackingUrl` ni `mensaje`.

**Step 4: Verificar GREEN**

Repetir comando; expected: PASS.

**Step 5: Commit**

```bash
git add src/services/notificacionesPedidos.js tests/notificaciones-pedidos.test.js \
  tests/whatsapp-cloud-utility-templates.test.js
git commit -m "feat(whatsapp-cloud): template en-route notifications"
```

## Task 8: Instrucciones de transferencia como template Cloud

**Objective:** Enviar los siete parámetros bancarios aprobados desde la cuenta activa prioritaria, sin filtrar datos a logs/errores.

**Files:**
- Modify: `src/services/notificacionesPedidos.js`
- Modify: `tests/notificaciones-pedidos.test.js`
- Modify: `tests/transferencias-tenancy.test.js`
- Modify: `tests/repartidor-tenant-isolation.test.js`

**Step 1: Escribir tests RED**

- Selección tenant-scoped de la cuenta activa de menor prioridad.
- Intención exacta: customer, amount, alias, CBU, bank, holder, company.
- Cuenta inexistente/incompleta no encola Cloud ni cae a Web si el transporte durable es Cloud; devuelve error interno sanitizado al caller correspondiente.
- Web conserva el texto completo existente y su tolerancia histórica a campos opcionales.
- Ningún log/error serializado contiene CBU, alias, titular, nombre/phone cliente o token.

**Step 2: Verificar RED**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/notificaciones-pedidos.test.js \
  tests/transferencias-tenancy.test.js \
  tests/repartidor-tenant-isolation.test.js
```

Expected: FAIL por intención y fail-closed Cloud ausentes.

**Step 3: Implementar mínimo**

Construir intención desde las filas ya tenant-scoped. Mantener `mensaje` sin cambios y dejar que enqueue decida si ignora intención para Web o la exige para Cloud.

**Step 4: Verificar GREEN**

Repetir comando; expected: PASS.

**Step 5: Commit**

```bash
git add src/services/notificacionesPedidos.js tests/notificaciones-pedidos.test.js \
  tests/transferencias-tenancy.test.js tests/repartidor-tenant-isolation.test.js
git commit -m "feat(whatsapp-cloud): template transfer instructions"
```

## Task 9: Preservar WAMID exacto y rechazar identificadores inválidos

**Objective:** Eliminar la sanitización destructiva y usar una validación canónica compartida entre respuesta Graph, outbox y webhook.

**Files:**
- Create: `src/whatsappCloud/messageId.js`
- Modify: `src/whatsappCloud/graphClient.js`
- Modify: `src/whatsappCloud/outboxRepository.js`
- Modify: `src/whatsappCloud/eventRepository.js`
- Modify: `tests/whatsapp-cloud-consumer.test.js`
- Modify: `tests/whatsapp-cloud-webhook.test.js`
- Modify: `tests/whatsapp-cloud-inbox-persistence.test.js`

**Step 1: Escribir tests RED del bug real**

Usar un WAMID válido con `=` final. Probar que Graph→outbox→projection conserva igualdad exacta y que webhook usa el mismo valor. Agregar matrices:

- válidos con uno/dos `=` finales;
- inválidos con whitespace, newline, control chars, `=` interior, longitud >255, prefijo distinto de `wamid.`, objeto/no-string;
- el validador devuelve el string original exacto, no `trim()` ni compactación.

**Step 2: Verificar RED**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/whatsapp-cloud-consumer.test.js \
  tests/whatsapp-cloud-webhook.test.js \
  tests/whatsapp-cloud-inbox-persistence.test.js
```

Expected: FAIL demostrando que `sanitizeMetaMessageId` elimina `=`.

**Step 3: Implementar mínimo**

Crear `validateMetaWamid` y usarlo en los tres límites. Graph success sin WAMID válido retorna `UNKNOWN`; finish nunca persiste un ID transformado; webhook rechaza evento inválido de forma atómica/sanitizada.

**Step 4: Verificar GREEN**

Repetir comando; expected: PASS.

**Step 5: Commit**

```bash
git add src/whatsappCloud/messageId.js src/whatsappCloud/graphClient.js \
  src/whatsappCloud/outboxRepository.js src/whatsappCloud/eventRepository.js \
  tests/whatsapp-cloud-consumer.test.js tests/whatsapp-cloud-webhook.test.js \
  tests/whatsapp-cloud-inbox-persistence.test.js
git commit -m "fix(whatsapp-cloud): preserve exact Meta wamids"
```

## Task 10: Reparación PostgreSQL padding-only, única y tenant-scoped

**Objective:** Reparar filas históricas truncadas sin unir identidades ambiguas ni tocar diferencias no equivalentes.

**Files:**
- Modify: `initDb.sql`
- Modify: `tests/whatsapp-cloud-consumer-postgres.test.js`
- Modify: `tests/whatsapp-cloud-inbox-persistence.test.js`
- Modify: `tests/init-db-canonical-schema-postgres.test.js`

**Step 1: Escribir matriz RED en PostgreSQL real**

Sembrar:

1. Un outbox/projection `wamid.X` y único status same-tenant `wamid.X=` → reparar ambos al exacto.
2. Dos tenants con el mismo valor truncado y exactos distintos → reparar cada tenant por separado.
3. Dos status candidates `wamid.X=`/`wamid.X==` para una fila → no reparar.
4. Dos filas legacy candidatas para un status → no reparar.
5. Colisión exacta ya existente en outbox/projection → no reparar y no violar índices.
6. Diferencia de mayúscula, carácter, prefijo o `=` interior → no reparar.
7. Rerun → cero cambios adicionales.
8. Evento posterior `delivered/read/failed` correlaciona la fila reparada.

**Step 2: Verificar RED**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/whatsapp-cloud-consumer-postgres.test.js \
  tests/whatsapp-cloud-inbox-persistence.test.js \
  tests/init-db-canonical-schema-postgres.test.js
```

Expected: FAIL porque no existe reparación histórica.

**Step 3: Implementar migración segura**

- Ejecutar dentro de la migración de proyección con advisory/table locks ya canónicos.
- Construir candidatos por `empresa_id`, diferencia exclusiva de 1–2 padding `=` finales y validación de ambos lados.
- Exigir cardinalidad 1↔1 con CTEs agrupados antes de actualizar.
- Actualizar outbox y projection en la misma transacción; mantener índices únicos y triggers coherentes.
- No borrar eventos ni reasignar tenants; no loggear IDs.

**Step 4: Verificar GREEN e idempotencia**

Repetir comando; expected: PASS dos veces consecutivas.

**Step 5: Commit**

```bash
git add initDb.sql tests/whatsapp-cloud-consumer-postgres.test.js \
  tests/whatsapp-cloud-inbox-persistence.test.js tests/init-db-canonical-schema-postgres.test.js
git commit -m "fix(whatsapp-cloud): repair unique padded wamids"
```

## Task 11: Estado Meta real en proyección, API y UI

**Objective:** Demostrar end-to-end que `failed`, `delivered` y `read` llegan a la bandeja y se renderizan, incluido WAMID con padding.

**Files:**
- Modify: `tests/whatsapp-cloud-inbox-persistence.test.js`
- Modify: `tests/whatsapp-cloud-inbox-postgres.test.js`
- Modify: `tests/whatsapp-cloud-inbox-admin-api.test.js`
- Modify: `tests/whatsapp-cloud-inbox-frontend.test.js`
- Modify: `tests/whatsapp-cloud-inbox-browser.test.js`
- Modify only if tests expose a defect: `src/whatsappCloud/inboxRepository.js`
- Modify only if tests expose a defect: `pedidos/whatsapp-cloud-ui.js`
- Modify only if tests expose a defect: `pedidos/whatsapp-cloud.js`

**Step 1: Escribir tests RED end-to-end**

Para cada estado `failed`, `delivered`, `read`:

- enviar/sembrar fila con WAMID terminado en `=`;
- ingerir webhook same-tenant;
- comprobar reconciliación monotónica en PostgreSQL;
- consultar listado e historial admin;
- comprobar DTO `lastDeliveryStatus`/`deliveryStatus` sin provider ID;
- comprobar badge español visible y bucket operacional (`failed`→Revisar, delivered/read sin degradación).

**Step 2: Verificar RED**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/whatsapp-cloud-inbox-persistence.test.js \
  tests/whatsapp-cloud-inbox-postgres.test.js \
  tests/whatsapp-cloud-inbox-admin-api.test.js \
  tests/whatsapp-cloud-inbox-frontend.test.js \
  tests/whatsapp-cloud-inbox-browser.test.js
```

Expected: el nuevo test falla antes de Tasks 9–10 o revela el punto exacto restante; no modificar UI si ya pasa.

**Step 3: Implementar sólo el delta necesario**

Conservar `statusMeta`, DTO allowlist, masking, merge monotónico y polling visible-only. No exponer `meta_message_id`/`provider_message_id` para “facilitar” debugging.

**Step 4: Verificar GREEN**

Repetir comando; expected: PASS.

**Step 5: Commit**

```bash
git add tests/whatsapp-cloud-inbox-persistence.test.js tests/whatsapp-cloud-inbox-postgres.test.js \
  tests/whatsapp-cloud-inbox-admin-api.test.js tests/whatsapp-cloud-inbox-frontend.test.js \
  tests/whatsapp-cloud-inbox-browser.test.js src/whatsappCloud/inboxRepository.js \
  pedidos/whatsapp-cloud-ui.js pedidos/whatsapp-cloud.js
git commit -m "test(whatsapp-cloud): verify Meta final statuses in UI"
```

Antes de `git add`, excluir explícitamente los tres archivos de producción marcados “only if” si no cambiaron.

## Task 12: Gates estructurales de seguridad y PII

**Objective:** Bloquear regresiones de frontera, fallback, autorización, secretos y logging sensible.

**Files:**
- Create: `tests/whatsapp-cloud-utility-security.test.js`
- Modify: `tests/wpp-producers.test.js`
- Modify: `tests/production-env-security.test.js`
- Modify: `tests/empresas-route.test.js`

**Step 1: Escribir tests RED/guard tests**

Afirmar mecánicamente:

- un solo INSERT productivo;
- ningún producer importa `graphClient` ni conoce nombres físicos;
- ningún branch contiene Cloud→Web/template→text fallback;
- queries con nuevos campos sensibles llevan `{ sensitive: true }`;
- logs/errores no incluyen parámetros, cuenta, customer/address/phone, WAMID, token, phone-number ID;
- admin no muta mapping y super no puede seleccionar un tenant inexistente/implícito;
- GET/POST/PUT/backup no exponen secretos ni parámetros de outbox agregados;
- no se agregó storage browser, `innerHTML`, retry automático ni páginas bajo `pages/**`.

**Step 2: Verificar RED y corregir hallazgos**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/whatsapp-cloud-utility-security.test.js \
  tests/wpp-producers.test.js \
  tests/production-env-security.test.js \
  tests/empresas-route.test.js
```

Expected final: PASS.

**Step 3: Commit**

```bash
git add tests/whatsapp-cloud-utility-security.test.js tests/wpp-producers.test.js \
  tests/production-env-security.test.js tests/empresas-route.test.js
git commit -m "test(whatsapp-cloud): gate utility template security"
```

## Task 13: Documentación operativa y registro Meta

**Objective:** Dar a operación una secuencia inequívoca para aprobar, mapear, desplegar y verificar las plantillas sin PII.

**Files:**
- Create: `docs/WHATSAPP_CLOUD_UTILITY_TEMPLATES_RUNBOOK.md`
- Modify: `docs/DEPLOY_RUNBOOK.md`
- Modify: `docs/DEPLOY_SECURITY_CHECKLIST.md`
- Create: `tests/whatsapp-cloud-utility-runbook.test.js`

**Step 1: Escribir test RED del runbook**

Exigir los tres contenidos exactos, orden de parámetros, categoría Utility, `es_AR`, botón URL, límite del item block, mapping tenant-scoped, no fallback, WAMID exacto, backup previo, rollback y smoke de estados.

**Step 2: Verificar RED**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test tests/whatsapp-cloud-utility-runbook.test.js
```

Expected: FAIL porque el runbook no existe.

**Step 3: Escribir runbook**

Incluir:

1. Crear/aprobar plantillas en Meta sin datos reales.
2. Confirmar categoría/idioma/componentes y URL button.
3. Configurar nombres sólo después de aprobación.
4. Verificar readiness por empresa.
5. Probar con teléfonos de prueba y datos ficticios.
6. No activar mapping no aprobado.
7. Reconciliar fallos/unknown manualmente; nunca fallback/retry automático.
8. Rollback: retirar sólo mapping afectado, conservar Cloud/replies y no reenviar filas ambiguas.

**Step 4: Verificar GREEN**

Repetir comando; expected: PASS.

**Step 5: Commit**

```bash
git add docs/WHATSAPP_CLOUD_UTILITY_TEMPLATES_RUNBOOK.md docs/DEPLOY_RUNBOOK.md \
  docs/DEPLOY_SECURITY_CHECKLIST.md tests/whatsapp-cloud-utility-runbook.test.js
git commit -m "docs: add WhatsApp utility template runbook"
```

## Task 14: Gate independiente de especificación

**Objective:** Confirmar que la implementación cumple exactamente este plan antes de evaluar estilo o mejoras.

**Files:** Todas las modificadas en Tasks 1–13.

**Step 1: Preparar evidencia reproducible**

```bash
git diff 5142cfad...HEAD --stat
git diff 5142cfad...HEAD -- docs/plans/2026-10-08-whatsapp-cloud-utility-templates.md
```

**Step 2: Ejecutar revisión independiente de spec**

Usar un reviewer nuevo sin contexto de implementación y entregarle: este plan, diff completo y salidas de tests focales. Debe responder por cada invariante `PASS/FAIL` con archivo/línea y sin proponer scope adicional.

**Step 3: Criterio de salida**

Cero FAIL. Corregir con TDD cualquier incumplimiento y repetir revisión completa. No pasar al gate de calidad antes de aprobar spec.

## Task 15: Gate independiente de calidad, seguridad y concurrencia

**Objective:** Detectar defectos técnicos después de aprobar especificación.

**Files:** Todas las modificadas.

**Step 1: Revisar independientemente**

Revisor distinto al de Task 14, con foco en:

- locking y snapshots PostgreSQL;
- cardinalidad/colisiones en reparación WAMID;
- unknown outcomes y no retry/fallback;
- validación de JSON/config legacy hostil;
- tenant isolation/autorización;
- Graph payload y redacción;
- límites de PII/memoria/logs;
- idempotencia de migración y enqueue;
- preservación exacta del texto Web.

**Step 2: Criterio de salida**

Corregir todos los hallazgos Critical/High/Medium con RED→GREEN y repetir ambos gates (spec y calidad). Low sólo puede diferirse con justificación escrita y sin afectar requisitos.

## Task 16: Suite final, backup, deploy y smoke

**Objective:** Probar el cambio completo y desplegarlo con una ruta de recuperación verificable.

**Files:** Ninguno salvo fixes test-first encontrados por gates.

**Step 1: Validación estática**

```bash
git diff --check
git status --short
python3 - <<'PY'
from pathlib import Path
hits=[]
for p in Path('src').rglob('*.js'):
    hits += [str(p)] * p.read_text(encoding='utf-8').lower().count('insert into wpp_outbox')
assert hits == ['src/wpp/enqueue.js'], hits
print('single outbox insert:', hits[0])
PY
test -z "$(git diff --name-only 5142cfad...HEAD -- pages/)"
```

Expected: `diff --check` limpio, un INSERT, y salida vacía para `pages/**`.

**Step 2: Suites focales**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/node --test \
  tests/whatsapp-cloud-utility-templates.test.js \
  tests/wpp-enqueue-shared.test.js \
  tests/wpp-outbox-postgres-integration.test.js \
  tests/whatsapp-cloud-consumer.test.js \
  tests/whatsapp-cloud-consumer-postgres.test.js \
  tests/whatsapp-cloud-webhook.test.js \
  tests/whatsapp-cloud-inbox-persistence.test.js \
  tests/whatsapp-cloud-inbox-postgres.test.js \
  tests/whatsapp-cloud-inbox-admin-api.test.js \
  tests/whatsapp-cloud-inbox-frontend.test.js \
  tests/whatsapp-cloud-inbox-browser.test.js \
  tests/public-create-pedido-success.test.js \
  tests/public-create-pedido-product-identity-postgres.test.js \
  tests/notificaciones-pedidos.test.js \
  tests/empresas-route.test.js \
  tests/empresa-whatsapp-panel.test.js \
  tests/whatsapp-cloud-utility-security.test.js \
  tests/whatsapp-cloud-utility-runbook.test.js
```

Expected: PASS, sin warnings/unhandled rejections.

**Step 3: Suite completa**

```bash
/home/lemac/.nvm/versions/node/v22.22.0/bin/npm test
```

Expected: PASS.

**Step 4: Backup y restore-smoke antes de migrar**

En el entorno destino autorizado:

```bash
npm run db:backup
npm run db:restore-smoke
```

Guardar fuera de logs públicos: timestamp, checksum y ubicación del backup. No imprimir `DATABASE_URL`, tokens ni datos del dump.

**Step 5: Preflight Meta y configuración**

- Confirmar en Meta que las tres plantillas están `APPROVED`, categoría `UTILITY`, idioma `es_AR` y contenido/componentes iguales a este plan.
- Configurar mapping primero en staging para una empresa de prueba.
- Confirmar que teléfonos, tokens, nombres de clientes y cuentas usados en smoke son ficticios/controlados.

**Step 6: Deploy staging web + worker**

Desplegar el mismo commit en `pedivoy-web-staging` y `pedivoy-whatsapp-cloud-worker-staging`. Esperar health verde de ambos; no activar producción aún.

**Step 7: Smoke staging**

```bash
SMOKE_BASE_URL='https://<staging-host>' npm run test:smoke:postdeploy
SMOKE_BASE_URL='https://<staging-host>' npm run test:smoke:security
```

Luego, con empresa/phone de prueba:

1. Crear pedido fuera de ventana 24h → confirmar template `order_confirmation`, texto Web fixture intacto en test, UI `sent`.
2. Pasar a en ruta → botón abre URL canónica con token correcto, sin URL completa como parámetro.
3. Solicitar transferencia → siete campos correctos desde cuenta tenant-scoped.
4. Ingerir/esperar receipts `delivered` y `read`; verificar badges.
5. Forzar rechazo controlado de una plantilla → `failed`/revisión, cero Web fallback y cero duplicado.
6. Verificar un WAMID con `=` si Meta/test number lo produce; si no, usar prueba PostgreSQL ya aprobada y no falsificar producción.
7. Revisar logs por IDs internos únicamente; ausencia de phone/message/address/bank/token/WAMID.

**Step 8: Deploy producción con canary tenant**

Sólo con autorización explícita: desplegar web y worker del mismo commit, ejecutar migración, configurar mapping en una sola empresa canary y repetir smoke. Expandir tenant por tenant; no hacer enable global.

**Step 9: Rollback**

Si falla template/config: quitar únicamente el mapping de la intención afectada para impedir nuevos enqueues Cloud de ese tipo; no cambiar empresa a Web automáticamente y no reenviar filas `dispatch_started`, `outcome_unknown` o con resultado remoto incierto. Si falla código/migración, restaurar release anterior y usar el backup sólo mediante el runbook de restore validado.

**Step 10: Commit de fixes finales, si existieron**

```bash
git add <archivos-corregidos>
git commit -m "fix(whatsapp-cloud): close utility template release gaps"
```

No crear commit vacío.

---

## Definition of Done

- Las tres notificaciones proactivas usan templates Meta fuera de 24h para tenants Cloud con mapping aprobado.
- WhatsApp Web conserva los tres textos exactos previos.
- No existe Cloud→Web ni template→text fallback.
- El único INSERT productivo sigue en `src/wpp/enqueue.js`.
- El mapping es tenant-scoped, server-side, superadmin-managed y secret-safe.
- El item block está acotado y probado.
- WAMID válido se preserva exacto, incluido `=` final.
- Sólo filas históricas padding-only, únicas y same-tenant se reparan.
- `failed`, `delivered` y `read` llegan a PostgreSQL, API y UI de forma monotónica.
- Tests Node focales, PostgreSQL real, browser, suite completa, spec review y quality/security review pasan.
- Backup y restore-smoke pasan antes del deploy; staging/canary smoke confirma no fallback, no duplicados y no PII en logs.
