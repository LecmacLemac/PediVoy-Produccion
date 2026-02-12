// src/wppMultiWorker.js
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { query } from './db.js';

const activeClients = {}; // { empresaId: ClientInstance }

async function iniciarSesionesActivas() {
  // Buscamos empresas que tengan el WhatsApp habilitado o "connected"
  const empresas = await query("SELECT id FROM empresas WHERE wpp_status != 'disconnected'");
  
  for (const emp of empresas) {
    await spawnClient(emp.id);
  }
}

async function spawnClient(empresaId) {
  if (activeClients[empresaId]) return;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `empresa_${empresaId}` }),
    puppeteer: { 
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH 
    }
  });

  // Eventos de QR y Ready (como los definimos antes)
  // ... (código de guardado en DB) ...

  await client.initialize();
  activeClients[empresaId] = client;
}

// Iniciar proceso
iniciarSesionesActivas();