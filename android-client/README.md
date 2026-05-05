# PediVoy Clientes (APK directa de pruebas)

APK Android simple para clientes de PediVoy.

## Objetivo
Abrir el flujo cliente de PediVoy como app:
- URL base: `https://pedivoy.com/pedidos/app/`
- distribución directa para pruebas
- sin Play Store en esta etapa

## Stack
- Android nativo
- Kotlin
- WebView

## Entornos
- producción por defecto: `https://pedivoy.com/pedidos/app/`
- debug local opcional vía propiedad Gradle:

```bash
./gradlew assembleDebug -PpedivoyDebugBaseUrl=http://192.168.0.105:3000/pedidos/app/
```

Si no se informa `pedivoyDebugBaseUrl`, debug también usa producción.

## Build
```bash
cd android-client
./gradlew assembleDebug
```

APK esperada:
- `app/build/outputs/apk/debug/app-debug.apk`

## Publicación interna
- usar `debug` para QA rápida
- usar `release` firmada para distribución interna estable (la build generada por defecto sale unsigned)
- checklist operativo: `INTERNAL_RELEASE_CHECKLIST.md`

## Siguiente mejora recomendada
- ícono propio
- splash de marca
- soporte profundo de notificaciones/push
- integración PWA real del lado web
