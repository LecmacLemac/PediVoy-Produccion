# Política segura de almacenamiento

PediVoy sólo elimina artefactos regenerables. La autenticación de WhatsApp, los uploads y los almacenes del navegador son datos persistentes y quedan fuera de toda limpieza.

## Alcance y garantías

`config/storage-policy.json` define:

- antigüedad mínima de 14 días, calculada con el elemento más nuevo de cada árbol;
- allowlist cerrada de directorios de caché (`Cache`, `Code Cache`, `GPUCache`, `GrShaderCache`, `ShaderCache`, `DawnCache`);
- segmentos protegidos: `auth`, `.wwebjs_auth`, `storage`, `Local Storage`, `Session Storage`, `IndexedDB`, `uploads`, `DB`, `databases`, `Service Worker` y cualquier nombre que empiece con `Singleton`;
- las dos raíces de perfiles usadas por PediVoy (`.wwebjs_auth` y `wpp_sessions`); una raíz ausente se informa y no aborta la otra;
- múltiples raíces administradas de Puppeteer: la canónica `~/.cache/puppeteer` y la histórica `.puppeteer` del proyecto;
- versiones de Puppeteer esperadas por el `package-lock.json` actual;
- alertas de ocupación del filesystem: `warning` desde 80%, `high` desde 90% y `critical` desde 95%.

El mantenedor:

1. opera en **dry-run por defecto** y sólo borra con `--apply`;
2. rechaza `/`, raíces relativas, raíces que no sean directorios y raíces symlink;
3. no sigue symlinks; un candidato que contiene uno se conserva completo;
4. lee `/proc/*/cmdline`, resuelve aliases reales y conserva perfiles señalados por `--user-data-dir`; errores al leer `cmdline` o rutas relativas de navegador sin `cwd` abortan;
5. conserva, en cada raíz de Puppeteer, las revisiones esperadas por Puppeteer directo y por `whatsapp-web.js`, además de versiones activas o demasiado nuevas;
6. vuelve a validar raíz, symlinks, contenido protegido, edad y actividad justo antes de aplicar;
7. mide el filesystem después de la limpieza y emite JSON con `mode`, `candidates`, `skipped`, `bytes` y `diskUsage` (`usedPercent`, estado y umbrales); el CLI termina con código 2 si sigue en estado `critical`.

Un error de lectura o una política inválida aborta la ejecución: no continúa con una decisión de borrado insegura.

## Ejecución manual

Definir rutas absolutas:

```bash
export WWEBJS_AUTH_ROOT="$PWD/.wwebjs_auth"
export WPP_SESSIONS_ROOT="$PWD/wpp_sessions"
export PUPPETEER_CACHE_DIR="$HOME/.cache/puppeteer"
export LEGACY_PUPPETEER_CACHE_DIR="$PWD/.puppeteer"
export PEDIVOY_STORAGE_PATH="$PWD"
```

Revisar candidatos sin modificar datos:

```bash
node scripts/storage-maintenance.js
```

Aplicar exactamente los candidatos informados:

```bash
node scripts/storage-maintenance.js --apply
```

Puede indicarse otra política con `--policy /ruta/absoluta/policy.json` o `PEDIVOY_STORAGE_POLICY`. Antes de actualizar Puppeteer, actualizar también `puppeteer.expectedVersions` con los nombres reales bajo cada entrada de `puppeteer.cacheRoots`.

## systemd de usuario

Los artefactos de `ops/systemd/` establecen una única unidad canónica de usuario:

- `pedivoy.service`: aplicación, `PUPPETEER_CACHE_DIR=%h/.cache/puppeteer` estable (impuesto en `ExecStart`, por lo que el archivo de entorno no puede devolverlo a la raíz histórica), provisiona antes de arrancar las revisiones de Chrome requeridas por Puppeteer directo y `whatsapp-web.js`, y registra logs exclusivamente en journald;
- `pedivoy-storage-maintenance.service`: limpieza con `--apply` sobre ambas raíces de perfiles y ambas cachés de Puppeteer. La raíz histórica sólo resulta elegible si ninguna ruta de proceso apunta a esa versión;
- `pedivoy-storage-maintenance.timer`: ejecución semanal persistente con demora aleatoria.

El instalador también es dry-run por defecto:

```bash
ops/systemd/install-user-units.sh
```

Si existe un `pedivoy.service` habilitado a nivel sistema, `--apply` aborta **antes de copiar o habilitar unidades**. La unidad de sistema sólo se deshabilita con consentimiento explícito:

```bash
ops/systemd/install-user-units.sh --apply --disable-system-conflict
```

Sin conflicto de ámbito:

```bash
ops/systemd/install-user-units.sh --apply
```

Verificación posterior:

```bash
systemctl --user status pedivoy.service
systemctl --user list-timers pedivoy-storage-maintenance.timer
journalctl --user -u pedivoy.service -n 100 --no-pager
journalctl --user -u pedivoy-storage-maintenance.service -n 100 --no-pager
```

No mantener simultáneamente unidades `pedivoy.service` de sistema y usuario: compiten por el puerto, escriben sobre los mismos perfiles y pueden duplicar logs/procesos.
