const { google } = require('googleapis');
const db = require('./db');
const { CREDENTIALS_PATH, SPREADSHEET_ID } = require('./config');
const fs = require('fs');

// Cargar auth de Google
async function autorizar() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return await auth.getClient();
}

// Lee la hoja "Zona" del spreadsheet
async function leerDatosZonas() {
  const authClient = await autorizar();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Zona!A2:D',
  });

  return res.data.values;
}

// Agrupa por ID para formar polígonos
function agruparPorZona(datos) {
  const zonas = {};

  for (const fila of datos) {
    let [lat, lon, id, nombre] = fila;
    if (!lat || !lon || !id || !nombre) continue;

    // Convertir coma a punto y parsear
    lat = parseFloat(lat.replace(',', '.'));
    lon = parseFloat(lon.replace(',', '.'));

    if (!zonas[id]) {
      zonas[id] = { nombre, coordenadas: [] };
    }
    zonas[id].coordenadas.push([lat, lon]);
  }

  return Object.values(zonas);
}

// Inserta zonas en SQLite
async function insertarZonas(zonas) {
  for (const zona of zonas) {
    const poligonoJSON = JSON.stringify(zona.coordenadas);

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO zonas_geograficas (nombre, poligono) VALUES (?, ?)`,
        [zona.nombre, poligonoJSON],
        (err) => {
          if (err) {
            console.error('❌ Error insertando zona:', err);
            reject(err);
          } else {
            console.log(`✅ Zona '${zona.nombre}' insertada.`);
            resolve();
          }
        }
      );
    });
  }
}

async function main() {
  try {
    const datos = await leerDatosZonas();
    const zonas = agruparPorZona(datos);
    await insertarZonas(zonas);
    console.log('🎉 Importación de zonas completada.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error general:', error);
    process.exit(1);
  }
}

main();
