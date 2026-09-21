# Política segura de almacenamiento

PediVoy sólo elimina artefactos regenerables. La autenticación de WhatsApp, los uploads y los almacenes del navegador son datos persistentes y quedan fuera de toda limpieza.

## Alcance y garantías

`config/storage-policy.json` define:

- antigüedad mínima de 14 días, calculada con el elemento más nuevo de cada árbol;
- allowlist cerrada de directorios de caché (`Cache`, `Code Cache`, `GPUCache`, `GrShaderCache`, `ShaderCache`, `DawnCache`);
- segmentos protegidos: `auth`, `.wwebjs_auth`, `storage`, `Local Storage`, `Session Storage`, `IndexedDB`, `uploads`, `DB`, `databases`, `Service Worker` y cualquier nombre que empiece con `Singleton`;
- versiones de Puppeteer esperadas por el `package-lock.json` actual.

El mantenedor:

1. opera en **dry-run por defecto** y sólo borra con `--apply`;
2. rechaza `/`, raíces relativas, raíces que no sean directorios y raíces symlink;
3. no sigue symlinks; un candidato que contiene uno se conserva completo;
4. lee `/proc/*/cmdline`, resuelve aliases reales y conserva perfiles señalados por `--user-data-dir`; errores al leer `cmdline` o rutas relativas de navegador sin `cwd` abortan;
5. conserva las revisiones esperadas por Puppeteer directo y por `whatsapp-web.js`, además de versiones activas o demasiado nuevas;
6. vuelve a validar raíz, symlinks, contenido protegido, edad y actividad justo antes de aplicar;
7. emite JSON con `mode`, `candidates`, `skipped` y `bytes`.

Un error de lectura o una política inválida aborta la ejecución: no continúa con una decisión de borrado insegura.

## Ejecución manual

Definir rutas absolutas:

```bash
export DISK_PATH="$PWD/.wwebjs_auth" # o la ruta persistente ya usada por PediVoy
export PUPPETEER_CACHE_DIR="$PWD/.puppeteer"
```

Revisar candidatos sin modificar datos:

```bash
node scripts/storage-maintenance.js
```

Aplicar exactamente los candidatos informados:

```bash
node scripts/storage-maintenance.js --apply
```

Puede indicarse otra política con `--policy /ruta/absoluta/policy.json` o `PEDIVOY_STORAGE_POLICY`. Antes de actualizar Puppeteer, actualizar también `puppeteer.expectedVersions` con los nombres reales bajo `$PUPPETEER_CACHE_DIR/<producto>/`.

## systemd de usuario

Los artefactos de `ops/systemd/` establecen una única unidad canónica de usuario:

- `pedivoy.service`: aplicación, `PUPPETEER_CACHE_DIR` estable y logs exclusivamente en journald;
- `pedivoy-storage-maintenance.service`: limpieza con `--apply`;
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
