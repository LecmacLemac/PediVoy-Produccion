# PediVoy + Asterisk — setup mínimo operativo

## Objetivo
Habilitar campañas de llamadas salientes desde PediVoy usando Asterisk.

## 1. Variables `.env`
Agregar estas variables en el backend de PediVoy:

```env
ASTERISK_ENABLED=1

# ARI
ASTERISK_ARI_BASE_URL=http://127.0.0.1:8088/ari
ASTERISK_ARI_USERNAME=pedivoy
ASTERISK_ARI_PASSWORD=CAMBIAR_ESTA_CLAVE
ASTERISK_ARI_APP=pedivoy-call-app

# AMI
ASTERISK_AMI_HOST=127.0.0.1
ASTERISK_AMI_PORT=5038
ASTERISK_AMI_USERNAME=pedivoy
ASTERISK_AMI_PASSWORD=CAMBIAR_ESTA_CLAVE
ASTERISK_AMI_RECONNECT_MS=5000

# Discado
ASTERISK_ENDPOINT_TEMPLATE=PJSIP/{phone}@proveedor-trunk
ASTERISK_CALLER_ID=PediVoy

# Webhook interno opcional
ASTERISK_WEBHOOK_SECRET=CAMBIAR_OTRA_CLAVE
```

## 2. `ari.conf`
Ejemplo mínimo:

```ini
[general]
enabled = yes
pretty = yes
allowed_origins = *

[pedivoy]
type = user
read_only = no
password = CAMBIAR_ESTA_CLAVE
```

## 3. `manager.conf`
Ejemplo mínimo:

```ini
[general]
enabled = yes
webenabled = no
port = 5038
bindaddr = 0.0.0.0

[pedivoy]
secret = CAMBIAR_ESTA_CLAVE
read = all
write = all
permit = 127.0.0.1/255.255.255.0
```

## 4. `http.conf`
Para exponer ARI:

```ini
[general]
enabled = yes
bindaddr = 0.0.0.0
bindport = 8088
```

## 5. `pjsip.conf`
Trunk de ejemplo:

```ini
[proveedor-trunk]
type = endpoint
transport = transport-udp
context = from-pstn
outbound_auth = proveedor-trunk-auth
aors = proveedor-trunk-aor
from_user = TU_USUARIO
from_domain = sip.tu-proveedor.com
disallow = all
allow = ulaw,alaw

[proveedor-trunk-auth]
type = auth
auth_type = userpass
username = TU_USUARIO
password = TU_PASSWORD

[proveedor-trunk-aor]
type = aor
contact = sip:sip.tu-proveedor.com
```

## 6. Dialplan mínimo `extensions.conf`
Este bloque deja a Asterisk recibir la llamada originada por ARI.

```ini
[pedivoy-outbound]
exten => _X.,1,NoOp(PediVoy outbound call)
 same => n,Set(__SESSION_ID=${SESSION_ID})
 same => n,Set(__EMPRESA_ID=${EMPRESA_ID})
 same => n,Set(__CAMPAIGN_ID=${CAMPAIGN_ID})
 same => n,Dial(PJSIP/${EXTEN}@proveedor-trunk,30)
 same => n,Hangup()
```

## 7. Recomendación de originate
Si el trunk necesita prefijo o formato E.164, ajustar:

```env
ASTERISK_ENDPOINT_TEMPLATE=PJSIP/549{phone}@proveedor-trunk
```

o directamente normalizar antes de enviar.

## 8. Reinicio
Después de cambios:

```bash
asterisk -rx "module reload res_ari.so"
asterisk -rx "module reload res_pjsip.so"
asterisk -rx "dialplan reload"
asterisk -rx "manager reload"
asterisk -rx "http reload"
```

## 9. Prueba mínima
1. aplicar `initDb.sql`
2. reiniciar PediVoy
3. crear campaña
4. importar un contacto
5. activar campaña
6. ejecutar:

```bash
curl -X POST http://localhost:3000/api/call-dispatch/run \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":1}'
```

## 10. Qué debería pasar
- PediVoy crea `call_session`
- ARI manda `originate`
- AMI informa `DialBegin`, `DialEnd`, `Hangup`
- la sesión queda persistida en DB

## 11. Siguiente fase
Cuando esto funcione, el próximo paso es:
- bridge de audio con IA
- transferencia humana real a cola/extensión
- métricas y reintentos finos
