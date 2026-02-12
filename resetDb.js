// resetDb.js — "Smart Reset" (Versión: Preservar Todo MENOS Logs Pesados)
// 1. Respalda Empresas, Usuarios, Productos, Clientes, PEDIDOS y DINERO.
// 2. Ignora tablas pesadas (GPS, PageViews) para ahorrar memoria.
// 3. Borra la DB y la recrea con initDb.sql.
// 4. Restaura los datos respaldados.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// CONFIGURACIÓN DE TABLAS A PRESERVAR
// =============================================================================
// Se mantienen los datos de negocio (Dinero, Pedidos, Stock).
// Se EXCLUYEN: pedido_track_points, page_views (Logs pesados).

const SAFE_TABLES = [
  // --- NIVEL 1: Estructura Base ---
  'empresas',
  'usuarios',
  'configuracion',             

  // --- NIVEL 2: Actores y Configuración ---
  'choferes',
  'zonas_geograficas',
  'productos',
  'empresa_prompts',           
  'empresa_cuentas_bancarias', 
  'push_subs',                 

  // --- TABLAS EXTRAS (Requeridas por usuario) ---
  'empresa_costos_fijos',       
  'empresa_productos_costos',   
  'producto_prefs',            

  // --- NIVEL 3: Clientes y Logística Base ---
  'puntos_entrega',
  'zona_chofer',               
  'chofer_escalas',            
  'chofer_escala_tramos',
  'chofer_costos',             

  // --- NIVEL 4: MOVIMIENTOS ---
  'pedidos',                   
  'items_pedido',              
  'transferencias',            
  'comprobantes_transferencia',
  'gastos_repartidor',         
  'chofer_stock',              
  'chofer_stock_mov',          
  'cliente_recompensas',       
  'push_sub_pedidos',          
  'wpp_outbox'                 
];

async function run() {
  const sqlPath = path.join(__dirname, 'initDb.sql');
  
  if (!fs.existsSync(sqlPath)) {
    console.error('❌ No se encontró el archivo initDb.sql');
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  const client = await pool.connect();
  
  const backup = {};

  try {
    console.log('🛡️  INICIANDO SMART RESET (Modo: Preservar Negocio - Limpiar Logs)...');
    console.log('   Objetivo: Mantener Pedidos/Dinero. Borrar GPS/Analytics.');

    // ---------------------------------------------------------
    // 1. BACKUP EN MEMORIA
    // ---------------------------------------------------------
    console.log('\n💾 1. Respaldando datos importantes...');
    
    for (const table of SAFE_TABLES) {
      try {
        const check = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_name = $1
          );
        `, [table]);

        if (check.rows[0].exists) {
          const res = await client.query(`SELECT * FROM ${table}`);
          backup[table] = res.rows;
          console.log(`   ✅ ${table.padEnd(28)}: ${res.rowCount} registros guardados.`);
        } else {
          console.log(`   ⚠️ ${table.padEnd(28)}: No existe (se creará vacía).`);
          backup[table] = [];
        }
      } catch (err) {
        console.warn(`   ❌ Error respaldando ${table}:`, err.message);
        backup[table] = [];
      }
    }

    // ---------------------------------------------------------
    // 2. WIPE & INIT (Borrar y Recrear)
    // ---------------------------------------------------------
    console.log('\n💥 2. Borrando esquema y recreando tablas...');
    
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await client.query(sql);
    console.log('   ✅ Estructura de base de datos regenerada correctamente.');

    // ---------------------------------------------------------
    // 3. LIMPIEZA DE USUARIOS DEFAULT
    // ---------------------------------------------------------
    if (backup['usuarios'] && backup['usuarios'].length > 0) {
       await client.query("DELETE FROM usuarios WHERE username = 'admin'");
       console.log('   🧹 Usuario default eliminado para restaurar los originales.');
    }

    // ---------------------------------------------------------
    // 4. RESTAURACIÓN DE DATOS
    // ---------------------------------------------------------
    console.log('\n♻️  3. Restaurando datos...');

    for (const table of SAFE_TABLES) {
      const rows = backup[table];
      if (!rows || rows.length === 0) continue;

      let insertedCount = 0;

      for (const row of rows) {
        const keys = Object.keys(row);
        const values = Object.values(row);
        
        const columns = keys.map(k => `"${k}"`).join(', '); 
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

        const queryText = `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`;

        try {
          await client.query(queryText, values);
          insertedCount++;
        } catch (err) {
          console.error(`   ❌ Error en ${table} (ID ${row.id || 'N/A'}): ${err.message}`);
        }
      }
      
      console.log(`   └─ ${table.padEnd(28)}: ${insertedCount}/${rows.length} restaurados.`);

      // ---------------------------------------------------------
      // 5. CORRECCIÓN DE SECUENCIAS
      // ---------------------------------------------------------
      if (insertedCount > 0) {
        try {
          await client.query(`
            DO $$
            BEGIN
              IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '${table}' AND column_name = 'id') THEN
                PERFORM setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1)) FROM ${table};
              END IF;
            END $$;
          `);
        } catch (seqErr) {
           // Ignorar errores de secuencia en tablas sin serial
        }
      }
    }

    console.log('\n✨ ¡RESET COMPLETADO!');
    console.log('   - Pedidos, Clientes y Finanzas: RESTAURADOS.');
    console.log('   - GPS Histórico y Analytics: LIMPIADOS.');

  } catch (e) {
    console.error('\n❌ ERROR FATAL DURANTE EL RESET:', e);
  } finally {
    client.release();
    await pool.end();
  }
}

run();