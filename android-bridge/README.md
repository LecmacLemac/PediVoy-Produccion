# Android Bridge — PediVoy

Bridge local para disparar llamadas desde un Android conectado por USB usando ADB.

## Requisitos
- Android con depuración USB habilitada
- `adb` instalado en la PC
- teléfono autorizado en `adb devices`

## Variables
```env
ANDROID_BRIDGE_PORT=8787
ANDROID_BRIDGE_TOKEN=cambiar_token
ADB_PATH=adb
ANDROID_SERIAL=
ANDROID_DEFAULT_COUNTRY_PREFIX=+54
ANDROID_BRIDGE_MODE=helper
```

## Instalar
```bash
cd android-bridge
npm install
```

## Ejecutar
```bash
npm start
```

## Endpoints
- `GET /health`
- `GET /device`
- `POST /call`
- `POST /hangup`
- `GET /call-status`

## Modos de llamada
- `helper` → usa el broadcast de `PediVoy Call Helper` (recomendado)
- `call` → usa `android.intent.action.CALL`
- `dial` → abre el dialer

## Prueba rápida
```bash
curl -X POST http://localhost:8787/call \
  -H "Content-Type: application/json" \
  -H "x-bridge-token: cambiar_token" \
  -d '{"phone":"+5493511234567"}'
```

## Nota
Si `CALL` falla por permisos o UI, el bridge cae a `DIAL` como fallback.
