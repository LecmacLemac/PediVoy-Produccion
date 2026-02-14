// server.js
// Entry-point: crea la app y levanta el server HTTP.

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createApp } from './src/app.js';
import { createServerDeps } from './src/bootstrap/createServerDeps.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

const deps = createServerDeps({ projectDir: __dirname });
const app = createApp(deps);

app.listen(PORT, () => console.log(`🚀 Servidor unificado corriendo en puerto ${PORT}`));
