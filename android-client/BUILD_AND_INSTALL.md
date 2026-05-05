# Build e instalación

## Compilar
```bash
cd android-client
./gradlew assembleDebug
```

## Compilar contra entorno local opcional
```bash
cd android-client
./gradlew assembleDebug -PpedivoyDebugBaseUrl=http://192.168.0.105:3000/pedidos/app/
```

Si no se especifica `pedivoyDebugBaseUrl`, la build debug apunta a producción.

## APK salida
`app/build/outputs/apk/debug/app-debug.apk`

## APK release
```bash
./gradlew assembleRelease
```

Salida esperada:
`app/build/outputs/apk/release/app-release-unsigned.apk`

## Instalar por ADB
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Uso
- abrir la app PediVoy
- iniciar sesión
- probar catálogo, carrito y envío de pedido
- validar navegación y tiempos de carga

## Nota operativa
Para distribución interna seria conviene firmar la build `release` con keystore propia antes de compartirla al equipo.
