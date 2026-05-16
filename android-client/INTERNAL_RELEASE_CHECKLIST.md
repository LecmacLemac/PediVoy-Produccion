# PediVoy Android Client — Checklist de publicación interna

## Objetivo
Dejar una APK apta para prueba interna ordenada, repetible y con control mínimo de calidad.

## Estado objetivo
- APK compilada sin errores
- flujo principal validado en dispositivo real
- entorno correcto confirmado
- versión identificable
- instructivo de instalación compartible

## Pre-publicación técnica
- [ ] `./gradlew assembleDebug` compila sin errores
- [ ] `./gradlew assembleRelease` compila sin errores
- [ ] la URL objetivo está confirmada
- [ ] si debug usa entorno local, se documentó la URL usada
- [ ] la app abre PediVoy sin pantalla en blanco
- [ ] la navegación hacia atrás funciona bien
- [ ] enlaces externos (WhatsApp, tel, navegador) responden correctamente
- [ ] selector de archivos funciona si el flujo lo usa

## QA funcional mínima
- [ ] login exitoso
- [ ] navegación por catálogo
- [ ] agregar productos al carrito
- [ ] editar/eliminar productos del carrito
- [ ] enviar pedido completo
- [ ] validar tiempos de carga
- [ ] validar reconexión tras pérdida de internet

## QA visual mínima
- [ ] nombre de app correcto: `PediVoy`
- [ ] toolbar visible y legible
- [ ] barra de estado no tapa contenido
- [ ] mensajes de carga / error son claros

## Distribución interna
- [ ] definir si se comparte `debug` o `release`
- [ ] si se comparte `release`, firmarla con keystore
- [ ] nombrar versión testeada
- [ ] registrar fecha de build
- [ ] compartir APK con breve instructivo

## Recomendación gerencial
### Para pruebas rápidas
- usar `debug`
- apuntar a producción salvo necesidad real de local

### Para pruebas internas formales
- usar `release` firmada
- documentar versión, fecha y hallazgos

## Comandos base
```bash
cd android-client
./gradlew assembleDebug
./gradlew assembleRelease
```

## Build debug local opcional
```bash
./gradlew assembleDebug -PpedivoyDebugBaseUrl=http://192.168.0.105:3000/pedidos/app/
```

## Observaciones abiertas
- falta ícono propio
- falta splash de marca
- falta estrategia de firma release
- falta validar en dispositivo real
