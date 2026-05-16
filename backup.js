import 'dotenv/config';
import { exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// ----------------------------------------------------
// CONFIGURACIÓN: RUTA A PG_DUMP (VERSIÓN 16)
// ----------------------------------------------------
const PG_BIN_PATH = 'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe'; 

const BACKUP_DIR = path.join(process.cwd(), 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const fileName = `backup_${dateStr}.sql`;
const filePath = path.join(BACKUP_DIR, fileName);

const dbUrl = process.env.DATABASE_URL;

console.log('📦 Iniciando respaldo de la base de datos...');

// Verificamos ejecutable
let dumpCommand = 'pg_dump';
if (fs.existsSync(PG_BIN_PATH)) {
    dumpCommand = `"${PG_BIN_PATH}"`; 
    console.log(`ℹ️  Usando ejecutable local: ${PG_BIN_PATH}`);
} else {
    console.log(`⚠️  No encontré la ruta local. Intentando global...`);
}

// ----------------------------------------------------
// CORRECCIÓN AQUÍ: Agregamos --dbname= antes de la URL
// ----------------------------------------------------
const command = `${dumpCommand} --dbname="${dbUrl}" -O -x --clean --if-exists -f "${filePath}"`;

exec(command, (error, stdout, stderr) => {
  if (error) {
    console.error(`❌ Error al crear backup:`);
    console.error(error.message);
    return;
  }
  if (stderr) {
    // pg_dump suele enviar info al stderr, es normal
    console.log(`ℹ️ Info: ${stderr}`);
  }
  console.log(`✅ Backup completado exitosamente!`);
  console.log(`📂 Archivo guardado en: ${filePath}`);
});