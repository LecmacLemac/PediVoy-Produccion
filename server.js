// server.js
// Entry-point: crea la app y levanta el server HTTP.

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createApp } from './src/app.js';
import { createServerDeps, getServerEnv, startServer } from './src/bootstrap/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { PORT } = getServerEnv();

const deps = createServerDeps({ projectDir: __dirname });
const app = createApp(deps);

startServer(app, { PORT });
