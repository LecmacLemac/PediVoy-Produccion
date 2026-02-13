// server.js — CORREGIDO Y UNIFICADO
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { registerOrderRoutes, notifyEstadoPedidoPush, getEmpresaById } from './backend.js';
import { query, pool } from './src/db.js';
import { withAuth, isSuper, getEmpresaIdFromToken, normalizePhone, resolveEmpresaId, enqueueWppMessage, checkLicencia } from './src/services.js'; 
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';
import { ejecutarReposicionPredictiva, ejecutarEstrategiaVecinos } from './src/estrategias.js';
import OpenAI from 'openai';
import { crearPreferenciaLicencia, obtenerPago } from './src/mercadoPagoService.js';
import handlers from './src/handlers.js';
import { handleIncomingComprobanteFromBotPg } from './src/transferenciasPipeline.js';
import { registrarMovimientosActivosDesdePedido, registrarActivosDesdePedidoEntrega } from './src/adm/pedidoActivosService.js';
import { notificarEnRuta, notificarPedidoTransferencia } from './src/services/notificacionesPedidos.js';
import { registerRoutes } from './src/routes/index.js';
import { registerLandingRoutes } from './src/routes/landingRoutes.js';
import { createAuthGuestSignupRouter } from './src/routes/authGuestSignup.js';
import { createPublicLandingRouter } from './src/routes/publicLanding.js';
import { createEmpresasRouter } from './src/routes/empresas.js';
import { createEntregaConfigRouter } from './src/routes/entregaConfig.js';
import { createZonasRouter } from './src/routes/zonas.js';
import { createChoferesRouter } from './src/routes/choferes.js';
import { createAsignacionesZonasRouter } from './src/routes/asignacionesZonas.js';
import { createProductosRouter } from './src/routes/productos.js';
import { createAdminUsuariosRouter } from './src/routes/adminUsuarios.js';
import { createTransferenciasRouter } from './src/routes/transferencias.js';
import { createGastosRouter } from './src/routes/gastos.js';
import { createAuthRouter } from './src/routes/auth.js';
import { createClientesRouter } from './src/routes/clientes.js';
import { createTrackingRouter } from './src/routes/tracking.js';
import { createPedidosRouter } from './src/routes/pedidos.js';
import { createPedidosItemsRouter } from './src/routes/pedidosItems.js';
import { createPedidosPagoRouter } from './src/routes/pedidosPago.js';
import { createEstadisticasRouter } from './src/routes/estadisticas.js';
import { createStockRouter } from './src/routes/stock.js';
import { createReportesRouter } from './src/routes/reportes.js';
import { createRepartidorStatsRouter } from './src/routes/repartidorStats.js';
import { createLicenciasMpRouter, createMercadoPagoWebhookRouter } from './src/routes/licenciasMp.js';
import { createPromptsGlobalesRouter } from './src/routes/promptsGlobales.js';
import { trackingPublicRouter } from './src/trackingPublic.js';

// --------------------------------------------------
// Config express
// --------------------------------------------------
const { Client, LocalAuth } = pkg;
const app = express();
const PORT = process.env.PORT || 3000;

const ENABLE_WPP = process.env.ENABLE_WPP === '1' || process.env.RENDER === 'true';

console.log('[DEBUG] process.env.ENABLE_WPP =', process.env.ENABLE_WPP);
console.log('[DEBUG] FLAG ENABLE_WPP =', ENABLE_WPP);


if (process.env.NODE_ENV === 'production') {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'dev' || secret.length < 32) {
    console.error('🔴 ERROR FATAL: JWT_SECRET inseguro en producción.');
    process.exit(1);
  }
}

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================================================
// RUTEO INTELIGENTE (LANDINGS vs INDEX GLOBAL)
// ==================================================

registerLandingRoutes(app, {
  projectDir: __dirname,
  query,
  withAuth,
  resolveEmpresaId,
  isSuper,
});

// ==================================================
// CARPETAS ESTÁTICAS DEL SISTEMA (Carrito, etc.)
// ==================================================

const PEDIDOS_DIR = path.join(__dirname, 'pedidos');
if (fs.existsSync(PEDIDOS_DIR)) app.use('/pedidos', express.static(PEDIDOS_DIR));

const TRANSF_DIR = path.join(__dirname, 'Transferencia');
if (!fs.existsSync(TRANSF_DIR)) fs.mkdirSync(TRANSF_DIR, { recursive: true });
app.use('/Transferencia', express.static(TRANSF_DIR));

const GASTOS_DIR = path.join(__dirname, 'Gastos');
if (!fs.existsSync(GASTOS_DIR)) fs.mkdirSync(GASTOS_DIR, { recursive: true });
app.use('/Gastos', express.static(GASTOS_DIR));

// --------------------------------------------------
// AUTH /api/auth (guest/register/signup-full)
// --------------------------------------------------
app.use('/api/auth', createAuthGuestSignupRouter({ query, withAuth }));

// ==================================================
// RUTAS PÚBLICAS PARA LANDINGS (SIN AUTH)
// ==================================================

app.use('/api/public', createPublicLandingRouter({ query }));
app.use('/api/public', trackingPublicRouter);

// Routers modulares
registerRoutes(app);
app.use('/api', createAuthRouter());
app.use('/api/clientes', createClientesRouter());
app.use('/api/track', createTrackingRouter());
app.use('/api/gastos', createGastosRouter({ GASTOS_DIR }));
app.use('/api/pedidos', createPedidosRouter());
app.use('/api/pedidos', createPedidosItemsRouter());
app.use('/api/pedidos', createPedidosPagoRouter());
app.use('/api/estadisticas', createEstadisticasRouter());
app.use('/api/stock', createStockRouter());
app.use('/api/reportes', createReportesRouter());
app.use('/api/repartidor', createRepartidorStatsRouter());
app.use('/api/transferencias', createTransferenciasRouter({ TRANSF_DIR }));

// Licencias Mercado Pago
app.use('/api/admin/licencia', createLicenciasMpRouter({ crearPreferenciaLicencia }));
app.use('/api/webhooks', createMercadoPagoWebhookRouter({ obtenerPago }));

// Prompts globales (super admin)
app.use('/api/admin/prompts', createPromptsGlobalesRouter());

// --------------------------------------------------
// Transferencias (comprobantes de transferencia)
// --------------------------------------------------

// Gastos movidos a src/routes/gastos.js

// --------------------------------------------------
// AUTH (login + /me)
// --------------------------------------------------
// Movido a src/routes/auth.js

// --------------------------------------------------
// ONBOARDING / CONFIGURACIÓN INICIAL
// --------------------------------------------------

// Obtener progreso
app.get('/api/setup/progress', withAuth, async (req, res) => {
  try {
    const empresaId = getEmpresaIdFromToken(req);
    const rows = await query('SELECT setup_steps FROM empresas WHERE id=$1', [empresaId]);
    
    let steps = {};
    if (rows.length && rows[0].setup_steps) {
      try { steps = JSON.parse(rows[0].setup_steps); } catch {}
    }
    res.json(steps);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo progreso' });
  }
});

// Actualizar un paso (Marcar/Desmarcar)
app.post('/api/setup/step', withAuth, async (req, res) => {
  try {
    const { step, done } = req.body; // step: numero, done: boolean
    const empresaId = getEmpresaIdFromToken(req);

    // 1. Obtener estado actual
    const rows = await query('SELECT setup_steps FROM empresas WHERE id=$1', [empresaId]);
    let steps = {};
    if (rows.length && rows[0].setup_steps) {
      try { steps = JSON.parse(rows[0].setup_steps); } catch {}
    }

    // 2. Actualizar el paso específico
    steps[step] = !!done;

    // 3. Guardar
    await query('UPDATE empresas SET setup_steps=$1 WHERE id=$2', [JSON.stringify(steps), empresaId]);
    
    res.json({ ok: true, steps });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error guardando paso' });
  }
});

// --------------------------------------------------
// EMPRESAS (CRUD + cuentas)
// --------------------------------------------------

app.use(
  '/api/empresas',
  createEmpresasRouter({
    query,
    withAuth,
    isSuper,
    getEmpresaIdFromToken,
    resolveEmpresaId,
    getEmpresaById,
  })
);

// Nota: /api/empresas/:id/landing-page se maneja en src/routes/landingRoutes.js

// --------------------------------------------------
// CONFIGURACIÓN DE ENTREGA POR EMPRESA
// --------------------------------------------------

app.use('/api/entrega', createEntregaConfigRouter({ query, withAuth, resolveEmpresaId }));

// ==================================================
// GENERADOR WEB CON IA (Database Driven + Slug Aware)
// ==================================================

