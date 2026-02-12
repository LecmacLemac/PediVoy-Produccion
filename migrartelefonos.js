import sqlite3 from 'sqlite3';
import pg from 'pg';

const sqlite = sqlite3.verbose();
const { Pool } = pg;

// =========================================================
// 1. CONFIGURACIÓN DE CONEXIÓN (RENDER EXTERNAL URL)
// =========================================================
// Ya tiene tu usuario, contraseña y el host externo correcto.
const connectionString = 'postgresql://data_a09f_user:WnqXxjQ9a3Qwe8Jn87NpkyEy9acePjqB@dpg-d4h9edili9vc73e2hvt0-a.oregon-postgres.render.com/data_a09f';

const pgPool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false // Obligatorio para conectar desde tu PC a Render
  }
});

// =========================================================
// 2. CONFIGURACIÓN SQLITE (ORIGEN)
// =========================================================
const dbSqlite = new sqlite.Database('./data.db', sqlite.OPEN_READONLY);

async function migrarDatos() {
  console.log("🚀 Conectando a Render y leyendo SQLite...");
  
  // Función auxiliar para leer SQLite como promesa
  const leerSQLite = () => {
    return new Promise((resolve, reject) => {
      dbSqlite.all("SELECT * FROM puntos_entrega", [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  };

  try {
    const rows = await leerSQLite();
    console.log(`📦 Se encontraron ${rows.length} registros en SQLite.`);
    
    // Conectamos a Postgres
    const client = await pgPool.connect();
    console.log("✅ Conexión exitosa con Render. Iniciando transacción...");

    try {
      await client.query('BEGIN');

      for (const row of rows) {
        // --- A. LÓGICA DE TELÉFONO ---
        let telefonoFinal = null;
        
        if (row.telefono) {
            // Elimina todo lo que NO sea número (espacios, guiones, letras)
            const soloNumeros = row.telefono.toString().replace(/\D/g, '');
            
            // Agrega 549 si hay números
            if (soloNumeros.length > 0) {
                telefonoFinal = '549' + soloNumeros;
            }
        }

        // --- B. QUERY DE INSERCIÓN ---
        const queryText = `
          INSERT INTO puntos_entrega (
            id, cliente, telefono, telefono_normalizado, direccion, 
            ciudad, provincia, pais, latitud, longitud, notas, empresa_id, zona_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (id) DO UPDATE SET
            telefono = EXCLUDED.telefono,
            telefono_normalizado = EXCLUDED.telefono_normalizado,
            empresa_id = EXCLUDED.empresa_id,
            zona_id = EXCLUDED.zona_id;
        `;

        const values = [
          row.id,
          row.cliente,
          telefonoFinal,     // Teléfono corregido (549...)
          telefonoFinal,     // Normalizado
          row.direccion,
          row.ciudad,
          row.provincia,
          row.pais,
          row.latitud,
          row.longitud,
          row.notas,
          1,                 // FORZADO: Empresa ID 1
          null               // FORZADO: Null para evitar error de Zonas inexistentes
        ];

        await client.query(queryText, values);
      }

      // --- C. CORRECCIÓN DE SECUENCIA ID ---
      // Esto evita errores al crear nuevos clientes en el futuro
      await client.query(`
        SELECT setval('puntos_entrega_id_seq', (SELECT MAX(id) FROM puntos_entrega));
      `);
      
      await client.query('COMMIT');
      console.log("✅ ¡MIGRACIÓN COMPLETADA EXITOSAMENTE!");
      
    } catch (e) {
      await client.query('ROLLBACK');
      console.error("❌ Error durante la transacción (Rollback):", e);
    } finally {
      client.release();
    }

  } catch (err) {
    console.error("❌ Error General:", err);
  } finally {
    dbSqlite.close();
    await pgPool.end();
  }
}

migrarDatos();