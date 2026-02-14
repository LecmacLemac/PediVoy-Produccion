# Node / Entorno (PediVoy)

Este proyecto **requiere Node 20.x** (ver `package.json` → `engines.node=20.x`).

Motivo: se usan dependencias con **addons nativos** (ej. `canvas`) que pueden fallar por ABI mismatch si se corre con Node 22+.

## Recomendado (dev)

### Usando nvm
```bash
nvm install 20
nvm use 20
node -v
npm ci
```

### Levantar el server sin WhatsApp (evita conflictos de Chromium/WWebJS)
```bash
ENABLE_WPP=0 npm start
```

## Override (solo si sabés lo que hacés)
Podés permitir arrancar con otra versión de Node:
```bash
ALLOW_NODE_MISMATCH=1 npm start
```

(No recomendado: puede romper `canvas`, `puppeteer` o WhatsApp Web.)