app.post('/api/ai/build-site', withAuth, async (req, res) => {
  try {
    const { prompt, empresa_id } = req.body;
    const esSuper = isSuper(req);
    const myEmpresa = getEmpresaIdFromToken(req);
    
    // 1. LÓGICA DE ID (Super vs User)
    // Si es Super, usa el ID que viene en el body (o el suyo propio si no viene nada).
    // Si es User normal, SIEMPRE forzamos su propio ID (seguridad).
    const targetId = esSuper ? (Number(empresa_id) || myEmpresa) : myEmpresa;

    // 2. Obtener datos de la empresa (Teléfono, Nombre, Rubro y SLUG)
    const empRows = await query(
      'SELECT telefono, nombre, rubro, landing_slug FROM empresas WHERE id = $1', 
      [targetId]
    );
    
    if (!empRows.length) return res.status(404).json({ error: 'Empresa no encontrada' });
    const empresaData = empRows[0];
    
    // Normalizar datos para inyección
    const telWpp = (empresaData.telefono || '').replace(/\D/g, '');
    // Si no tiene slug, usamos uno genérico temporal
    const slug = empresaData.landing_slug || `empresa-${targetId}`;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Falta API Key de OpenAI' });
    }

    // 3. Buscar el Prompt "builder_web" en la DB
    const promptRows = await query(
      `SELECT contenido FROM empresa_prompts WHERE tipo = 'builder_web' AND empresa_id IS NULL LIMIT 1`
    );

    let systemPrompt = promptRows.length > 0 
      ? promptRows[0].contenido 
      : 'Eres un desarrollador web...'; // Fallback

    // 4. INYECCIÓN DE VARIABLES (ID, Teléfono y SLUG)
    // Aquí es donde le "enseñamos" a la IA los datos reales de ESTA empresa
    systemPrompt = systemPrompt
      .replace('{ID_EMPRESA}', targetId)
      .replace('{TELEFONO_EMPRESA}', telWpp || '5491100000000')
      .replace('{SLUG_EMPRESA}', slug);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 5. Llamada a la IA
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", 
      messages: [
        { role: "system", content: systemPrompt },
        { 
          role: "user", 
          content: `Empresa: ${empresaData.nombre}. Rubro: ${empresaData.rubro}. Slug: ${slug}.
          Descripción del usuario: "${prompt}".
          Genera el código HTML completo ahora.` 
        }
      ],
      temperature: 0.7,
    });

    let html = completion.choices[0].message.content;
    html = html.replace(/```html/g, '').replace(/```/g, '');

    res.json({ html });

  } catch (e) {
    console.error('AI BUILDER ERROR:', e);
    res.status(500).json({ error: 'Error generando sitio: ' + e.message });
  }
});

// --------------------------------------------------
// ZONAS (CRUD - Tabla: zonas_geograficas con PostGIS)
// --------------------------------------------------

