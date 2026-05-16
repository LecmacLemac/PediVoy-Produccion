# PediVoy + Android USB + ADB

## Estado actual
Existe un bridge local en `android-bridge/` para disparar llamadas desde un Android conectado por USB.

## Pasos
1. Instalar ADB en la PC
2. Activar modo desarrollador en Android
3. Activar depuración USB
4. Autorizar la PC en el teléfono
5. Ejecutar:

```bash
adb devices
```

Debe aparecer el serial como `device`.

## Instalar bridge
```bash
cd android-bridge
npm install
npm start
```

## Variables sugeridas
```env
CALL_PROVIDER=android_bridge
ANDROID_BRIDGE_BASE_URL=http://127.0.0.1:8787
ANDROID_BRIDGE_PORT=8787
ANDROID_BRIDGE_TOKEN=cambiar_token
ANDROID_BRIDGE_MODE=helper
ANDROID_DEFAULT_COUNTRY_PREFIX=+54
```

## Siguiente integración
Una vez validado el bridge:
- conectar PediVoy backend al endpoint `POST /call`
- crear `call_session`
- abrir el workspace del asistente
