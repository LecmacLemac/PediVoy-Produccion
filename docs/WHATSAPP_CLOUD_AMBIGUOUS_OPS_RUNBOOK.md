# Runbook: estados ambiguos de WhatsApp Cloud

Esta herramienta es **opt-in**, corre sólo como CLI y no expone endpoints HTTP. Antes de usarla, ejecutar la migración idempotente con `npm run init-db` por el proceso normal de despliegue.

## Reglas de seguridad

- Consultar Meta antes de replay. No inferir “no enviado” por timeout, caída del worker o ausencia de respuesta local.
- `dispatch_started` y `outcome_unknown` nunca se reintentan directamente. Primero reconciliar en Meta y luego resolver manualmente.
- No copiar teléfonos, mensajes, configuración ni payloads en argumentos, tickets o razones. Los códigos `--reason` son allowlisted.
- `--actor` identifica al operador y no es secreto. Puede definirse con `WHATSAPP_CLOUD_OPS_ACTOR`.
- Cada mutación requiere `--confirm <acción>:<id>` exacto. Verificar el ID nuevamente antes de ejecutar.
- La salida es JSON sanitizado. La CLI no imprime credenciales ni la cadena de conexión.

## Listar casos

```bash
npm run ops:whatsapp-cloud -- list
npm run ops:whatsapp-cloud -- list --empresa-id 7 --state outcome_unknown --limit 50
npm run ops:whatsapp-cloud -- list --include-definitive-failed
```

El listado contiene únicamente: `id`, `empresa_id`, `status`, `cloud_dispatch_state`, timestamps, un código de error allowlisted y `meta_message_id` sanitizado.

## Resolver `dispatch_started` huérfano

1. Buscar el envío en Meta usando la evidencia operativa disponible fuera de esta CLI.
2. Si Meta confirma entrega/aceptación y entrega un ID válido:

```bash
npm run ops:whatsapp-cloud -- mark-sent --id <id> --actor <actor> \
  --meta-message-id <wamid> --confirm mark-sent:<id>
```

3. Si Meta confirma un fallo definitivo:

```bash
npm run ops:whatsapp-cloud -- mark-failed --id <id> --actor <actor> \
  --reason meta_rejected --confirm mark-failed:<id>
```

4. Si Meta confirma que no fue enviado, habilitar el replay en un paso separado:

```bash
npm run ops:whatsapp-cloud -- confirm-not-sent --id <id> --actor <actor> \
  --reason meta_confirmed_not_sent --confirm confirm-not-sent:<id>
```

## Resolver `outcome_unknown`

Aplicar la misma reconciliación con Meta. No ejecutar `replay` sobre `outcome_unknown`. Usar `mark-sent`, `mark-failed` o `confirm-not-sent` según la evidencia confirmada.

Si Meta no permite determinar el resultado, mantener la fila en `outcome_unknown`, documentar el caso fuera de la base sin PII y escalar. No convertir incertidumbre en reenvío.

## Caso 429 / `manual_retryable`

Un 429 es un rechazo remoto explícito: queda en `manual_retryable`, no hay retry automático y no requiere `confirm-not-sent`. El operador puede ejecutar el replay directamente, después de verificar que la fila corresponde al 429 esperado, revisar el riesgo de duplicado operativo y escribir la confirmación fuerte ligada al ID:

```bash
npm run ops:whatsapp-cloud -- replay --id <id> --actor <actor> \
  --reason manual_replay --confirm replay:<id>
```

El replay es una decisión manual auditada. Reutiliza la misma fila, vuelve a `pending`/Cloud, limpia claim y lifecycle previo, y no crea una fila nueva ni evita la deduplicación existente. Si la fila está en `dispatch_started` u `outcome_unknown`, no aplicar este flujo: reconciliar primero con Meta y usar `confirm-not-sent` únicamente cuando exista evidencia de no envío.

## Códigos de error visibles en listados

El listado sólo expone códigos sanitizados que el consumer, Graph o una acción operativa pueden persistir. Los códigos Cloud reales son: `cloud_payload_invalid`, `cloud_rate_limited`, `cloud_remote_rejected`, `cloud_dispatch_unknown`, `cloud_token_invalid` y `cloud_config_invalid`. También pueden aparecer los códigos operativos allowlisted documentados abajo. Un valor desconocido o texto libre se devuelve como `null`; nunca se muestra el campo `error` original.

## Códigos permitidos

- Fallo definitivo: `meta_rejected`, `recipient_invalid`, `policy_blocked`, `template_invalid`, `auth_invalid`, `cloud_config_invalid`.
- Confirmación de no envío para `dispatch_started`/`outcome_unknown`: `meta_confirmed_not_sent`, `meta_no_delivery_record`.
- Replay: `manual_replay`.

## Fallos cerrados

- `OPS_STALE_STATE`: otra operación cambió la fila o el estado no permite la acción. Volver a listar y reconciliar; no repetir a ciegas.
- `OPS_NOT_FOUND`: ID inexistente o transporte distinto de Cloud.
- `OPS_COMMIT_OUTCOME_UNKNOWN`: no repetir la mutación. Consultar la fila y la auditoría para determinar si el commit quedó aplicado.
- Cualquier error de confirmación o argumento: corregir el comando; no relajar los controles.