app.use('/api/zonas', createZonasRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

// --------------------------------------------------
// CHOFERES + COSTOS + ESCALAS + TRAMOS
// --------------------------------------------------

app.use('/api', createChoferesRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

// (ASIGNACIONES) /api/asignarChofer y /api/desasignarChofer movidos a src/routes/asignacionesZonas.js
app.use('/api', createAsignacionesZonasRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

// --------------------------------------------------
// PRODUCTOS (CRUD)
// --------------------------------------------------

app.use('/api/productos', createProductosRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

// (CHOFERES/COSTOS/ESCALAS/TRAMOS) movidos a src/routes/choferes.js

// --------------------------------------------------
// USUARIOS (ADMIN - Creación/Gestión)
// --------------------------------------------------

app.use('/api/admin', createAdminUsuariosRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

// --------------------------------------------------
// API REPARTIDOR (Dashboard Chofer)
// --------------------------------------------------

// 1. Obtener Pedidos
app.get('/api/repartidor/pedidos', withAuth, async (req, res) => {
  try {
    const { chofer_id } = req.user;
    const empresaId = getEmpresaIdFromToken(req); // mismo criterio que el dashboard

    if (req.user.role === 'repartidor' && !chofer_id) {
      return res.status(403).json({ error: 'Usuario repartidor sin chofer vinculado.' });
    }

    // MEJORA: Filtramos los entregados para no traer historial de hace meses
    // Traemos:
    // 1. Todo lo que NO esté entregado/cancelado (pendiente, en_ruta, en_camino)
    // 2. O lo que esté entregado/cancelado PERO haya sido modificado recientemente (ej. últimos 2 días)
    //    Usamos p.fecha como fallback si fecha_entrega es null
    
    const rows = await query(
      `SELECT 
         p.id, p.estado, p.fecha, p.fecha_entrega,
         p.cantidad, p.monto, p.metodo_pago, p.chofer_id,
         pe.cliente, pe.direccion, pe.ciudad, pe.telefono,
         pe.latitud, pe.longitud, pe.notas AS notas,
         pe.zona_id, z.nombre AS zona_nombre
       FROM pedidos p
       JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
       LEFT JOIN zonas_geograficas z ON pe.zona_id = z.id
       WHERE pe.empresa_id = $2
         AND (p.chofer_id = $1 OR p.chofer_id IS NULL)
         AND (
           -- CASO A: Pedidos activos (traer todos)
           p.estado IN ('pendiente', 'en_ruta', 'en_camino')
           OR 
           -- CASO B: Pedidos finalizados recientes (ej: últimos 2 días para permitir ver resumen de ayer)
           (
             p.estado IN ('entregado', 'cancelado') 
             AND (
                (p.fecha_entrega IS NOT NULL AND p.fecha_entrega >= NOW() - INTERVAL '2 days')
                OR 
                (p.fecha >= NOW() - INTERVAL '2 days')
             )
           )
         )
       ORDER BY p.id ASC`,
      [chofer_id, empresaId]
    );

    // Inyectar ítems...
    for (let pedido of rows) {
      // ⬇️ AQUÍ ESTÁ EL CAMBIO: Agregamos precio_unitario a la consulta
      const items = await query(
        `SELECT producto, cantidad, precio_unitario FROM items_pedido WHERE pedido_id=$1`,
        [pedido.id]
      );
      pedido.items = items;
    }

    res.json(rows);
  } catch (e) {
    console.error('REPARTIDOR PEDIDOS ERROR:', e);
    res.status(500).json({ error: 'Error cargando pedidos' });
  }
});

// 2. Actualizar Estado o Pago (PUT) - Para los botones del repartidor
app.put('/api/repartidor/pedidos/:id', withAuth, async (req, res) => {
  try {
    // 1. Usuario autenticado
    const { chofer_id, empresa_id } = req.user;
    const pedidoId = req.params.id;

    // 👇 Primero leemos el body
    const { estado, metodo_pago, zona_id: zonaIdBody } = req.body || {};

    // 👇 Guard correcto (después de leer estado)
    if (estado && String(estado).toLowerCase() === 'entregado') {
      return res
        .status(400)
        .json({ error: 'Usá POST /api/repartidor/pedidos/:id/entregar' });
    }

    if (!chofer_id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // 2. Verificar el pedido (SUMÁ empresa_id para multi-tenant)
    const rows = await query(
      `SELECT chofer_id, metodo_pago, estado, zona_id, punto_entrega_id
         FROM pedidos
        WHERE id = $1 AND empresa_id = $2`,
      [pedidoId, empresa_id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const pedido             = rows[0];
    const actualChofer       = pedido.chofer_id;
    const metodoPagoAnterior = (pedido.metodo_pago || '').toLowerCase();
    const estadoAnterior     = (pedido.estado || '').toLowerCase();
    const teniaZonaAntes     = pedido.zona_id != null;
    const puntoEntregaId     = pedido.punto_entrega_id;

    // 3. Si ya está asignado a OTRO chofer, bloquear
    if (actualChofer && actualChofer !== chofer_id) {
      return res.status(403).json({ error: 'Pedido asignado a otro chofer' });
    }

    // 4. Si no tiene chofer, lo tomo para mí de forma segura
    if (!actualChofer) {
      const taken = await query(
        `UPDATE pedidos
           SET chofer_id = $1
         WHERE id = $2
           AND empresa_id = $3
           AND chofer_id IS NULL
         RETURNING id`,
        [chofer_id, pedidoId, empresa_id]
      );

      if (!taken.length) {
        return res.status(400).json({ error: 'El pedido ya fue tomado por otro.' });
      }
    }

    // 🔁 LOGICA DE ZONA (solo si el pedido venía SIN zona)
    let zonaIdToSet = null;
    let actualizarZonaPuntoEntrega = false;

    if (!teniaZonaAntes) {
      // PRIORIDAD 1: el front mandó zona explícita
      if (zonaIdBody) {
        const zCheck = await query(
          `
          SELECT zona_id
            FROM zona_chofer
           WHERE chofer_id = $1
             AND empresa_id = $2
             AND zona_id = $3
          `,
          [chofer_id, empresa_id, zonaIdBody]
        );

        if (!zCheck.length) {
          return res.status(400).json({ error: 'Zona no válida para este chofer' });
        }

        zonaIdToSet = zonaIdBody;
        actualizarZonaPuntoEntrega = true;
      } else {
        // PRIORIDAD 2: el chofer tiene exactamente 1 zona → auto-asignar
        const zRows = await query(
          `
          SELECT zona_id
            FROM zona_chofer
           WHERE chofer_id = $1
             AND empresa_id = $2
          `,
          [chofer_id, empresa_id]
        );

        if (zRows.length === 1) {
          zonaIdToSet = zRows[0].zona_id;
          actualizarZonaPuntoEntrega = true;
        }
      }
    }

    // 5. Armar UPDATE (SIN entregado)
    const sets = [];
    const vals = [];
    let idx = 1;

    if (estado) {
      sets.push(`estado = $${idx++}`);
      vals.push(estado);
    }

    if (metodo_pago) {
      sets.push(`metodo_pago = $${idx++}`);
      vals.push(metodo_pago);
    }

    if (zonaIdToSet != null) {
      sets.push(`zona_id = $${idx++}`);
      vals.push(zonaIdToSet);
    }

    if (sets.length) {
      vals.push(pedidoId, empresa_id);
      await query(
        `UPDATE pedidos SET ${sets.join(', ')} WHERE id = $${idx++} AND empresa_id = $${idx}`,
        vals
      );

      // si definimos zona, actualizamos punto_entrega
      if (zonaIdToSet != null && actualizarZonaPuntoEntrega && puntoEntregaId) {
        try {
          await query(
            `UPDATE puntos_entrega
                SET zona_id = $1
              WHERE id = $2`,
            [zonaIdToSet, puntoEntregaId]
          );
        } catch (err) {
          console.error('Error actualizando zona en punto_entrega:', err);
        }
      }

      // 🔔 PUSH cambio de estado (si aplica)
      if (estado) {
        notifyEstadoPedidoPush(pedidoId, estado).catch(err =>
          console.error('PUSH estado pedido error:', err)
        );
      }

      // CASO B: EN RUTA / EN CAMINO
      if (estado === 'en_ruta' || estado === 'en_camino') {
        notificarEnRuta(pedidoId, empresa_id).catch(err =>
          console.error('Error en notificación background:', err)
        );

        ejecutarEstrategiaVecinos({
          pedidoId: pedidoId,
          empresaId: empresa_id
        }).catch(err => console.error('Error estrategia vecinos:', err));
      }

      // CASO C: CAMBIO A TRANSFERENCIA
      if (
        metodo_pago &&
        metodo_pago.toLowerCase().includes('trans') &&
        !metodoPagoAnterior.includes('trans')
      ) {
        notificarPedidoTransferencia(pedidoId, empresa_id).catch(err =>
          console.error('Error en notificación transferencia pedido:', err)
        );
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('UPDATE REPARTIDOR ERROR:', e);
    res.status(500).json({ error: 'Error actualizando pedido' });
  }
});

app.post('/api/repartidor/pedidos/:id/entregar', withAuth, async (req, res) => {
  // 1. Extracción y Validación Básica
  const { chofer_id, empresa_id, username } = req.user || {};
  const pedidoId = Number(req.params.id);
  // 'movimientos' viene del Modal de Activos del Frontend
  const { movimientos = [], zona_id = null, metodo_pago = null } = req.body || {};

  if (!chofer_id) return res.status(403).json({ error: 'No autorizado: Falta chofer_id' });
  if (!Number.isFinite(pedidoId)) return res.status(400).json({ error: 'ID de pedido inválido' });

  const client = await pool.connect();
  
  try {
    // -----------------------------------------------------
    // INICIO TRANSACCIÓN (Todo o Nada)
    // -----------------------------------------------------
    await client.query('BEGIN');

    // 2. Lock del Pedido (Evita doble entrega concurrente)
    const pedQ = await client.query(
      `
      SELECT id, empresa_id, chofer_id, estado, metodo_pago, zona_id, punto_entrega_id
      FROM pedidos
      WHERE id = $1 AND empresa_id = $2
      FOR UPDATE
      `,
      [pedidoId, empresa_id]
    );

    if (!pedQ.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const pedido = pedQ.rows[0];
    const estadoAnterior = String(pedido.estado || '').toLowerCase();
    const metodoPagoAnterior = String(pedido.metodo_pago || '').toLowerCase();

    // 3. Validar Asignación de Chofer
    // Si el pedido ya tiene chofer y NO soy yo, error.
    if (pedido.chofer_id && Number(pedido.chofer_id) !== Number(chofer_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Este pedido fue tomado por otro chofer.' });
    }
    
    // Si no tiene chofer (ej: auto-asignación al entregar), me lo asigno.
    if (!pedido.chofer_id) {
      await client.query(
        `UPDATE pedidos SET chofer_id = $1 WHERE id = $2`,
        [chofer_id, pedidoId]
      );
    }

    // 4. Idempotencia (Si ya se entregó, salimos bien sin hacer nada)
    if (estadoAnterior === 'entregado') {
      await client.query('COMMIT');
      return res.json({ ok: true, already: true });
    }

    // 5. Lógica de Zona (Opcional, pero recomendada)
    let zonaIdToSet = pedido.zona_id; // Por defecto mantenemos la que tiene
    let actualizarZonaPuntoEntrega = false;

    if (pedido.zona_id == null) {
      // Si viene zona en el body, validamos que el chofer la tenga permitida
      if (zona_id != null) {
        const zCheck = await client.query(
          `SELECT zona_id FROM zona_chofer WHERE chofer_id = $1 AND zona_id = $2`,
          [chofer_id, zona_id]
        );
        if (!zCheck.rows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'La zona indicada no pertenece a este chofer.' });
        }
        zonaIdToSet = zona_id;
        actualizarZonaPuntoEntrega = true;
      } else {
        // Auto-detectar si el chofer solo tiene 1 zona
        const zRows = await client.query(
          `SELECT zona_id FROM zona_chofer WHERE chofer_id = $1 AND empresa_id = $2`,
          [chofer_id, empresa_id]
        );
        if (zRows.rows.length === 1) {
          zonaIdToSet = zRows.rows[0].zona_id;
          actualizarZonaPuntoEntrega = true;
        }
      }
    }

    const fechaEntregaIso = new Date().toISOString();

    // 6. PROCESAMIENTO DE ACTIVOS (FSM) - CORREGIDO
    // Usamos la función robusta que soporta transacciones externas y array de movimientos
    if (Array.isArray(movimientos) && movimientos.length > 0) {
      await registrarMovimientosActivosDesdePedido({
        dbClient: client,              // Pasamos el cliente de la transacción
        empresaId: empresa_id,
        clienteId: pedido.punto_entrega_id,
        pedidoId: pedidoId,
        movimientos: movimientos,      // Array de { activo_id, tipo, ... }
        usuario: username || 'repartidor',
        origen: 'app_repartidor'
      });
    }

    // 7. Actualizar Pedido a ENTREGADO
    await client.query(
      `
      UPDATE pedidos
      SET estado = 'entregado',
          fecha_entrega = $2,
          cantidad_entregada = cantidad, -- Asumimos entrega total por defecto
          metodo_pago = COALESCE($3, metodo_pago),
          zona_id = COALESCE($4, zona_id)
      WHERE id = $1
      `,
      [pedidoId, fechaEntregaIso, metodo_pago, zonaIdToSet]
    );

    // 7.b Actualizar Zona del Cliente si correspondía
    if (actualizarZonaPuntoEntrega && pedido.punto_entrega_id && zonaIdToSet) {
      await client.query(
        `UPDATE puntos_entrega SET zona_id = $1 WHERE id = $2`,
        [zonaIdToSet, pedido.punto_entrega_id]
      );
    }

    // 8. DESCUENTO DE STOCK DEL CHOFER (Consumibles / Productos vendidos)
    // Obtenemos los productos del pedido para descontarlos del inventario del chofer
    const itemsQ = await client.query(
      `
      SELECT ip.cantidad, p.id AS producto_id
      FROM items_pedido ip
      JOIN productos p ON p.empresa_id = $2 AND LOWER(TRIM(p.nombre)) = LOWER(TRIM(ip.producto))
      WHERE ip.pedido_id = $1
      `,
      [pedidoId, empresa_id]
    );

    for (const it of itemsQ.rows) {
      const qty = Number(it.cantidad) || 0;
      const productoId = it.producto_id;
      
      if (qty > 0 && productoId) {
        // a) Registrar Movimiento (Historial)
        await client.query(
          `
          INSERT INTO chofer_stock_mov
            (empresa_id, chofer_id, producto_id, cantidad, tipo, motivo, referencia, fecha)
          VALUES ($1, $2, $3, $4, 'venta', 'Entrega Pedido App', $5, $6)
          `,
          [empresa_id, chofer_id, productoId, qty, `Pedido #${pedidoId}`, fechaEntregaIso]
        );

        // b) Restar del Stock Físico (UPSERT negativo)
        await client.query(
          `
          INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
          VALUES ($1, $2, $3, $4) 
          ON CONFLICT (empresa_id, chofer_id, producto_id)
          DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
          `,
          [empresa_id, chofer_id, productoId, -qty] // -qty para restar
        );
      }
    }

    // -----------------------------------------------------
    // FIN TRANSACCIÓN
    // -----------------------------------------------------
    await client.query('COMMIT');

    // 9. Tareas Post-Entrega (Fuera del hilo principal)
    
    // Notificación Push
    notifyEstadoPedidoPush(pedidoId, 'entregado').catch(console.error);
    
    // Marketing (Referidos, Puntos)
    import('./src/estrategias.js')
      .then(({ ejecutarRecompensaReferido, ejecutarEstrategiaReferidos }) => {
        ejecutarRecompensaReferido({ pedidoId, empresaId: empresa_id }).catch(() => {});
        ejecutarEstrategiaReferidos({ pedidoId, empresaId: empresa_id }).catch(() => {});
      })
      .catch(() => {});

    // Notificar cambio a Transferencia si aplica
    if (metodo_pago && String(metodo_pago).toLowerCase().includes('trans') && !metodoPagoAnterior.includes('trans')) {
       // Opcional: notificarPedidoTransferencia(pedidoId, empresa_id).catch(() => {});
    }

    res.json({ ok: true });

  } catch (e) {
    // Si algo falló, deshacemos TODO.
    await client.query('ROLLBACK');
    console.error('POST /entregar ERROR CRÍTICO:', e);
    
    // Feedback amigable
    if (e.message && e.message.includes('No autorizado')) {
        return res.status(403).json({ error: e.message });
    }
    // Devolvemos 500 JSON para evitar el error de parseo en el frontend
    res.status(500).json({ error: 'Error al procesar la entrega: ' + (e.message || 'Error interno') });
  } finally {
    client.release();
  }
});

// 3. Movimientos de activos manuales enviados por el repartidor
app.post('/api/repartidor/pedidos/:id/activos-movimientos', withAuth, async (req, res) => {
  try {
    const { chofer_id, empresa_id, username } = req.user;
    const pedidoId = Number(req.params.id);
    const { movimientos } = req.body || {};

    if (!chofer_id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const pedRes = await query(
      `
      SELECT chofer_id, punto_entrega_id
      FROM pedidos
      WHERE id = $1
      `,
      [pedidoId]
    );

    // CORRECCIÓN: Usamos .length directamente, ya que 'query' devuelve el array
    if (!pedRes.length) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // CORRECCIÓN: Accedemos al primer elemento directamente
    const pedido = pedRes[0];

    // Verificamos asignación
    if (pedido.chofer_id && pedido.chofer_id !== chofer_id) {
      return res.status(403).json({ error: 'Pedido asignado a otro chofer' });
    }

    const result = await registrarMovimientosActivosDesdePedido({
      empresaId: empresa_id,
      clienteId: pedido.punto_entrega_id,
      pedidoId,
      usuario: username || 'repartidor',
      origen: 'app_repartidor',
      movimientos: Array.isArray(movimientos) ? movimientos : []
    });

    res.json(result);
  } catch (e) {
    console.error('REPARTIDOR activos-movimientos ERROR:', e);
    res.status(500).json({ error: 'Error registrando movimientos de activos' });
  }
});

// 4. Resumen de activos asociados a un pedido (para el modal del repartidor)
app.get('/api/repartidor/pedidos/:id/activos-resumen', withAuth, async (req, res) => {
  try {
    const { chofer_id, empresa_id } = req.user || {};
    const pedidoId = Number(req.params.id);

    if (!chofer_id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    if (!Number.isFinite(pedidoId)) {
      return res.status(400).json({ error: 'Pedido inválido' });
    }

    // Pedido + datos del cliente (punto de entrega)
    const pedRows = await query(
      `
      SELECT 
        p.id,
        p.monto,
        p.chofer_id,
        p.punto_entrega_id,
        pe.cliente,
        COALESCE(pe.direccion_completa, pe.direccion) AS direccion
      FROM pedidos p
      LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      WHERE p.id = $1
        AND p.empresa_id = $2
      `,
      [pedidoId, empresa_id]
    );

    if (!pedRows.length) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const pedido = pedRows[0];

    // El chofer sólo puede ver pedidos propios
    if (pedido.chofer_id && Number(pedido.chofer_id) !== Number(chofer_id)) {
      return res.status(403).json({ error: 'Pedido asignado a otro chofer' });
    }

    // Items del pedido + productos con config_activo
    const itemsRows = await query(
      `
      SELECT 
        ip.id AS item_pedido_id,
        ip.producto,
        ip.cantidad,
        ip.precio_unitario,
        COALESCE(ip.producto_id, pr.id) AS producto_id,
        pr.config_activo
      FROM items_pedido ip
      LEFT JOIN productos pr
        ON pr.empresa_id = $2
       AND (
            pr.id = ip.producto_id
         OR LOWER(TRIM(pr.nombre)) = LOWER(TRIM(ip.producto))
       )
      WHERE ip.pedido_id = $1
      `,
      [pedidoId, empresa_id]
    );

    const items_activos = (itemsRows || [])
      .filter(r => {
        const cfg = r.config_activo || {};
        const esActivo =
          cfg.es_activo === true ||
          cfg.es_activo === 'true' ||
          cfg.usa_alquiler === true ||
          cfg.usa_alquiler === 'true';
        return esActivo;
      })
      .map(r => ({
        item_pedido_id: r.item_pedido_id,
        producto_id: r.producto_id,
        producto: r.producto,
        cantidad: Number(r.cantidad) || 0,
        precio_unitario: Number(r.precio_unitario) || 0
      }));

    // Activos actualmente vinculados a ese cliente (punto_entrega_id)
    const activosClienteRows = await query(
      `
      SELECT 
        a.id,
        a.codigo,
        a.tipo,
        a.estado,
        a.numero_serie,
        a.alquiler_mensual
      FROM empresa_activos a
      WHERE a.empresa_id = $1
        AND a.cliente_id = $2
        AND a.estado IN ('prestado','en_mantenimiento','disponible')
      ORDER BY a.estado, a.codigo
      `,
      [empresa_id, pedido.punto_entrega_id]
    );

    // Activos disponibles para cambio (sin cliente asignado)
    const activosDisponiblesRows = await query(
      `
      SELECT 
        a.id,
        a.codigo,
        a.tipo,
        a.estado,
        a.numero_serie,
        a.alquiler_mensual
      FROM empresa_activos a
      WHERE a.empresa_id = $1
        AND a.cliente_id IS NULL
        AND a.estado = 'disponible'
      ORDER BY a.codigo
      `,
      [empresa_id]
    );

    // Movimientos ya registrados de este pedido
    const movRows = await query(
      `
      SELECT 
        id,
        activo_id,
        activo_relacionado_id,
        tipo_operacion,
        estado,
        observacion,
        accion_at_utc
      FROM pedido_activos
      WHERE empresa_id = $1
        AND pedido_id = $2
      ORDER BY accion_at_utc DESC, id DESC
      `,
      [empresa_id, pedidoId]
    );

    res.json({
      pedido: {
        id: pedido.id,
        cliente: pedido.cliente,
        direccion: pedido.direccion,
        monto: Number(pedido.monto) || 0
      },
      items_activos,
      activos_cliente: activosClienteRows || [],
      activos_disponibles: activosDisponiblesRows || [],
      movimientos_existentes: movRows || []
    });
  } catch (e) {
    console.error('REPARTIDOR activos-resumen ERROR:', e);
    res.status(500).json({ error: 'Error cargando activos del pedido' });
  }
});

app.get('/api/repartidor/activos/stock-disponible', withAuth, async (req, res) => {
  const { chofer_id, empresa_id } = req.user || {};
  if (!chofer_id) return res.status(403).json({ error: 'No autorizado' });

  const rows = await query(
    `
    SELECT id, codigo, tipo, estado, marca, modelo, producto_id, alquiler_mensual
    FROM empresa_activos
    WHERE empresa_id = $1
      AND estado = 'disponible'
      AND cliente_id IS NULL
    ORDER BY id DESC
    `,
    [empresa_id]
  );

  res.json({ ok: true, data: rows });
});

// Repartidor stats (resumen-dia, pago-dia) movidos a src/routes/repartidorStats.js

// 8. Tomar pedido vacante (chofer_id IS NULL)
app.post('/api/repartidor/tomar/:id', withAuth, async (req, res) => {
  try {
    const { chofer_id } = req.user;
    if (!chofer_id) return res.status(403).json({ error: 'No autorizado' });

    const pedidoId = req.params.id;

    const result = await query(
      `UPDATE pedidos 
         SET chofer_id = $1 
       WHERE id = $2 
         AND chofer_id IS NULL
       RETURNING id`,
      [chofer_id, pedidoId]
    );

    if (!result.length) {
      return res.status(400).json({ error: 'El pedido ya fue tomado por otro.' });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('REPARTIDOR TOMAR ERROR:', e);
    res.status(500).json({ error: 'Error al tomar pedido' });
  }
});

// 9. OPTIMIZADOR DE RUTA (PostGIS Nearest Neighbor)
app.post('/api/repartidor/optimizar-ruta', withAuth, async (req, res) => {
    try {
      const { lat, lng } = req.body;
      const { chofer_id, empresa_id } = req.user;

      if (!chofer_id) return res.status(403).json({ error: 'Solo para choferes' });
      if (!lat || !lng) return res.status(400).json({ error: 'Faltan coordenadas actuales' });

      // ---------------------------------------------------------
      // ALGORITMO NEAREST NEIGHBOR EN SQL PURO (RECURSIVO)
      // ---------------------------------------------------------
      // 1. Seleccionamos los pedidos pendientes con ubicación válida.
      // 2. Usamos una CTE recursiva para saltar de punto en punto.
      //    El operador "<->" de PostGIS ordena por distancia geométrica (índice GiST).
      
      const sql = `
        WITH RECURSIVE 
        -- 1. Puntos a visitar (Pendientes del chofer)
        puntos AS (
            SELECT 
                p.id, 
                pe.latitud, 
                pe.longitud,
                pe.direccion,
                pe.cliente,
                p.fecha
            FROM pedidos p
            JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
            WHERE p.chofer_id = $1
              AND p.estado IN ('pendiente', 'en_ruta', 'en_camino')
              AND pe.latitud IS NOT NULL 
              AND pe.longitud IS NOT NULL
        ),
        -- 2. Ruta recursiva
        ruta AS (
            -- ANCLA: Buscamos el primer punto más cercano a la ubicación ACTUAL del chofer ($2, $3)
            (
                SELECT 
                    id, latitud, longitud, direccion, cliente, fecha,
                    1::int as orden,
                    ARRAY[id] as visitados -- Array para no repetir
                FROM puntos
                ORDER BY 
                    -- Distancia entre punto pedido y ubicación chofer
                    ST_SetSRID(ST_MakePoint(longitud, latitud), 4326) <-> ST_SetSRID(ST_MakePoint($3, $2), 4326)
                LIMIT 1
            )
            
            UNION ALL
            
            -- RECURSIÓN: Desde el último punto encontrado (prev), buscar el siguiente más cercano
            (
                SELECT 
                    next.id, next.latitud, next.longitud, next.direccion, next.cliente, next.fecha,
                    prev.orden + 1,
                    prev.visitados || next.id
                FROM puntos next, ruta prev
                WHERE NOT (next.id = ANY(prev.visitados)) -- Que no haya sido visitado
                ORDER BY 
                    -- Distancia entre el siguiente y el anterior
                    ST_SetSRID(ST_MakePoint(next.longitud, next.latitud), 4326) <-> ST_SetSRID(ST_MakePoint(prev.longitud, prev.latitud), 4326)
                LIMIT 1
            )
        )
        SELECT * FROM ruta;
      `;

      const rutaOptimizada = await query(sql, [chofer_id, lat, lng]);

      // Si no hay ruta (ej: no hay pedidos o no tienen coords), devolvemos lista vacía
      res.json({ 
        ok: true, 
        ruta: rutaOptimizada 
      });

    } catch (e) {
      console.error('ERROR OPTIMIZADOR:', e);
      res.status(500).json({ error: 'Error optimizando ruta' });
    }
}); 

app.get('/api/repartidor/mis-zonas', withAuth, async (req, res) => {
  const { chofer_id, empresa_id } = req.user;
  if (!chofer_id) return res.status(400).json({ error: 'Sin chofer vinculado' });

  const rows = await query(`
    SELECT z.id, z.nombre
    FROM zona_chofer zc
    JOIN zonas_geograficas z ON zc.zona_id = z.id
    WHERE zc.chofer_id = $1 AND zc.empresa_id = $2
    ORDER BY z.nombre
  `, [chofer_id, empresa_id]);

  res.json(rows);
});
  
// --------------------------------------------------
// PEDIDOS (ADMIN / DASHBOARD)
// --------------------------------------------------
// Rutas base movidas a src/routes/pedidos.js (GET /api/pedidos, PUT/DELETE /api/pedidos/:id)

// Items de pedidos movidos a src/routes/pedidosItems.js

// Stock movido a src/routes/stock.js

// Reportes movidos a src/routes/reportes.js

// Endpoint para el Checkbox (Toggle Pago)
// toggle-pago movido a src/routes/pedidosPago.js

// Estadísticas movidas a src/routes/estadisticas.js

// --------------------------------------------------
// CLIENTES
// --------------------------------------------------

// --------------------------------------------------
// ENDPOINT DE TRACKING (Necesario para el Repartidor)
// --------------------------------------------------

// POST /api/track/update movido a src/routes/tracking.js

/**
 * Genera token (si no existe) y envía WPP de 'En Ruta' **solo la primera vez**
 */

// Helpers de notificaciones movidos a src/services/notificacionesPedidos.js

// ==================================================
// 💰 SISTEMA DE COBRO DE LICENCIAS (Mercado Pago)
// ==================================================
// Movido a src/routes/licenciasMp.js

// Prompts globales movidos a src/routes/promptsGlobales.js

registerOrderRoutes(app);

// --------------------------------------------------
// WHATSAPP WEB (Integrado)
// --------------------------------------------------

let lastQr = null;
let isConnected = false;    // Para mostrar estado en /api/whatsapp/qr
let isReadyWpp = false;     // 💡 Solo true cuando el cliente está realmente READY (outbox)
let wppClient = null;
let wppHandlersStarted = false;

if (ENABLE_WPP) {
  console.log('[WPP SERVER] WhatsApp habilitado. Inicializando cliente...');

  // Configuración especial para Render
  const isRender = process.env.RENDER === 'true';
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || 
                        (isRender ? '/usr/bin/chromium-browser' : null);

  console.log(`[WPP SERVER] Usando ejecutable: ${executablePath || 'default'}`);
  console.log(`[WPP SERVER] En Render: ${isRender}`);

  wppClient = new Client({
    authStrategy: new LocalAuth({
      clientId: 'server_session_hidro'
    }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.x.html',
    },
    puppeteer: {
      headless: "new",  // Usar el nuevo headless mode
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=VizDisplayCompositor',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--use-gl=egl',
        '--disable-software-rasterizer',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list'
      ],
      executablePath: executablePath,
      ignoreHTTPSErrors: true,
      timeout: 60000,  // Aumentar timeout para Render
      ...(isRender && {
        userDataDir: '/tmp/whatsapp-session'  // Usar /tmp para sesiones en Render
      })
    }
  });

  // --- Eventos base de conexión --- //
  wppClient.on('qr', (qr) => {
    lastQr = qr;
    isConnected = false;
    isReadyWpp = false;
    console.log('[WPP SERVER] QR RECIBIDO. Escanea para conectar.');
  });

  wppClient.on('authenticated', async () => {
    isConnected = true;
    isReadyWpp = false;
    lastQr = null;
    console.log('[WPP SERVER] Autenticado ✅');
    
    // Forzamos el inicio de handlers aquí por si 'ready' no llega
    if (!wppHandlersStarted) {
      wppHandlersStarted = true;
      try {
        console.log('[WPP SERVER] Iniciando handlers preventivamente (authenticated)...');
        await handlers.start(wppClient);
        console.log('[WPP SERVER] Handlers iniciados preventivamente.');
      } catch (e) {
        wppHandlersStarted = false;
        console.error('[WPP SERVER] Error en handlers preventivos:', e);
      }
    }
  });

  wppClient.on('auth_failure', (msg) => {
    console.error('[WPP SERVER] Falla de auth:', msg);
    // Intentar reiniciar si falla la autenticación
    setTimeout(() => {
      if (wppClient) {
        console.log('[WPP SERVER] Reintentando después de auth failure...');
        wppClient.initialize().catch(console.error);
      }
    }, 5000);
  });

  // 👇 Debug extra para ver qué pasa en Render
  wppClient.on('change_state', (state) => {
    console.log('[WPP SERVER] Estado cliente WPP:', state);
  });

  wppClient.on('loading_screen', (percent, message) => {
    console.log('[WPP SERVER] Cargando WhatsApp Web:', percent, '% -', message);
  });

  wppClient.on('error', (err) => {
    console.error('[WPP SERVER] ERROR cliente WPP:', err);
    
    // Reiniciar en caso de errores críticos
    if (err.message && (
      err.message.includes('closed') || 
      err.message.includes('disconnected') ||
      err.message.includes('Protocol error')
    )) {
      console.log('[WPP SERVER] Error crítico detectado, reiniciando en 10 segundos...');
      setTimeout(reiniciarWhatsApp, 10000);
    }
  });

  wppClient.on('ready', async () => {
    isConnected = true;
    isReadyWpp = true;
    lastQr = null;
    console.log('[WPP SERVER] CLIENTE LISTO (READY) ✅');

    // Iniciar handlers en READY para asegurar que el cliente puede recibir mensajes
    if (!wppHandlersStarted) {
      wppHandlersStarted = true;
      try {
        console.log('[WPP SERVER] Iniciando handlers de texto...');
        await handlers.start(wppClient);
        console.log('[WPP SERVER] Handlers de texto iniciados correctamente.');
      } catch (e) {
        wppHandlersStarted = false;
        console.error('[WPP SERVER] Error iniciando handlers:', e);
      }
    } else {
      console.log('[WPP SERVER] Handlers ya estaban iniciados.');
    }

    // ──────────────────────────────────────────────
    // PARCHE: desactivar WWebJS.sendSeen en el navegador
    // para evitar el bug "markedUnread" de whatsapp-web.js
    // ──────────────────────────────────────────────
    try {
      const page = wppClient.pupPage;

      if (page && (typeof page.evaluate === 'function' || typeof page.evaluateOnNewDocument === 'function')) {
        // 1) Parche para esta sesión actual
        if (typeof page.evaluate === 'function') {
          await page.evaluate(() => {
            try {
              if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                window.WWebJS.sendSeen = async () => {
                  // sendSeen desactivado intencionalmente para evitar bug markedUnread
                };
              }
            } catch (e) {
              // ignorar errores dentro del contexto del navegador
            }
          });
        }

        // 2) Parche futuro: si whatsapp-web.js reinyecta scripts,
        //    esto ayuda a que ya arranquen con sendSeen no-op.
        if (typeof page.evaluateOnNewDocument === 'function') {
          await page.evaluateOnNewDocument(() => {
            try {
              if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                window.WWebJS.sendSeen = async () => {
                  // sendSeen desactivado intencionalmente para evitar bug markedUnread
                };
              }
            } catch (e) {
              // ignorar errores dentro del contexto del navegador
            }
          });
        }

        console.log('[WPP SERVER] Parche WWebJS.sendSeen aplicado (no-op).');
      } else {
        console.warn('[WPP SERVER] No se encontró pupPage para parchear sendSeen.');
      }
    } catch (e) {
      console.warn('[WPP SERVER] No se pudo parchear WWebJS.sendSeen:', e);
    }

    // 👇 Ya NO iniciamos handlers acá.
    // Se inician en "authenticated" para que el bot funcione
    // aunque "ready" nunca llegue a dispararse.
  });

  wppClient.on('disconnected', (reason) => {
    isConnected = false;
    isReadyWpp = false;
    console.log('[WPP SERVER] Desconectado. Razón:', reason);
    
    // Intentar reconectar automáticamente
    setTimeout(() => {
      if (wppClient) {
        console.log('[WPP SERVER] Intentando reconectar después de desconexión...');
        wppClient.initialize().catch(console.error);
      }
    }, 10000);
  });

  // 2. LISTENER DE MEDIA (Transferencias)
  wppClient.on('message', async (msg) => {
    console.log(`[DEBUG WPP] Evento 'message' detectado en server.js desde: ${msg.from}`);
    try {
      // 🛑 FIX CRÍTICO: Ignorar Estados/Historias de WhatsApp
      if (msg.from === 'status@broadcast' || msg.isStatus) {
        return;
      }

      // 1. Solo chats individuales
      if (msg.from.includes('@g.us')) {
        return;
      }

      // 2. Filtramos mensajes propios
      if (msg.fromMe || msg.id?.fromMe) return;

      const t = String(msg.type || '').toLowerCase();
      // Detectar si es imagen o documento (PDF)
      const isMedia = (msg.hasMedia || t === 'image' || t === 'document');

      if (isMedia) {
        const telefonoLimpio = msg.from.replace(/\D/g, '');

        const clienteQuery = await query(
          `SELECT id FROM puntos_entrega 
           WHERE telefono_normalizado LIKE '%' || $1 
           LIMIT 1`,
          [telefonoLimpio.slice(-10)]
        );

        if (clienteQuery.length === 0) {
          if (process.env.DEBUG_ORDERS === '1') {
            console.log(`[WPP MEDIA] Ignorado: El número ${msg.from} no es un cliente registrado.`);
          }
          return;
        }

        console.log(`[WPP MEDIA] Recibido archivo de cliente registrado: ${msg.from} tipo: ${t}`);

        const media = await msg.downloadMedia().catch(err => {
          console.error('[WPP MEDIA] Error descargando:', err.message);
          return null;
        });

        if (media) {
          const buffer = Buffer.from(media.data, 'base64');

          await handleIncomingComprobanteFromBotPg({
            type: t,
            telefono: msg.from,
            buffer: buffer,
            base64: media.data,
            mimetype: media.mimetype,
            filename: media.filename || msg.body?.slice(0, 20) || 'archivo'
          });
        }
      }
    } catch (e) {
      console.error('[WPP SERVER] Error global mensaje:', e);
    }
  });

  // Función mejorada de reinicio para Render
  async function reiniciarWhatsAppParaRender() {
    if (!wppClient) return;
    
    try {
      console.log('[WPP RENDER] Reiniciando WhatsApp para Render...');
      
      // Resetear flags
      isConnected = false;
      isReadyWpp = false;
      lastQr = null;
      wppHandlersStarted = false;
      
      // Cerrar sesión limpia
      try {
        await wppClient.destroy();
      } catch (e) {
        console.warn('[WPP RENDER] Error al destruir cliente:', e.message);
      }
      
      // Esperar para evitar flood
      await new Promise(r => setTimeout(r, 5000));
      
      // Re-inicializar
      await wppClient.initialize();
      
      console.log('[WPP RENDER] WhatsApp reinicializado exitosamente.');
      
    } catch (e) {
      console.error('[WPP RENDER] Error en reinicio:', e);
      // Intentar nuevamente en 30 segundos si falla
      setTimeout(reiniciarWhatsAppParaRender, 30000);
    }
  }

  // Inicializar cliente WPP con mejor manejo de errores para Render
  const initWhatsApp = async () => {
    try {
      console.log('[WPP SERVER] Cliente WhatsApp inicializando...');
      await wppClient.initialize();
      console.log('[WPP SERVER] Cliente WhatsApp inicializado exitosamente.');
    } catch (err) {
      console.error('[WPP SERVER] Error inicializando cliente WhatsApp:', err);
      
      // En Render, reintentar después de un tiempo
      if (isRender) {
        console.log('[WPP RENDER] Reintentando inicialización en 15 segundos...');
        setTimeout(initWhatsApp, 15000);
      }
    }
  };

  // Iniciar con retraso para dar tiempo al servidor
  setTimeout(initWhatsApp, 3000);

} else {
  console.log('[WPP SERVER] WhatsApp deshabilitado en este entorno (ENABLE_WPP=0)');
}

// Endpoint para ver el QR
app.get('/api/whatsapp/qr', withAuth, async (req, res) => {
  // 1. Validación de seguridad
  if (!isSuper(req)) {
    return res.status(403).send('<h1>⛔ Acceso Denegado</h1>');
  }

  if (!ENABLE_WPP) {
    return res.status(503).send('WhatsApp deshabilitado en este entorno');
  }

  if (isConnected) return res.send('<h2 style="color:green">Conectado ✅</h2>');
  if (!lastQr) return res.send('<h2>Cargando QR... espera la consola</h2>');

  try {
    const url = await qrcode.toDataURL(lastQr);
    res.send(`<img src="${url}" />`);
  } catch {
    res.status(500).send('Error QR');
  }
});

// RESET DE SESIÓN WHATSAPP (+ limpieza de cola para evitar spam)
app.post('/api/whatsapp/reset', withAuth, async (req, res) => {
  if (!ENABLE_WPP) {
    return res.status(503).json({ error: 'WhatsApp deshabilitado en este entorno' });
  }

  try {
    // Solo super admin por seguridad
    if (!isSuper(req)) {
      return res.status(403).json({ error: 'Solo SUPER ADMIN puede resetear la sesión de WhatsApp' });
    }

    console.log('[WPP SERVER] Reset de sesión solicitado por', req.user?.id);

    // 0) LIMPIAR COLA: descartar todos los pendientes para que no salgan masivamente
    try {
      await query(`
        UPDATE wpp_outbox
        SET status = 'skipped',
            error  = 'Descartado por reset de sesión de WhatsApp'
        WHERE status = 'pending'
      `);
      console.log('[WPP SERVER] Cola wpp_outbox limpiada (pending -> skipped).');
    } catch (e) {
      console.warn('[WPP SERVER] No se pudo limpiar wpp_outbox en reset:', e.message);
    }

    // 1) Intentar logout (si está conectado)
    try {
      if (wppClient) {
        await wppClient.logout();
      }
    } catch (e) {
      console.warn('[WPP SERVER] Error en logout (puede no estar logueado):', e.message);
    }

    // 2) Borrar carpeta de sesión de LocalAuth (coincide con clientId: 'server_session_hidro')
    try {
      const sessionDir = path.join(__dirname, '.wwebjs_auth', 'server_session_hidro');
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log('[WPP SERVER] Carpeta de sesión eliminada:', sessionDir);
    } catch (e) {
      console.warn('[WPP SERVER] No se pudo borrar carpeta de sesión:', e.message);
    }

    // 3) Resetear flags y re-inicializar para que dispare un nuevo QR
    lastQr = null;
    isConnected = false;
    isReadyWpp = false;

    try {
      if (wppClient) {
        await wppClient.initialize();
      }
    } catch (e) {
      console.warn('[WPP SERVER] Error re-inicializando cliente WPP:', e.message);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[WPP SERVER] Error general en reset de sesión:', e);
    return res.status(500).json({ error: 'No se pudo resetear la sesión de WhatsApp' });
  }
});

// --------------------------------------------------
// FUNCIONES AUXILIARES PARA WHATSAPP
// --------------------------------------------------

// Función para reiniciar WhatsApp cuando hay errores graves
async function reiniciarWhatsApp() {
  if (!wppClient) return;
  
  try {
    console.log('[WPP] Reiniciando cliente WhatsApp por error grave...');
    
    // Desconectar primero
    try {
      await wppClient.destroy();
    } catch (e) {
      console.warn('[WPP] Error al destruir cliente:', e.message);
    }
    
    // Resetear flags
    isConnected = false;
    isReadyWpp = false;
    lastQr = null;
    
    // Esperar 5 segundos
    await new Promise(r => setTimeout(r, 5000));
    
    // Re-inicializar
    await wppClient.initialize();
    
    console.log('[WPP] Cliente WhatsApp reinicializado.');
    
  } catch (e) {
    console.error('[WPP] Error en reinicio de WhatsApp:', e);
  }
}

// Función segura para escapar strings para SQL
function safeErrorString(err) {
  if (!err) return null;
  const str = String(err)
    .replace(/'/g, "''")  // Escapar comillas simples para PostgreSQL
    .replace(/\\/g, "\\\\")  // Escapar backslashes
    .slice(0, 200);
  return str;
}

// --------------------------------------------------
// PROCESADOR DE COLA WHATSAPP (Outbox Loop) CORREGIDO
// --------------------------------------------------

let isProcessing = false; // 🔒 Semáforo para evitar superposición

async function processOutbox() {
  // 👇 AHORA chequeamos isReadyWpp en lugar de solo isConnected
  if (!ENABLE_WPP || !isReadyWpp || isProcessing || !wppClient) return;

  isProcessing = true;

  try {
    // ========== LIMPIEZA AUTOMÁTICA: MENSAJES > 1 DÍA ==========
    const cleanupResult = await query(`
      UPDATE wpp_outbox 
      SET status = 'skipped', 
          error = 'Caducado - Más de 1 día en cola'
      WHERE status = 'pending' 
        AND created_at < NOW() - INTERVAL '1 day'
      RETURNING id
    `);
    
    if (cleanupResult.length > 0) {
      console.log(`[WPP CLEANUP] ✅ Limpiados ${cleanupResult.length} mensajes viejos (>1 día)`);
    }
    // ===========================================================

    const rows = await query(`
      SELECT id, telefono, mensaje 
      FROM wpp_outbox 
      WHERE status = 'pending' 
        AND created_at > NOW() - INTERVAL '1 day'  -- Solo últimos 1 día
      ORDER BY id ASC 
      LIMIT 3
    `);

    if (!rows.length) {
      return; // el finally igual va a resetear isProcessing
    }

    console.log(`[DEBUG OUTBOX] Procesando ${rows.length} mensajes pendientes...`);

    for (const row of rows) {
      let chatId = null;
      let errorMessage = null;

      try {
        // -------------------------
        // 1) Normalizar teléfono
        // -------------------------
        let rawPhone = String(row.telefono || '').trim();

        // Por si en algún flujo quedó guardado como "549...@c.us"
        if (rawPhone.includes('@')) {
          rawPhone = rawPhone.split('@')[0];
        }

        const numeroBase = rawPhone.replace(/\D+/g, '');
        if (!numeroBase) {
          throw new Error('telefono_invalido');
        }

        // Verificar formato internacional
        let phoneToUse = numeroBase;
        if (phoneToUse.startsWith('9') && phoneToUse.length === 10) {
          phoneToUse = '549' + phoneToUse; // Argentina
        }

        chatId = `${phoneToUse}@c.us`;

        // -------------------------
        // 2) Validar si el chat existe (opcional)
        // -------------------------
        try {
          const chat = await wppClient.getChatById(chatId).catch(() => null);
          if (!chat) {
            console.warn(`[WPP OUTBOX] Chat no encontrado: ${chatId}, marcando como error`);
            throw new Error('chat_no_encontrado');
          }
        } catch (chatErr) {
          // Continuamos igual, WhatsApp puede crear el chat al enviar
        }

        // -------------------------
        // 3) Enviar con timeout
        // -------------------------
        console.log(`[DEBUG OUTBOX] Enviando ID:${row.id} a ${chatId}...`);
        const sendPromise = wppClient.sendMessage(chatId, row.mensaje);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout enviando a WPP')), 8000)
        );

        await Promise.race([sendPromise, timeoutPromise]);
        console.log(`[DEBUG OUTBOX] ✅ Mensaje ID:${row.id} enviado con éxito.`);

        // Si no explota, marcamos como enviado
        await query(
          `UPDATE wpp_outbox 
           SET status = 'sent', 
               sent_at = NOW(),
               error = NULL
           WHERE id = $1`,
          [row.id]
        );

        // -------------------------
        // 4) Pausa inteligente anti-flood
        // -------------------------
        const index = rows.indexOf(row);
        if (index > 0 && index % 3 === 0) {
          console.log('[WPP OUTBOX] Pausa anti-flood: 1.5 segundos...');
          await new Promise(r => setTimeout(r, 1500));
        } else {
          await new Promise(r => setTimeout(r, 700)); // Pausa normal
        }

      } catch (err) {
        errorMessage = String(err && err.message ? err.message : err);
        const errorLower = errorMessage.toLowerCase();
        
        // Detectar errores críticos
        const isConnectionError = 
          errorLower.includes('not connected') ||
          errorLower.includes('disconnected') ||
          errorLower.includes('closed') ||
          errorLower.includes('websocket');
        
        const isFrameDetached = 
          errorLower.includes('detached frame') ||
          errorLower.includes('frame detached');
        
        const isPhoneError = 
          errorLower.includes('invalid') ||
          errorLower.includes('phone') ||
          errorLower.includes('number') ||
          errorLower.includes('chat_no_encontrado') ||
          errorLower.includes('telefono_invalido');
        
        // BUG conocido de whatsapp-web.js
        const isSeenBug =
          errorMessage.includes('markedUnread') ||
          errorLower.includes('sendseen');

        console.error(`[WPP OUTBOX] Error ID:${row.id} tel:${row.telefono}:`, errorMessage);

        // Preparar mensaje de error seguro
        const errorSafe = safeErrorString(errorMessage);
        let statusToSet = 'error';
        let finalError = errorSafe;

        if (isFrameDetached) {
          // ERROR CRÍTICO: Frame detached - WhatsApp necesita reinicio completo
          console.error('[WPP OUTBOX] ❌ Frame detached - WhatsApp necesita reinicio');
          finalError = 'WhatsApp desconectado (frame detached)';
          statusToSet = 'error';
          
          // Marcar el mensaje como error primero
          await query(
            `UPDATE wpp_outbox 
             SET status = $1, 
                 error = $2
             WHERE id = $3`,
            [statusToSet, finalError, row.id]
          );
          
          // Luego reiniciar WhatsApp
          await reiniciarWhatsApp();
          break; // Salir del loop completamente
          
        } else if (isConnectionError) {
          // Error de conexión
          finalError = 'WhatsApp desconectado';
          statusToSet = 'error';
          await query(
            `UPDATE wpp_outbox 
             SET status = $1, 
                 error = $2
             WHERE id = $3`,
            [statusToSet, finalError, row.id]
          );
          console.error('[WPP OUTBOX] ❌ WhatsApp desconectado, deteniendo procesamiento...');
          break;
          
        } else if (isSeenBug) {
          // Bug sendSeen: marcar como enviado pero con advertencia
          console.warn(`[WPP OUTBOX] Bug sendSeen ID:${row.id} -> marcado como enviado`);
          statusToSet = 'sent';
          finalError = 'Bug sendSeen (marcado como enviado)';
          await query(
            `UPDATE wpp_outbox 
             SET status = $1,
                 sent_at = COALESCE(sent_at, NOW()),
                 error = $2
             WHERE id = $3`,
            [statusToSet, finalError, row.id]
          );
          
        } else if (isPhoneError) {
          // Número inválido
          console.error(`[WPP OUTBOX] Número inválido ID:${row.id} -> marcado como error`);
          statusToSet = 'error';
          finalError = 'Número de teléfono inválido';
          await query(
            `UPDATE wpp_outbox 
             SET status = $1, 
                 error = $2
             WHERE id = $3`,
            [statusToSet, finalError, row.id]
          );
          
        } else {
          // Error genérico
          console.error(`[WPP OUTBOX] Error genérico ID:${row.id}: ${errorMessage}`);
          statusToSet = 'error';
          await query(
            `UPDATE wpp_outbox 
             SET status = $1, 
                 error = $2
             WHERE id = $3`,
            [statusToSet, errorSafe, row.id]
          );
        }
        
        // Pausa más larga después de error
        await new Promise(r => setTimeout(r, 1500));
      }
    }

  } catch (e) {
    console.error('[WPP OUTBOX] Error general en processOutbox:', e);
  } finally {
    isProcessing = false; // Se libera siempre
  }
}

// --- PROCESAMIENTO DE COLA (Cada 2.5 segundos cuando esté conectado) ---
if (ENABLE_WPP) {
  console.log('[WPP SERVER] WhatsApp habilitado. Inicializando cliente...');

  // DETECCIÓN DE ENTORNO
  const isRender = process.env.RENDER === 'true';
  
  // EN RENDER: usar Chromium del sistema
  // EN LOCAL: usar Chrome instalado
  let puppeteerConfig = {
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ]
  };

  if (isRender) {
    console.log('[WPP RENDER] Usando Chromium del sistema...');
    // Render ya tiene Chromium instalado en /usr/bin/chromium-browser
    puppeteerConfig.executablePath = '/usr/bin/chromium-browser';
    puppeteerConfig.args.push(
      '--disable-features=VizDisplayCompositor',
      '--window-size=1920,1080',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--use-gl=egl',
      '--disable-software-rasterizer'
    );
  } else {
    console.log('[WPP LOCAL] Usando Chrome instalado localmente...');
    // En local, usar Chrome instalado por puppeteer
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  }

  wppClient = new Client({
    authStrategy: new LocalAuth({
      clientId: isRender ? 'server_session_hidro_render' : 'server_session_hidro'
    }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.x.html',
    },
    puppeteer: puppeteerConfig
  });

  // --- Eventos base de conexión --- //
  wppClient.on('qr', (qr) => {
    lastQr = qr;
    isConnected = false;
    isReadyWpp = false;
    console.log('[WPP SERVER] QR RECIBIDO. Escanea para conectar.');
  });

  wppClient.on('authenticated', async () => {
    isConnected = true;
    isReadyWpp = false;
    lastQr = null;
    console.log('[WPP SERVER] Autenticado ✅');
    
    // Forzamos el inicio de handlers aquí por si 'ready' no llega
    if (!wppHandlersStarted) {
      wppHandlersStarted = true;
      try {
        console.log('[WPP SERVER] Iniciando handlers preventivamente (authenticated)...');
        await handlers.start(wppClient);
        console.log('[WPP SERVER] Handlers iniciados preventivamente.');
      } catch (e) {
        wppHandlersStarted = false;
        console.error('[WPP SERVER] Error en handlers preventivos:', e);
      }
    }
  });

  wppClient.on('auth_failure', (msg) => {
    console.error('[WPP SERVER] Falla de auth:', msg);
  });

  // 👇 Debug extra para ver qué pasa en Render
  wppClient.on('change_state', (state) => {
    console.log('[WPP SERVER] Estado cliente WPP:', state);
  });

  wppClient.on('loading_screen', (percent, message) => {
    console.log('[WPP SERVER] Cargando WhatsApp Web:', percent, '% -', message);
  });

  wppClient.on('error', (err) => {
    console.error('[WPP SERVER] ERROR cliente WPP:', err);
  });

  wppClient.on('ready', async () => {
    isConnected = true;
    isReadyWpp = true;
    lastQr = null;
    console.log('[WPP SERVER] CLIENTE LISTO (READY) ✅');

    // Iniciar handlers en READY para asegurar que el cliente puede recibir mensajes
    if (!wppHandlersStarted) {
      wppHandlersStarted = true;
      try {
        console.log('[WPP SERVER] Iniciando handlers de texto...');
        await handlers.start(wppClient);
        console.log('[WPP SERVER] Handlers de texto iniciados correctamente.');
      } catch (e) {
        wppHandlersStarted = false;
        console.error('[WPP SERVER] Error iniciando handlers:', e);
      }
    } else {
      console.log('[WPP SERVER] Handlers ya estaban iniciados.');
    }

    // ──────────────────────────────────────────────
    // PARCHE: desactivar WWebJS.sendSeen en el navegador
    // para evitar el bug "markedUnread" de whatsapp-web.js
    // ──────────────────────────────────────────────
    try {
      const page = wppClient.pupPage;

      if (page && (typeof page.evaluate === 'function' || typeof page.evaluateOnNewDocument === 'function')) {
        // 1) Parche para esta sesión actual
        if (typeof page.evaluate === 'function') {
          await page.evaluate(() => {
            try {
              if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                window.WWebJS.sendSeen = async () => {
                  // sendSeen desactivado intencionalmente para evitar bug markedUnread
                };
              }
            } catch (e) {
              // ignorar errores dentro del contexto del navegador
            }
          });
        }

        // 2) Parche futuro: si whatsapp-web.js reinyecta scripts,
        //    esto ayuda a que ya arranquen con sendSeen no-op.
        if (typeof page.evaluateOnNewDocument === 'function') {
          await page.evaluateOnNewDocument(() => {
            try {
              if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                window.WWebJS.sendSeen = async () => {
                  // sendSeen desactivado intencionalmente para evitar bug markedUnread
                };
              }
            } catch (e) {
              // ignorar errores dentro del contexto del navegador
            }
          });
        }

        console.log('[WPP SERVER] Parche WWebJS.sendSeen aplicado (no-op).');
      } else {
        console.warn('[WPP SERVER] No se encontró pupPage para parchear sendSeen.');
      }
    } catch (e) {
      console.warn('[WPP SERVER] No se pudo parchear WWebJS.sendSeen:', e);
    }

    // 👇 Ya NO iniciamos handlers acá.
    // Se inician en "authenticated" para que el bot funcione
    // aunque "ready" nunca llegue a dispararse.
  });

  wppClient.on('disconnected', (reason) => {
    isConnected = false;
    isReadyWpp = false;
    console.log('[WPP SERVER] Desconectado. Razón:', reason);
  });

  // 2. LISTENER DE MEDIA (Transferencias)
  wppClient.on('message', async (msg) => {
    console.log(`[DEBUG WPP] Evento 'message' detectado en server.js desde: ${msg.from}`);
    try {
      // 🛑 FIX CRÍTICO: Ignorar Estados/Historias de WhatsApp
      if (msg.from === 'status@broadcast' || msg.isStatus) {
        return;
      }

      // 1. Solo chats individuales
      if (msg.from.includes('@g.us')) {
        return;
      }

      // 2. Filtramos mensajes propios
      if (msg.fromMe || msg.id?.fromMe) return;

      const t = String(msg.type || '').toLowerCase();
      // Detectar si es imagen o documento (PDF)
      const isMedia = (msg.hasMedia || t === 'image' || t === 'document');

      if (isMedia) {
        const telefonoLimpio = msg.from.replace(/\D/g, '');

        const clienteQuery = await query(
          `SELECT id FROM puntos_entrega 
           WHERE telefono_normalizado LIKE '%' || $1 
           LIMIT 1`,
          [telefonoLimpio.slice(-10)]
        );

        if (clienteQuery.length === 0) {
          if (process.env.DEBUG_ORDERS === '1') {
            console.log(`[WPP MEDIA] Ignorado: El número ${msg.from} no es un cliente registrado.`);
          }
          return;
        }

        console.log(`[WPP MEDIA] Recibido archivo de cliente registrado: ${msg.from} tipo: ${t}`);

        const media = await msg.downloadMedia().catch(err => {
          console.error('[WPP MEDIA] Error descargando:', err.message);
          return null;
        });

        if (media) {
          const buffer = Buffer.from(media.data, 'base64');

          await handleIncomingComprobanteFromBotPg({
            type: t,
            telefono: msg.from,
            buffer: buffer,
            base64: media.data,
            mimetype: media.mimetype,
            filename: media.filename || msg.body?.slice(0, 20) || 'archivo'
          });
        }
      }
    } catch (e) {
      console.error('[WPP SERVER] Error global mensaje:', e);
    }
  });

  // Inicializar cliente WPP con catch para no tumbar el servidor si falla
  wppClient.initialize()
    .then(() => {
      console.log('[WPP SERVER] Cliente WhatsApp inicializando...');
    })
    .catch(err => {
      console.error('[WPP SERVER] Error inicializando cliente WhatsApp:', err);
    });

} else {
  console.log('[WPP SERVER] WhatsApp deshabilitado en este entorno (ENABLE_WPP=0)');
}

// --- PROCESADOR DE COLA WHATSAPP (Outbox Loop) CORREGIDO ---
if (ENABLE_WPP) {
  // Intervalo más inteligente: procesar solo si está conectado y no procesando
  setInterval(() => {
    if (isReadyWpp && !isProcessing) {
      processOutbox();
    }
  }, 2500);
  
  // Log de estado periódico con métricas
  setInterval(async () => {
    if (ENABLE_WPP) {
      try {
        const pendingResult = await query(
          'SELECT COUNT(*) as count FROM wpp_outbox WHERE status = $1',
          ['pending']
        );
        const pendingCount = pendingResult[0]?.count || 0;
        
        console.log(`[WPP STATUS] Ready: ${isReadyWpp}, Processing: ${isProcessing}, Connected: ${isConnected}, Pending: ${pendingCount}`);
      } catch (e) {
        console.log(`[WPP STATUS] Ready: ${isReadyWpp}, Processing: ${isProcessing}, Connected: ${isConnected}`);
      }
    }
  }, 30000); // Cada 30 segundos
}
// --- 2. MAYORDOMO IA (Diario a las 09:00 AM) ---

const ARG_UTC_OFFSET = -3; 

function programarTareaDiaria(horaArgentina, minuto, tarea) {
  const ahora = new Date();
  const proximaEjecucion = new Date(ahora);

  // Convertir hora Argentina -> hora UTC
  // Si AR = UTC-3, entonces UTC = AR + 3
  const diferenciaHoras = -ARG_UTC_OFFSET; // 3
  const horaUTC = (horaArgentina + diferenciaHoras + 24) % 24;

  // Configurar la próxima ejecución en UTC
  proximaEjecucion.setUTCHours(horaUTC, minuto, 0, 0);

  // Si la hora ya pasó hoy (en UTC), programar para mañana
  if (proximaEjecucion <= ahora) {
    proximaEjecucion.setUTCDate(proximaEjecucion.getUTCDate() + 1);
  }

  const tiempoHastaEjecucion = proximaEjecucion.getTime() - ahora.getTime();

  console.log(
    '[CRON] Tarea diaria programada para (ARG):',
    proximaEjecucion.toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires'
    })
  );

  // Esperar hasta la hora indicada, ejecutar y luego repetir cada 24h
  setTimeout(() => {
    tarea();
    setInterval(tarea, 24 * 60 * 60 * 1000);
  }, tiempoHastaEjecucion);
}

// --- 3. AUDITORÍA DE LICENCIAS (Diario) ---
programarTareaDiaria(4, 0, async () => { // Ejecutar a las 04:00 AM
  console.log('[CRON] Verificando licencias vencidas...');
  
  try {
    // 1. Marcar como 'expired' las que vencieron ayer
    const expired = await query(`
      UPDATE empresas 
      SET plan_estado = 'expired' 
      WHERE plan_estado = 'active' 
        AND plan_vencimiento < NOW()
      RETURNING id
    `);
    
    if (expired.length > 0) {
      console.log(`[CRON] Se vencieron ${expired.length} licencias hoy (pasaron a estado 'expired').`);
    }

    // 2. ELIMINAR EMPRESAS muertas hace más de 180 días (6 meses)
    const dead = await query(`
      DELETE FROM empresas 
      WHERE plan_vencimiento < (NOW() - INTERVAL '180 days')
      RETURNING id, nombre
    `);
    
    if (dead.length > 0) {
      console.log(`[CRON] 💀 LIMPIEZA TOTAL: Se eliminaron ${dead.length} empresas abandonadas hace >6 meses.`);
      dead.forEach(d => console.log(` - Eliminada: ID ${d.id} (${d.nombre})`));
    } else {
      console.log('[CRON] Limpieza: No hay empresas antiguas para eliminar hoy.');
    }

  } catch (e) {
    console.error('[CRON ERROR] Falló la auditoría de licencias:', e);
  }
});

// Iniciar la programación (ej: 09:00 AM)
programarTareaDiaria(9, 0, () => {
  console.log('[CRON] Ejecutando Reposición Predictiva...');
  ejecutarReposicionPredictiva().catch(err => console.error('[CRON ERROR]', err));
});

// CRON: Limpieza diaria de puntos de tracking antiguos
app.post('/internal/cron/cleanup-tracking', async (req, res) => {
  // 🔒 (OPCIONAL pero MUY recomendable): proteger con un secreto
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['x-cron-secret'] !== cronSecret) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    console.log('[CRON CLEANUP] Iniciando limpieza de tracking…');

    const deleted = await query(`
      DELETE FROM pedido_track_points ptk
      USING pedidos p
      WHERE ptk.pedido_id = p.id
        AND p.estado = 'entregado'
        AND ptk."timestamp" < NOW() - INTERVAL '1 day'
      RETURNING ptk.id
    `);

    console.log(`[CRON CLEANUP] Puntos de tracking borrados: ${deleted.length}`);
    return res.json({ ok: true, deleted: deleted.length });
  } catch (err) {
    console.error('cleanup-tracking ERROR', err);
    return res.status(500).json({ error: 'error' });
  }
});

// CRON: Limpieza de mensajes viejos de WhatsApp (sent/error/skipped > 7 días)
app.post('/internal/cron/cleanup-wpp', async (req, res) => {
  // 🔒 proteger igual que el de tracking
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['x-cron-secret'] !== cronSecret) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    console.log('[CRON CLEANUP WPP] Iniciando limpieza de wpp_outbox…');

    const deleted = await query(`
      DELETE FROM wpp_outbox
      WHERE status IN ('sent', 'error', 'skipped')
        AND created_at < NOW() - INTERVAL '7 days'
      RETURNING id
    `);

    const count = deleted.length;

    if (count > 0) {
      console.log(`[CRON CLEANUP WPP] Se borraron ${count} mensajes viejos de WhatsApp.`);
    } else {
      console.log('[CRON CLEANUP WPP] No había mensajes para borrar.');
    }

    return res.json({ ok: true, deleted: count });
  } catch (err) {
    console.error('cleanup-wpp ERROR', err);
    return res.status(500).json({ error: 'error al limpiar wpp' });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`🚀 Servidor unificado corriendo en puerto ${PORT}`));