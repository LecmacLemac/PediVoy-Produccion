💧 Hidro-V1: Sistema de Logística y Reparto con IA

Plataforma integral (ERP/CRM) para empresas de reparto de última milla (agua, soda, logística), con capacidad multi-empresa, geolocalización avanzada y un asistente virtual impulsado por IA.

🚀 Características Principales

🧠 Inteligencia Artificial & Automatización

Bot de WhatsApp (GPT-4o): Atiende clientes, toma pedidos y responde consultas sobre precios/stock con personalidad configurable por empresa.

Procesamiento de Pagos: Lectura automática de comprobantes de transferencia bancaria (imágenes/PDF) usando IA Vision.

Geocodificación Inteligente: Detecta coordenadas de clientes y asigna zonas de reparto automáticamente.

🚚 Logística y Choferes

App de Repartidor: Dashboard para ver pedidos del día, rendir gastos y consultar sus ganancias.

Zonas Geográficas: Dibujado de zonas en mapa (polígonos) y asignación automática de choferes a zonas.

Tracking: Enlace público para que el cliente vea al repartidor en tiempo real.

🏢 Gestión Multi-Empresa (SaaS)

Arquitectura preparada para alojar múltiples empresas en una sola instancia.

Configuración independiente de productos, precios, choferes y prompts de IA.

🛠️ Stack Tecnológico

Backend: Node.js, Express.

Base de Datos: PostgreSQL + PostGIS (Geospatial).

IA: OpenAI API (GPT-4o, GPT-4o-mini).

Mensajería: whatsapp-web.js.

Infraestructura: Soporte para WebPush, Multer (archivos), JWT (Auth).

⚙️ Instalación y Despliegue

Requisitos previos

- Node.js **22.x** (requerido; ver `package.json` → `engines.node`).
  - Si usás nvm: `nvm install 22 && nvm use 22` (hay `.nvmrc` si el entorno la define).
  - Más detalle: `docs/NODE.md`.
- (Override) `ALLOW_NODE_MISMATCH=1` para arrancar igual, no recomendado.
- Poppler / `pdftoppm` para convertir comprobantes PDF de transferencias a imagen.
  - Debian/Ubuntu: `sudo apt-get install poppler-utils`.
  - Render: queda declarado en `Aptfile`.

PostgreSQL con extensión PostGIS instalada.

PostgreSQL con extensión PostGIS instalada.

Una cuenta de OpenAI (API Key).

1. Clonar y Dependencias

git clone [https://github.com/LecmacLemac/Hidro-V1.git](https://github.com/LecmacLemac/Hidro-V1.git)
cd Hidro-V1
npm install


2. Configuración de Base de Datos

Crea una base de datos en PostgreSQL y ejecuta el script de inicialización:

psql -U tu_usuario -d hidro_db -f initDb.sql


3. Variables de Entorno (.env)

Crea un archivo .env en la raíz:

PORT=3000
DATABASE_URL=postgres://usuario:pass@localhost:5432/hidro_db
JWT_SECRET=tu_secreto_super_seguro
OPENAI_API_KEY=tu-api-key-openai
ARCA_TOKEN_ENCRYPTION_KEY=secreto-largo-para-cifrar-credenciales-arca
# Opcional para WebPush
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...

# Seguridad recomendada
# Allowlist CORS explícita (CSV de orígenes permitidos)
CORS_ALLOWED_ORIGINS=https://pedivoy.com,https://www.pedivoy.com

# Requerido para endpoints internos /internal/cron/*
CRON_SECRET=un-secreto-largo-y-aleatorio


### Bootstrap del administrador global (runbook)

Después de inicializar la base de datos, configura `DATABASE_URL` y ejecuta explícitamente:

```bash
export BOOTSTRAP_SUPER_USERNAME='super.ops'
read -r -s -p 'Contraseña del super: ' BOOTSTRAP_SUPER_PASSWORD
printf '\n'
export BOOTSTRAP_SUPER_PASSWORD
npm run bootstrap-super
unset BOOTSTRAP_SUPER_USERNAME BOOTSTRAP_SUPER_PASSWORD
```

`BOOTSTRAP_SUPER_USERNAME` admite entre 3 y 64 caracteres: letras ASCII, números, punto, guion y guion bajo, sin espacios. `BOOTSTRAP_SUPER_PASSWORD` requiere al menos 12 caracteres, mayúscula, minúscula, número y símbolo. También pueden inyectarse mediante el gestor de secretos del despliegue.

El comando crea un único `super` global activo (`empresa_id=NULL`). Repetirlo con credenciales de entorno válidas termina correctamente sin cambios si ya existe exactamente un super canónico activo y válido; no cambia su contraseña. Variantes como `SUPER` o ` super `, cuentas super inactivas, múltiples super o datos inválidos hacen que aborte. Ante un rechazo, revisar esas filas antes de reintentar. No se ejecuta automáticamente con `start` ni con `init-db`.

La migración deja inactivas las cuentas con rol NULL, `guest` o no canónico al convertir su rol a `user`; requieren revisión explícita antes de reactivarlas. Las filas con roles canónicos y estado de tenant o vínculos incoherente se desactivan; las identidades coherentes conservan su estado activo o inactivo. El alta de empresas sigue en `signup-full`; `/api/auth/guest` y `/api/auth/register` están retirados (410).

Las pruebas de integración SQL usan un clúster PostgreSQL temporal dentro del worktree, sin usar `DATABASE_URL`. Requieren los binarios de servidor (`pg_config`, `initdb`, `pg_ctl`) y un usuario no root; si faltan, Node informa esas pruebas como omitidas.

4. Ejecutar

# Modo desarrollo
npm run dev

# Modo producción
npm start


5. Vinculación de WhatsApp

Al iniciar, la consola mostrará un código QR (o visita /api/whatsapp/qr). Escanéalo con tu WhatsApp para vincular el bot.

📂 Estructura del Proyecto

/src: Lógica de negocio modular.

handlers.js: Lógica del Bot de WhatsApp.

transferenciasPipeline.js: Procesamiento de imágenes de pago.

services.js: Utilidades core (DB, Auth, Geo).

server.js: Servidor Express y configuración de rutas.

initDb.sql: Schema de base de datos.

## 🧭 Operación técnica (nuevo)

- Changelog técnico de mejoras recientes: `docs/CHANGELOG_TECH_2026-02-14.md`
- Checklist de seguridad para deploy: `docs/DEPLOY_SECURITY_CHECKLIST.md`
- Setup operativo de telefonía: `docs/ASTERISK_PEDIVOY_SETUP.md`
- Setup MVP Android USB/ADB: `docs/ANDROID_BRIDGE_SETUP.md`
- Android helper app para llamadas automáticas: `docs/ANDROID_HELPER_APP.md`
- Runbook de staging/producción/rollback: `docs/DEPLOY_RUNBOOK.md`

### Smoke post-deploy (rápido)

```bash
# público (sin credenciales)
SMOKE_BASE_URL=https://tu-dominio.com npm run test:smoke:postdeploy

# público + auth (si pasás usuario/clave de prueba)
SMOKE_BASE_URL=https://tu-dominio.com \
SMOKE_USER=usuario_test \
SMOKE_PASS=clave_test \
npm run test:smoke:postdeploy

# security headers (strict)
SMOKE_BASE_URL=https://tu-dominio.com npm run test:smoke:security
```

🤝 Contribución

Las Pull Requests son bienvenidas. Para cambios mayores, por favor abre un issue primero para discutir lo que te gustaría cambiar.

📄 Licencia

MIT
