# Android Helper App — PediVoy

## Objetivo
Pasar de `adb + DIAL` semiautomático a llamada automática real usando una app Android propia con permiso `CALL_PHONE`.

## Qué incluye el esqueleto
- proyecto Android nativo en `android-helper/`
- `MainActivity` para pedir permisos
- `BroadcastReceiver` para recibir la orden de llamada

## Comando objetivo
```bash
adb shell am broadcast \
  -a com.pedivoy.callhelper.CALL \
  -n com.pedivoy.callhelper/.CallCommandReceiver \
  --es phone +5493511234567
```

## Próximo paso técnico
- compilar APK
- instalar en el teléfono
- abrir una vez y conceder permisos
- probar broadcast
- después cambiar el bridge Node para usar este método

## Guía rápida de build
Ver `android-helper/BUILD_AND_INSTALL.md`.
