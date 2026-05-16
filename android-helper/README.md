# PediVoy Call Helper (Android)

App helper mínima para permitir que PediVoy dispare llamadas reales desde Android.

## Qué hace
- pide permiso `CALL_PHONE`
- expone un `BroadcastReceiver` exportado
- cuando recibe la acción `com.pedivoy.callhelper.CALL`, inicia la llamada

## Flujo esperado
1. instalar la app en el teléfono
2. abrir la app una vez y conceder `CALL_PHONE`
3. desde la PC enviar:

```bash
adb shell am broadcast \
  -a com.pedivoy.callhelper.CALL \
  -n com.pedivoy.callhelper/.CallCommandReceiver \
  --es phone +5493511234567
```

## Siguiente integración
El bridge Node debe cambiar de `ACTION_DIAL` a este broadcast.

## Notas
- primer corte: sin colgar automático ni lectura de estado
- si el fabricante del teléfono restringe llamadas desde background, puede requerir dejar la app visible o ajustarla a `default dialer`
