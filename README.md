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

- Node.js **20.x** (requerido; ver `package.json` → `engines.node`).
  - Si usás nvm: `nvm install 20 && nvm use 20` (hay `.nvmrc`).
  - Más detalle: `docs/NODE.md`.
- (Override) `ALLOW_NODE_MISMATCH=1` para arrancar igual, no recomendado.

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
OPENAI_API_KEY=sk-tu-api-key-openai
# Opcional para WebPush
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...


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

🤝 Contribución

Las Pull Requests son bienvenidas. Para cambios mayores, por favor abre un issue primero para discutir lo que te gustaría cambiar.

📄 Licencia

MIT