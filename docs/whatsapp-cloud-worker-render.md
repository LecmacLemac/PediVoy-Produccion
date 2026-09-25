# Worker standalone de WhatsApp Cloud en Render

`render.yaml` despliega `pedivoy-whatsapp-cloud-worker-staging` como un **background worker** separado. El servicio web conserva `npm start`; no inicia ni supervisa al consumidor Cloud.

## Variables no secretas

| Variable | Valor declarado | Uso |
| --- | ---: | --- |
| `NODE_VERSION` | `22` | Runtime Node compartido con el servicio web. |
| `NODE_ENV` | `production` | Modo de ejecución productivo. |
| `WHATSAPP_GRAPH_VERSION` | `v26.0` | Versión de Graph usada por el cliente existente. |
| `WHATSAPP_CLOUD_POLL_MS` | `1000` | Intervalo entre intentos de consumo. |
| `WHATSAPP_CLOUD_LEASE_MS` | `120000` | Duración del claim de outbox. |
| `WHATSAPP_CLOUD_TIMEOUT_MS` | `8000` | Deadline de una solicitud Graph. |
| `WHATSAPP_CLOUD_CANCEL_TIMEOUT_MS` | `100` | Deadline auxiliar de cancelación. |
| `WHATSAPP_CLOUD_SHUTDOWN_MS` | `10000` | Deadline global de drain y cierre del pool. |

Los valores corresponden a los defaults definidos en `src/whatsappCloud/deadlines.js` y `src/whatsappCloud/graphClient.js`.

## Conexiones y secretos existentes requeridos

- `DATABASE_URL`: se obtiene de `pedivoy-db-staging` mediante `fromDatabase`; no se copia ningún valor.
- `ARCA_TOKEN_ENCRYPTION_KEY`: se referencia desde la variable ya configurada en `pedivoy-web-staging` mediante `fromService`; el worker la necesita para descifrar el access token Cloud persistido. No se declara un segundo secreto ni se documenta su valor.

El access token de Meta permanece cifrado en la configuración de cada empresa. El worker no necesita `WHATSAPP_CLOUD_VERIFY_TOKEN`, porque ese secreto pertenece al webhook servido por el proceso web.
