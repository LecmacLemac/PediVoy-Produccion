# Build & Install — PediVoy Call Helper

## Bloqueos actuales del host
Para compilar en esta PC hacen falta:
- Java JDK 17+
- Gradle o Android Studio

## Opción recomendada: Android Studio
1. Abrir `android-helper/` en Android Studio
2. Dejar que descargue SDK/Gradle
3. Conectar el teléfono por USB
4. Abrir la app y tocar **Run**

## Opción CLI mínima
### Instalar Java
```bash
sudo apt-get update
sudo apt-get install -y openjdk-17-jdk
```

### Instalar Gradle
```bash
sudo apt-get install -y gradle
```

### Crear wrapper
```bash
cd /home/lemac/.openclaw/workspace-pedivoy/PediVoy/android-helper
gradle wrapper
```

### Compilar debug APK
```bash
./gradlew assembleDebug
```

### Instalar en el teléfono
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Primer arranque
1. abrir `PediVoy Call Helper` en el teléfono
2. conceder `CALL_PHONE`
3. dejar la app abierta la primera vez

## Prueba manual del receiver
```bash
adb shell am broadcast \
  -a com.pedivoy.callhelper.CALL \
  -n com.pedivoy.callhelper/.CallCommandReceiver \
  --es phone +5493534211800
```

## Resultado esperado
- la app recibe el broadcast
- Android inicia la llamada
