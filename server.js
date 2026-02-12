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
import { trackingPublicRouter } from './src/trackingPublic.js';
import pkg from 'whatsapp-web.js';
import crypto from 'node:crypto';
import qrcode from 'qrcode';
import { ejecutarReposicionPredictiva, ejecutarEstrategiaVecinos } from './src/estrategias.js';
import OpenAI from 'openai';
import { crearPreferenciaLicencia, obtenerPago } from './src/mercadoPagoService.js';
import handlers from './src/handlers.js';
import { handleIncomingComprobanteFromBotPg } from './src/transferenciasPipeline.js';
import costosRouter from './src/adm/costosRouter.js';
import activosRouter from './src/adm/activosRouter.js';
import alquileresRouter from './src/adm/alquileresRouter.js'; 
import {registrarMovimientosActivosDesdePedido,registrarActivosDesdePedidoEntrega } from './src/adm/pedidoActivosService.js';

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

const PAGES_DIR = path.join(__dirname, 'pages');
if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR, { recursive: true });

// Helper: nombre y path del archivo HTML asociado a una empresa
function getEmpresaLandingFilename(empresaId) {
  return `empresa_${empresaId}.html`;
}
function getEmpresaLandingPath(empresaId) {
  return path.join(PAGES_DIR, getEmpresaLandingFilename(empresaId));
}

// Uploader para LANDINGS HTML
const pagesUploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 }, // máx ~500KB de HTML
  fileFilter: (_, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    const isHtml =
      file.mimetype === 'text/html' ||
      name.endsWith('.html') ||
      name.endsWith('.htm');

    cb(isHtml ? null : new Error('Solo se permiten archivos .html'), isHtml);
  }
});

// 1. Detectar archivo index por defecto en la raíz
function resolveDefaultIndex() {
  const htm  = path.join(__dirname, 'index.htm');
  const html = path.join(__dirname, 'index.html');
  if (fs.existsSync(htm))  return htm;
  if (fs.existsSync(html)) return html;
  return null;
}
const DEFAULT_INDEX = resolveDefaultIndex();

// 2. Función auxiliar para normalizar host (quitar www y puerto)
function normalizeHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  return h.replace(/^www\./, '');
}

// 3. Resolver ruta física del archivo HTML basado en Dominio / Slug / empresa_id
async function resolvePagePath(req) {
  // A. ¿Viene forzado por parámetro ?slug=xyz?
  const slugParamRaw = (req.query?.slug || '').toString().trim().toLowerCase();
  if (slugParamRaw) {
    // Si el slug es numérico, lo interpretamos directamente como empresa_id
    if (/^\d+$/.test(slugParamRaw)) {
      const empresaId = Number(slugParamRaw);
      const byId = getEmpresaLandingPath(empresaId);
      if (fs.existsSync(byId)) return byId;
    } else {
      // Slug "texto": buscamos la empresa por landing_slug
      const cleanSlug = slugParamRaw.replace(/[^a-z0-9\-]/g, '');
      if (cleanSlug) {
        try {
          // --- CORRECCIÓN AQUÍ: Quitamos { } ---
          const rows = await query(
            `SELECT id
             FROM empresas
             WHERE LOWER(landing_slug) = $1
             LIMIT 1`,
            [cleanSlug]
          );
          if (rows && rows.length) {
            const empresaId = rows[0].id;
            const bySlug = getEmpresaLandingPath(empresaId);
            if (fs.existsSync(bySlug)) return bySlug;
          }
        } catch (e) {
          console.error('Error resolviendo slug landing:', e.message);
        }
      }
    }
  }

  // B. ¿Viene empresa_id explícito en la query? (?empresa_id=123)
  const empresaIdParam = (req.query?.empresa_id || '').toString().trim();
  if (empresaIdParam && /^\d+$/.test(empresaIdParam)) {
    const empresaId = Number(empresaIdParam);
    const byEmpresaParam = getEmpresaLandingPath(empresaId);
    if (fs.existsSync(byEmpresaParam)) return byEmpresaParam;
  }

  // C. Detección por Dominio en Base de Datos
  const host = normalizeHost(req.headers['x-forwarded-host'] || req.headers.host);

  // Evitamos consultar DB si es localhost o IP directa (optimización opcional)
  if (host.includes('localhost') || host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
    return null;
  }

  try {
    const rows = await query(
      `SELECT id
       FROM empresas
       WHERE LOWER(landing_domain) = $1
          OR LOWER(landing_domain) = $2
       LIMIT 1`,
      [host, `www.${host}`]
    );

    if (rows && rows.length) {
      const empresaId = rows[0].id;
      const byDomain = getEmpresaLandingPath(empresaId);
      if (fs.existsSync(byDomain)) return byDomain;
    }
  } catch (e) {
    console.error('Error resolviendo dominio landing:', e.message);
  }

  return null; // No se encontró página específica
}

// 4. Handler Principal (Middleware)
async function serveDetectedPage(req, res) {
  try {
    // a) Intentamos resolver página específica
    const customPage = await resolvePagePath(req);
    if (customPage) return res.sendFile(customPage);

    // b) Si no hay específica, servimos index global
    if (DEFAULT_INDEX) return res.sendFile(DEFAULT_INDEX);

    // c) Si no hay index global, mandamos al carrito/login
    return res.redirect('/pedidos/login.html');
  } catch (err) {
    console.error('Error en serveDetectedPage:', err);
    res.status(500).send('Error interno en ruteo');
  }
}

// --- CONFIGURACIÓN DE RUTAS RAÍZ ---

// Servir estáticos de la carpeta pages (por si se piden recursos relativos)
if (fs.existsSync(PAGES_DIR)) {
  app.use('/pages', express.static(PAGES_DIR, { index: false }));
}

// Archivos sueltos específicos en raíz
app.get('/simple-cart.js', (req, res) => res.sendFile(path.join(__dirname, 'simple-cart.js')));

// Rutas principales que disparan la detección
app.get('/', serveDetectedPage);
app.get(['/index', '/index.html', '/index.htm'], serveDetectedPage);

// EXCLUYENDO: /api, /public, /pedidos, /Transferencia, /Gastos
app.get(/^\/(?!api\/|public\/|pedidos\/|Transferencia\/|Gastos\/).*/, serveDetectedPage);

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

// ==================================================
// LÓGICA DE USUARIOS EFÍMEROS (OPCIÓN A)
// ==================================================

// 1. Crear Usuario Invitado (Nace la sesión temporal)
app.post('/api/auth/guest', async (req, res) => {
  try {
    const empresa_id = Number(req.body.empresa_id) || 1;
    // Generamos un username aleatorio para cumplir el UNIQUE de la DB
    const randomSuffix = crypto.randomBytes(4).toString('hex'); 
    const tempUsername = `guest_${Date.now()}_${randomSuffix}`;

    // Insertamos usuario con expiración (ej: 2 horas)
    const result = await query(
      `INSERT INTO usuarios (username, password, role, empresa_id, es_invitado, fecha_expiracion)
       VALUES ($1, NULL, 'guest', $2, TRUE, NOW() + INTERVAL '2 hours')
       RETURNING id, username, role, empresa_id`,
      [tempUsername, empresa_id]
    );

    const user = result[0];

    // Generamos Token (igual que en login)
    const token = jwt.sign({
      uid: user.id, 
      username: user.username, 
      empresa_id: user.empresa_id,
      role: 'guest'
    }, process.env.JWT_SECRET || 'dev', { expiresIn: '2h' });

    // Cookie opcional
    res.cookie('token', token, {
      httpOnly: true, sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production', maxAge: 2 * 60 * 60 * 1000,
    });

    res.json({ ok: true, token, user });
  } catch (e) {
    console.error('ERROR GUEST:', e);
    res.status(500).json({ error: 'Error creando sesión de invitado' });
  }
});

// 2. Convertir Invitado a Usuario Real (El "Salvavidas")
app.post('/api/auth/register', withAuth, async (req, res) => {
  try {
    const { username, password, telefono } = req.body;
    const userId = req.user.uid; // ID del token actual (el invitado)

    if (!username || !password) return res.status(400).json({ error: 'Datos incompletos' });

    // Verificamos si el usuario actual es realmente un invitado
    const check = await query('SELECT es_invitado FROM usuarios WHERE id=$1', [userId]);
    if (!check.length || !check[0].es_invitado) {
      return res.status(400).json({ error: 'Este usuario ya está registrado o no existe.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(String(password), salt);

    // ACTUALIZAMOS el registro existente (así se queda con el historial de pedidos/carrito)
    await query(
      `UPDATE usuarios 
       SET username = $1, 
           password = $2, 
           telefono = $3,
           es_invitado = FALSE, 
           fecha_expiracion = NULL,
           role = 'user'
       WHERE id = $4`,
      [username, hash, telefono || null, userId]
    );

    // Opcional: regenerar token con nuevo rol 'user' y expiración larga
    const newToken = jwt.sign({
      uid: userId, username, empresa_id: req.user.empresa_id, role: 'user'
    }, process.env.JWT_SECRET || 'dev', { expiresIn: '7d' });

    res.json({ ok: true, message: 'Cuenta creada con éxito', token: newToken });

  } catch (e) {
    if (e.message.includes('unique')) return res.status(400).json({ error: 'El email ya está en uso' });
    console.error('REGISTER ERROR:', e);
    res.status(500).json({ error: 'Error en registro' });
  }
});

// ==================================================
// REGISTRO "PRO" (Usuario + Nueva Empresa + Trial 30 días)
// ==================================================
app.post('/api/auth/signup-full', async (req, res) => {
  try {
    const { 
      username, password, telefono, email, // Datos Usuario
      empresa_nombre, rubro                // Datos Empresa
    } = req.body;

    // 1. Validaciones básicas
    if (!username || !password || !empresa_nombre) {
      return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // 2. Hash password
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(String(password), salt);

    // 3. Generar slug y dominio provisional (slug.tuapp.com)
    const slug = empresa_nombre.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now().toString().slice(-4);
    
    // INICIO TRANSACCIÓN (Todo o Nada)
    await query('BEGIN');

    try {
      // A. Crear Empresa (30 días de trial automáticos por default en DB)
      // Ajustamos el vencimiento explícitamente para asegurar
      const empRes = await query(
        `INSERT INTO empresas (
            nombre, telefono, email, rubro, landing_slug, 
            plan_estado, plan_tipo, plan_vencimiento, setup_steps
         )
         VALUES ($1, $2, $3, $4, $5, 'active', 'trial', NOW() + INTERVAL '30 days', '{}')
         RETURNING id`,
        [empresa_nombre, telefono, email, rubro || 'general', slug]
      );
      const newEmpresaId = empRes[0].id;

      // B. Crear Usuario Admin (Role: user, vinculado a la empresa)
      const userRes = await query(
        `INSERT INTO usuarios (username, password, role, empresa_id, telefono)
         VALUES ($1, $2, 'user', $3, $4)
         RETURNING id, username, role, empresa_id`,
        [username, hash, newEmpresaId, telefono]
      );
      const newUser = userRes[0];

      // C. Confirmar Transacción
      await query('COMMIT');

      // 4. Auto-Login (Generar Token)
      const token = jwt.sign({
        uid: newUser.id, 
        username: newUser.username, 
        empresa_id: newUser.empresa_id,
        role: newUser.role
      }, process.env.JWT_SECRET || 'dev', { expiresIn: '7d' });

      res.json({ ok: true, token, user: newUser, message: '¡Empresa creada con éxito!' });

    } catch (err) {
      await query('ROLLBACK'); // Si falla algo, deshacemos todo
      console.error('ROLLBACK SIGNUP:', err);
      if (err.message.includes('users_username_key') || err.message.includes('unique')) {
        return res.status(400).json({ error: 'El usuario o empresa ya existen.' });
      }
      throw err;
    }

  } catch (e) {
    console.error('SIGNUP ERROR:', e);
    res.status(500).json({ error: 'Error interno al crear cuenta.' });
  }
});

// ==================================================
// RUTAS PÚBLICAS PARA LANDINGS (SIN AUTH)
// ==================================================

// 1. Configuración (Título de la web)
app.get('/api/public/config', async (req, res) => {
  try {
    const host = normalizeHost(req.headers['x-forwarded-host'] || req.headers.host);
    // Buscamos si el dominio coincide con alguna empresa
    const rows = await query(
      'SELECT id AS empresa_id, nombre, landing_slug FROM empresas WHERE landing_domain = $1 LIMIT 1', 
      [host]
    );
    // Si encuentra, devuelve info, si no, devuelve objeto vacío (el front usa el ID hardcodeado igual)
    res.json(rows[0] || {});
  } catch (e) {
    res.status(500).json({});
  }
});

// 2. Productos (Catálogo visible)
app.get('/api/public/productos', async (req, res) => {
  try {
    const empresaId = Number(req.query.empresa_id);
    const scope = req.query.scope; // 'landing' o null

    if (!empresaId) return res.json([]);

    let sql = `
      SELECT id, nombre, descripcion, precio, imagen, imagen_promo, etiqueta, categoria
      FROM productos 
      WHERE empresa_id = $1 
        AND activo = true
    `;

    // Si la web pide scope=landing, filtramos estrictamente
    if (scope === 'landing') {
       sql += ` AND mostrar_en_landing = true`;
    }

    sql += ` ORDER BY orden ASC, id DESC`;

    const rows = await query(sql, [empresaId]);
    res.json(rows);
  } catch (e) {
    console.error('Error public products:', e);
    res.status(500).json({ error: 'Error cargando catálogo' });
  }
});

// 3. Buscador de Pedidos (Estado del pedido)
app.get('/api/public/pedidos/ultimo', async (req, res) => {
  try {
    const empresaId = Number(req.query.empresa_id);
    const telefono = req.query.telefono;
    
    if(!empresaId || !telefono) return res.status(400).json({ error: 'Datos incompletos' });

    const rows = await query(`
      SELECT p.id, p.estado, p.monto, p.fecha 
      FROM pedidos p
      JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      WHERE pe.empresa_id = $1 
        AND pe.telefono_normalizado LIKE '%' || $2 
      ORDER BY p.id DESC LIMIT 1
    `, [empresaId, telefono.slice(-10)]); // Buscamos por los últimos 10 dígitos

    if (rows.length) res.json(rows[0]);
    else res.json({}); 
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error buscando pedido' });
  }
});

app.use('/api/public', trackingPublicRouter);

// Módulo de Administración de Costos / Activos
app.use('/api/admin/costos', costosRouter);
app.use('/api/admin/activos', activosRouter);
app.use('/api/admin/alquileres', alquileresRouter);

// --------------------------------------------------
// Transferencias (comprobantes de transferencia)
// --------------------------------------------------

// Uploader para comprobantes de transferencia
const transferUploader = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, TRANSF_DIR),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname || '') || '.bin';
      cb(null, `tr-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB, igual que gastos
  fileFilter: (_, file, cb) => {
    const ok = /image|pdf/.test(file.mimetype);
    cb(ok ? null : new Error('Tipo no permitido'), ok);
  }
});

// LISTAR TRANSFERENCIAS
app.get('/api/transferencias', withAuth, async (req, res) => {
  try {
    const { chofer_id, empresa_id, estado } = req.query || {};
    const esSuper   = isSuper(req);
    const myEmpresa = getEmpresaIdFromToken(req);

    const fecha = (req.query.fecha || '').toString().slice(0, 10);

    let sql = `
      SELECT
        ct.id AS transferencia_id,
        ct.id,
        ct.fecha,
        -- SI EL MONTO DEL COMPROBANTE ES 0 O NULL, USAMOS EL MONTO DEL PEDIDO
        COALESCE(NULLIF(ct.monto, 0), p.monto, 0) AS monto, 
        -- PRIORIZAMOS EL MÉTODO DEL PEDIDO SI EL DEL COMPROBANTE NO ES CLARO
        COALESCE(ct.metodo_pago, p.metodo_pago, 'transferencia') AS metodo_pago,
        ct.comprobante_path,
        ct.pedido_id,
        ct.validado,
        ct.banco_origen,
        ct.nro_operacion,
        z.nombre AS zona_nombre,
        pe.cliente,
        pe.telefono
      FROM comprobantes_transferencia ct
      LEFT JOIN pedidos p           ON p.id = ct.pedido_id
      LEFT JOIN puntos_entrega pe   ON pe.id = p.punto_entrega_id
      LEFT JOIN zonas_geograficas z ON z.id = ct.zona_id
      WHERE 1=1
    `;

    const params = [];
    let idx = 1;

    // Filtros de seguridad y empresa
    if (!esSuper) {
      sql += ` AND ct.empresa_id = $${idx++}`;
      params.push(myEmpresa);
    } else if (empresa_id) {
      sql += ` AND ct.empresa_id = $${idx++}`;
      params.push(Number(empresa_id));
    }

    if (fecha) {
      sql += ` AND ct.fecha >= $${idx}::date AND ct.fecha < ($${idx}::date + INTERVAL '1 day')`;
      params.push(fecha);
    }

    sql += ` ORDER BY ct.fecha DESC, ct.id DESC`;

    const rows = await query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Error listando transferencias' });
  }
});

// SUBIR COMPROBANTE DE TRANSFERENCIA
app.post(
  '/api/transferencias/upload',
  withAuth,
  transferUploader.single('comprobante'), // campo "comprobante"
  async (req, res) => {
    try {
      const body = req.body || {};
      const pedidoId = Number(body.pedido_id);
      if (!Number.isFinite(pedidoId)) {
        return res.status(400).json({ error: 'pedido_id inválido' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'archivo requerido' });
      }

      const esSuper   = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);
      const choferToken = req.user?.chofer_id ? Number(req.user.chofer_id) : null;

      // Traer pedido + datos del cliente
      const pedRows = await query(`
        SELECT
          p.id,
          p.empresa_id,
          p.chofer_id,
          p.monto,
          p.metodo_pago,
          p.fecha,
          p.zona_id,
          pe.cliente,
          pe.telefono
        FROM pedidos p
        LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        WHERE p.id = $1
      `, [pedidoId]);

      if (!pedRows.length) {
        return res.status(404).json({ error: 'pedido no encontrado' });
      }

      const ped = pedRows[0];

      // Seguridad: empresa
      if (!esSuper) {
        if (!myEmpresa || Number(ped.empresa_id) !== Number(myEmpresa)) {
          return res.status(403).json({ error: 'No autorizado para este pedido' });
        }
      }

      // Determinar chofer para el registro
      let choferId = ped.chofer_id || choferToken;
      if (!choferId) {
        return res.status(400).json({ error: 'Sin chofer asociado al pedido' });
      }

      const filename        = req.file.filename;
      const archivoPath     = filename;                         // solo nombre
      const comprobantePath = `/Transferencia/${filename}`;     // URL pública usada por el front

      const metodo = (ped.metodo_pago || 'transferencia').toString().toLowerCase();
      const monto  = Number(ped.monto || 0) || 0;

      const rows = await query(`
        INSERT INTO comprobantes_transferencia (
          empresa_id,
          chofer_id,
          fecha,
          monto,
          metodo_pago,
          comentario,
          archivo_path,
          pedido_id,
          zona_id,
          comprobante_path,
          created_at,
          updated_at,
          validado
        )
        VALUES (
          $1, $2, NOW(), $3, $4, $5,
          $6, $7, $8, $9,
          NOW(), NOW(), 0
        )
        RETURNING
          id               AS transferencia_id,
          id,
          fecha,
          monto,
          metodo_pago,
          comprobante_path,
          pedido_id,
          zona_id,
          chofer_id,
          validado
      `, [
        ped.empresa_id,
        choferId,
        monto,
        metodo,
        body.comentario || null,
        archivoPath,
        pedidoId,
        ped.zona_id || null,
        comprobantePath
      ]);

      // Devolvemos la fila recién creada, compatible con trNormalize()
      res.json(rows[0]);
    } catch (e) {
      console.error('Error subiendo comprobante de transferencia:', e);
      res.status(500).json({ error: 'Error subiendo comprobante' });
    }
  }
);

// MARCAR TRANSFERENCIA COMO VERIFICADA (+ opcional WhatsApp)
app.post('/api/transferencias/:id/verificar', withAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'id inválido' });
    }

    const esSuper     = isSuper(req);
    const myEmpresa   = getEmpresaIdFromToken(req);
    const enviarAviso = String(req.query.enviarAviso || '').trim() === '1';

    // Traemos el comprobante + pedido + cliente
    const rows = await query(`
      SELECT
        ct.*,
        p.monto        AS pedido_monto,
        p.metodo_pago  AS pedido_metodo,
        p.fecha        AS pedido_fecha,
        p.id           AS pedido_id,
        pe.cliente,
        pe.telefono
      FROM comprobantes_transferencia ct
      LEFT JOIN pedidos p         ON p.id = ct.pedido_id
      LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      WHERE ct.id = $1
        AND ($2::int IS NULL OR ct.empresa_id = $2)
      LIMIT 1
    `, [id, esSuper ? null : Number(myEmpresa)]);

    if (!rows.length) {
      return res.status(404).json({ error: 'transferencia no encontrada' });
    }

    const ct = rows[0];

    // Nota: la seguridad por empresa se hace en SQL (WHERE ... empresa_id)

    // 1) Marcar como validado en comprobantes_transferencia
    await query(
      `UPDATE comprobantes_transferencia
       SET validado = 1,
           updated_at = NOW()
       WHERE id = $1
         AND ($2::int IS NULL OR empresa_id = $2)`,
      [id, esSuper ? null : Number(myEmpresa)]
    );

    // 2) Insertar consolidado en tabla transferencias (si no existe)

    // Monto y método
    const monto = Number(ct.monto ?? ct.pedido_monto ?? 0) || 0;
    let metodo  = (ct.metodo_pago || ct.pedido_metodo || 'transferencia').toString().toLowerCase();
    // La tabla transferencias solo acepta 'efectivo' o 'transferencia'
    if (metodo !== 'efectivo') metodo = 'transferencia';

    // Fecha de la transferencia
    const fecha = (ct.fecha || ct.pedido_fecha || new Date().toISOString());

    // Evitar duplicados básicos: mismo pedido, chofer, empresa, método
    let existe = [];
    if (ct.pedido_id) {
      existe = await query(`
        SELECT id
        FROM transferencias
        WHERE empresa_id = $1
          AND chofer_id  = $2
          AND pedido_id  = $3
          AND metodo_pago = $4
          AND ABS(monto - $5) < 0.01
        LIMIT 1
      `, [
        ct.empresa_id,
        ct.chofer_id,
        ct.pedido_id,
        metodo,
        monto
      ]);
    }

    if (!existe.length) {
      await query(`
        INSERT INTO transferencias (
          empresa_id,
          chofer_id,
          fecha,
          monto,
          metodo_pago,
          referencia,
          comprobante_path,
          pedido_id,
          notas
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9
        )
      `, [
        ct.empresa_id,
        ct.chofer_id,
        fecha,
        monto,
        metodo,
        ct.pedido_id
          ? `Transferencia verificada pedido #${ct.pedido_id}`
          : 'Transferencia verificada',
        ct.comprobante_path || null,
        ct.pedido_id || null,
        `Origen comprobantes_transferencia.id=${ct.id}`
      ]);
    }

    // 3) Opcional: aviso por WhatsApp al cliente
    if (enviarAviso && ct.telefono && typeof enqueueWppMessage === 'function') {
      try {
        const digits = String(ct.telefono).replace(/\D+/g, '');
        if (digits) {
          const fmt = new Intl.NumberFormat('es-AR', {
            style: 'currency',
            currency: 'ARS',
            minimumFractionDigits: 2
          }).format(monto || 0);

          const mensaje = (
            `¡Hola ${ct.cliente || ''}!\n` +
            `✅ Registramos tu pago por transferencia de ${fmt} ` +
            `${ct.pedido_id ? `para el pedido #${ct.pedido_id}.` : ''}\n` +
            `🙏 ¡Muchas gracias!`
          ).trim();

          await enqueueWppMessage({ phone: digits, message: mensaje });
        }
      } catch (werr) {
        console.error('Error en enqueue WPP transferencia:', werr);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Error verificando transferencia:', e);
    res.status(500).json({ error: 'Error verificando transferencia' });
  }
});

// ELIMINAR TRANSFERENCIA INDIVIDUAL (Para corregir errores o borrar huérfanos)
app.delete('/api/transferencias/:id', withAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    const esSuper = isSuper(req);
    const myEmpresa = getEmpresaIdFromToken(req);

    // 1. Verificar existencia y permisos
    const rows = await query(
      'SELECT id, empresa_id, archivo_path FROM comprobantes_transferencia WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2)',
      [id, esSuper ? null : Number(myEmpresa)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Comprobante no encontrado' });
    
    const comp = rows[0];

    // Nota: permisos ya filtrados en SQL (WHERE ... empresa_id)

    // 2. Eliminar archivo físico (Opcional, para no dejar basura)
    if (comp.archivo_path) {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const fullPath = path.join(__dirname, 'Transferencia', comp.archivo_path);
      if (fs.existsSync(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch(e) { console.error('Error borrando archivo físico:', e); }
      }
    }

    // 3. Eliminar registro de la DB
    await query(
      'DELETE FROM comprobantes_transferencia WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2)',
      [id, esSuper ? null : Number(myEmpresa)]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('Error eliminando transferencia:', e);
    res.status(500).json({ error: 'Error interno al eliminar' });
  }
});

// --------------------------------------------------
// Upload de gastos
// --------------------------------------------------

const gastosUploader = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, GASTOS_DIR),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname || '') || '.bin';
      cb(null, `gasto-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /image|pdf/.test(file.mimetype);
    cb(ok ? null : new Error('Tipo no permitido'), ok);
  }
});

// --------------------------------------------------
// GASTOS (CRUD + Archivos)
// --------------------------------------------------

// Listar gastos de repartidor
app.get('/api/gastos', withAuth, checkLicencia, async (req, res) => {
  try {
    const { from, to, chofer_id, empresa_id } = req.query || {};
    const esSuper    = isSuper(req);
    const myEmpresa  = getEmpresaIdFromToken(req);

    let sql = `
      SELECT 
        g.*,
        c.nombre AS chofer_nombre
      FROM gastos_repartidor g
      LEFT JOIN choferes c ON g.chofer_id = c.id
      WHERE 1=1
    `;

    const params = [];
    let idx = 1;

    // Seguridad por empresa
    if (!esSuper) {
      sql += ` AND g.empresa_id = $${idx++}`;
      params.push(myEmpresa);
    } else if (empresa_id) {
      sql += ` AND g.empresa_id = $${idx++}`;
      params.push(Number(empresa_id));
    }

    // Filtro por chofer
    if (chofer_id) {
      sql += ` AND g.chofer_id = $${idx++}`;
      params.push(Number(chofer_id));
    }

    // g.fecha es DATE → comparamos directo, sin funciones sobre la columna
    if (from) {
      sql += ` AND g.fecha >= $${idx++}::date`;
      params.push(from.toString().slice(0, 10));
    }
    if (to) {
      sql += ` AND g.fecha <= $${idx++}::date`;
      params.push(to.toString().slice(0, 10));
    }

    sql += ` ORDER BY g.fecha DESC, g.id DESC LIMIT 200`;

    const rows = await query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('Error cargando gastos:', e);
    res.status(500).json({ error: 'Error cargando gastos' });
  }
});

app.post('/api/gastos', withAuth, gastosUploader.single('comprobante'), async (req, res) => {
  try {
    const { 
      fecha, tipo, descripcion, cantidad, producto_id, monto, 
      empresa_id, chofer_id 
    } = req.body;
    
    const file = req.file;
    const esSuper = isSuper(req);

    // 1. Determinar Empresa y Chofer
    const targetEmpresa = (esSuper && empresa_id) ? empresa_id : getEmpresaIdFromToken(req);
    let targetChofer = chofer_id;
    if (!targetChofer && req.user.chofer_id) targetChofer = req.user.chofer_id;

    if (!targetEmpresa || !targetChofer) {
      return res.status(400).json({ error: 'Faltan datos de empresa o chofer' });
    }

    // 2. Insertar GASTO (Tabla contable)
    await query(
      `INSERT INTO gastos_repartidor (
          empresa_id, chofer_id, fecha, tipo, descripcion, 
          monto, comprobante_path, cantidad, producto_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        targetEmpresa, targetChofer, fecha || new Date().toISOString(), 
        tipo, descripcion, monto || 0, file ? file.filename : null,
        cantidad ? Number(cantidad) : null, producto_id ? Number(producto_id) : null
      ]
    );

    // ===============================================================
    // 3. SINCRONIZACIÓN AUTOMÁTICA DE STOCK (EL ESLABÓN PERDIDO)
    // ===============================================================
    // Si el chofer carga mercadería, impactamos su stock físico.
    if (producto_id && cantidad && (tipo === 'carga_llenos' || tipo === 'compra_mercaderia')) {
        const qtyNum = Number(cantidad);
        
        // A. Registrar Movimiento (Kardex) - Esto es lo que lee el reporte "Cargado"
        // CORRECCIÓN: 'notas' -> 'referencia' para coincidir con initDb.sql
        await query(`
            INSERT INTO chofer_stock_mov 
            (empresa_id, chofer_id, producto_id, fecha, tipo, cantidad, referencia, created_at)
            VALUES ($1, $2, $3, $4, 'INGRESO_GASTOS', $5, $6, NOW())
        `, [
            targetEmpresa, 
            targetChofer, 
            producto_id, 
            fecha || new Date().toISOString(), 
            qtyNum, 
            `Carga desde Gastos: ${descripcion || tipo}`
        ]);

        // B. Sumar al Stock Actual (Inventario en mano)
        await query(`
            INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (empresa_id, chofer_id, producto_id)
            DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
        `, [targetEmpresa, targetChofer, producto_id, qtyNum]);
    }

    res.json({ ok: true });
  } catch (e) { 
    console.error('ERROR POST GASTOS:', e); 
    res.status(500).json({ error: 'Error guardando gasto' }); 
  }
});

app.put('/api/gastos/:id', withAuth, gastosUploader.single('comprobante'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });

    const role = (req.user?.role || '').toLowerCase();
    const esSuper = isSuper(req);
    const esUserRole = role === 'user';

    // Solo Super y User pueden editar (según tu pedido)
    if (!(esSuper || esUserRole)) return res.status(403).json({ error: 'No autorizado' });

    // Traer gasto actual
    const rows0 = await query(
      `SELECT id, empresa_id, chofer_id, fecha, tipo, descripcion, monto, comprobante_path, cantidad, producto_id
       FROM gastos_repartidor
       WHERE id = $1
       LIMIT 1`,
      [id]
    );

    if (!rows0.length) return res.status(404).json({ error: 'Gasto no encontrado' });

    const g0 = rows0[0];

    // Si no es super, solo puede editar dentro de su empresa
    const myEmpresa = getEmpresaIdFromToken(req);
    if (!esSuper && Number(g0.empresa_id) !== Number(myEmpresa)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const {
      fecha,
      tipo,
      descripcion,
      monto,
      empresa_id,
      chofer_id,
      cantidad,
      producto_id
    } = req.body || {};

    // Si es super puede cambiar empresa, si no, se mantiene
    const targetEmpresa = (esSuper && empresa_id) ? Number(empresa_id) : Number(g0.empresa_id);

    // Super/User pueden cambiar chofer (si lo mandan), si no, se mantiene
    const targetChofer = (chofer_id ? Number(chofer_id) : Number(g0.chofer_id));

    // fecha viene de <input datetime-local> -> "YYYY-MM-DDTHH:MM"
    // la columna es DATE, así que recortamos a YYYY-MM-DD
    const fechaDate = (fecha ? String(fecha).slice(0, 10) : String(g0.fecha).slice(0, 10));

    const newTipo = tipo || g0.tipo;
    const newDesc = (descripcion !== undefined) ? descripcion : g0.descripcion;

    const newMonto = (monto !== undefined && monto !== null && monto !== '')
      ? Number(monto)
      : Number(g0.monto || 0);

    const newCantidad = (cantidad === undefined || cantidad === null || cantidad === '')
      ? null
      : Number(cantidad);

    const newProductoId = (producto_id === undefined || producto_id === null || producto_id === '')
      ? null
      : Number(producto_id);

    const newComprobantePath = req.file ? req.file.filename : g0.comprobante_path;

    await query(
      `UPDATE gastos_repartidor
       SET empresa_id = $1,
           chofer_id = $2,
           fecha = $3::date,
           tipo = $4,
           descripcion = $5,
           monto = $6,
           comprobante_path = $7,
           cantidad = $8,
           producto_id = $9
       WHERE id = $10`,
      [
        targetEmpresa,
        targetChofer,
        fechaDate,
        newTipo,
        newDesc,
        newMonto,
        newComprobantePath,
        newCantidad,
        newProductoId,
        id
      ]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('ERROR PUT GASTOS:', e);
    res.status(500).json({ error: 'Error actualizando gasto' });
  }
});

app.delete('/api/gastos/:id', withAuth, async (req, res) => {
  try {
    await query(`DELETE FROM gastos_repartidor WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error borrando gasto' }); }
});

// --------------------------------------------------
// AUTH (login + /me)
// --------------------------------------------------

app.get('/api/me', (req, res) => {
  try {
    let token = null;
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) token = h.slice(7);
    if (!token && req.cookies?.token) token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'No token' });

    const user = jwt.verify(token, process.env.JWT_SECRET || 'dev');
    res.json({ user });
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });

    // 1. Traemos también los datos de la empresa para verificar el plan
    const rows = await query(
      `SELECT u.id, u.username, u.password, u.role, u.empresa_id, u.chofer_id,
              e.plan_estado, e.plan_vencimiento
       FROM usuarios u
       LEFT JOIN empresas e ON u.empresa_id = e.id
       WHERE u.username = $1 LIMIT 1`,
      [username]
    );

    if (!rows.length) return res.status(401).json({ error: 'Credenciales inválidas' });
    const user = rows[0];

    // --- NUEVA VALIDACIÓN DE LICENCIA ---
    // Si no es Super Admin y la empresa está vencida, bloqueamos
    if (user.role !== 'super' && user.plan_estado === 'expired') {
       return res.status(402).json({ 
         error: '⛔ Tu licencia ha vencido. Realiza el pago para reactivar el servicio.' 
       });
    }
    // ------------------------------------

    const match = await bcrypt.compare(String(password), String(user.password));
    if (!match) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign({
      uid: user.id, username: user.username, empresa_id: user.empresa_id,
      role: user.role, chofer_id: user.chofer_id ?? null
    }, process.env.JWT_SECRET || 'dev', { expiresIn: '8h' });
    
    res.cookie('token', token, {
      httpOnly: true, sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({ token });
  } catch (e) {
    console.error('LOGIN ERROR:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

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
// EMPRESAS (CRUD Completo)
// --------------------------------------------------

app.get('/api/empresas', withAuth, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    const filtroEmpresaId = Number(req.query.empresa_id) || null;
    let rows;
    if (esSuper) {
      if (filtroEmpresaId) {
        rows = await query(`SELECT * FROM empresas WHERE id=$1 ORDER BY id`, [filtroEmpresaId]);
      } else {
        rows = await query(`SELECT * FROM empresas ORDER BY id`);
      }
    } else {
      rows = await query(`SELECT * FROM empresas WHERE id=$1 ORDER BY id`, [getEmpresaIdFromToken(req)]);
    }
    res.json(rows || []);
  } catch (e) {
    console.error('EMPRESAS ERROR:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Crear Empresa (POST) - ACTUALIZADO CON TODOS LOS CAMPOS
app.post('/api/empresas', withAuth, async (req, res) => {
  // Solo el superadmin puede crear empresas
  if (!isSuper(req)) {
    return res.status(403).json({ error: 'Solo superadmin' });
  }

  const {
    // Datos Generales
    nombre,
    telefono,
    email,
    rubro,
    etiquetas,

    // Datos Fiscales
    razon_social,
    cuit,
    condicion_iva,
    direccion,
    ciudad,
    provincia,
    pais,

    // Configuración Web
    landing_domain,
    landing_slug,

    // Inteligencia Artificial
    prompt_ia_vendedor,
    prompt_ia_general,

    // Configuraciones JSON
    config_entrega,
    modulos,
    config_operativa,
    config_logistica,
    config_activos,
    config_integraciones,

    // Licencia (Zona Super Admin)
    plan_estado,
    plan_tipo,
    plan_vencimiento,
    plan_precio
  } = req.body;

  if (!nombre) {
    return res.status(400).json({ error: 'Nombre requerido' });
  }

  try {
    const rows = await query(
      `
      INSERT INTO empresas (
        nombre,
        telefono,
        email,

        razon_social,
        cuit,
        condicion_iva,
        direccion,
        ciudad,
        provincia,
        pais,

        rubro,
        etiquetas,

        landing_domain,
        landing_slug,

        prompt_ia_vendedor,
        prompt_ia_general,

        config_entrega,
        modulos,
        config_operativa,
        config_logistica,
        config_activos,
        config_integraciones,

        plan_estado,
        plan_tipo,
        plan_vencimiento,
        plan_precio
      )
      VALUES (
        $1,  $2,  $3,
        $4,  $5,  $6,  $7,  $8,  $9,  $10,
        $11, $12,
        $13, $14,
        $15, $16,
        $17, $18, $19, $20, $21, $22,
        $23, $24, $25, $26
      )
      RETURNING *
      `,
      [
        // Datos Generales
        nombre,
        telefono || null,
        email || null,

        // Datos Fiscales
        razon_social || null,
        cuit || null,
        condicion_iva || null,
        direccion || null,
        ciudad || null,
        provincia || null,
        pais || 'Argentina',

        // Negocio / IA contexto
        rubro || null,
        etiquetas || null,

        // Web
        landing_domain || null,
        landing_slug || null,

        // IA
        prompt_ia_vendedor || null,
        prompt_ia_general || null,

        // JSONs
        config_entrega        ? JSON.stringify(config_entrega)        : JSON.stringify({}),
        modulos               ? JSON.stringify(modulos)               : JSON.stringify({}),
        config_operativa      ? JSON.stringify(config_operativa)      : JSON.stringify({}),
        config_logistica      ? JSON.stringify(config_logistica)      : JSON.stringify({}),
        config_activos        ? JSON.stringify(config_activos)        : JSON.stringify({}),
        config_integraciones  ? JSON.stringify(config_integraciones)  : JSON.stringify({}),

        // Licencia
        plan_estado || null,
        plan_tipo || null,
        plan_vencimiento || null,
        plan_precio || null
      ]
    );

    // query(...) devuelve array, no { rows }
    res.json(rows[0]);

  } catch (e) {
    console.error('❌ [ERROR POST EMPRESA]:', e);
    if (e.code === '23505') {
      return res.status(400).json({ error: 'El dominio o slug ya está en uso por otra empresa.' });
    }
    res.status(500).json({ error: 'Error interno al crear la empresa.' });
  }
});

app.put('/api/empresas/:id', withAuth, async (req, res) => {
  if (!isSuper(req)) {
    return res.status(403).json({ error: 'Solo superadmin' });
  }

  const { id } = req.params;

  const {
    // Datos Generales
    nombre,
    telefono,
    email,
    rubro,
    etiquetas,

    // Datos Fiscales
    razon_social,
    cuit,
    condicion_iva,
    direccion,
    ciudad,
    provincia,
    pais,

    // Configuración Web
    landing_domain,
    landing_slug,

    // Inteligencia Artificial
    prompt_ia_vendedor,
    prompt_ia_general,

    // Configuraciones JSON
    config_entrega,
    modulos,
    config_operativa,
    config_logistica,
    config_activos,
    config_integraciones,

    // Licencia (Zona Super Admin)
    plan_estado,
    plan_tipo,
    plan_vencimiento,
    plan_precio,
  } = req.body;

  try {
    const rows = await query(
      `
      UPDATE empresas
      SET
        nombre      = COALESCE($1,  nombre),
        telefono    = COALESCE($2,  telefono),
        email       = COALESCE($3,  email),

        razon_social = COALESCE($4,  razon_social),
        cuit         = COALESCE($5,  cuit),
        condicion_iva= COALESCE($6,  condicion_iva),
        direccion    = COALESCE($7,  direccion),
        ciudad       = COALESCE($8,  ciudad),
        provincia    = COALESCE($9,  provincia),
        pais         = COALESCE($10, pais),

        rubro        = COALESCE($11, rubro),
        etiquetas    = COALESCE($12, etiquetas),

        landing_domain = COALESCE($13, landing_domain),
        landing_slug   = COALESCE($14, landing_slug),

        prompt_ia_vendedor = COALESCE($15, prompt_ia_vendedor),
        prompt_ia_general  = COALESCE($16, prompt_ia_general),

        config_entrega       = COALESCE($17, config_entrega),
        modulos              = COALESCE($18, modulos),
        config_operativa     = COALESCE($19, config_operativa),
        config_logistica     = COALESCE($20, config_logistica),
        config_activos       = COALESCE($21, config_activos),
        config_integraciones = COALESCE($22, config_integraciones),

        plan_estado      = COALESCE($23, plan_estado),
        plan_tipo        = COALESCE($24, plan_tipo),
        plan_vencimiento = COALESCE($25, plan_vencimiento),
        plan_precio      = COALESCE($26, plan_precio)
      WHERE id = $27
      RETURNING *
      `,
      [
        // Generales
        nombre || null,
        telefono || null,
        email || null,

        // Fiscales
        razon_social || null,
        cuit || null,
        condicion_iva || null,
        direccion || null,
        ciudad || null,
        provincia || null,
        pais || null,

        // Negocio
        rubro || null,
        etiquetas || null,

        // Web
        landing_domain || null,
        landing_slug || null,

        // IA
        prompt_ia_vendedor || null,
        prompt_ia_general || null,

        // JSONB (si no se manda, va null y COALESCE deja el valor anterior)
        config_entrega       ? JSON.stringify(config_entrega)       : null,
        modulos              ? JSON.stringify(modulos)              : null,
        config_operativa     ? JSON.stringify(config_operativa)     : null,
        config_logistica     ? JSON.stringify(config_logistica)     : null,
        config_activos       ? JSON.stringify(config_activos)       : null,
        config_integraciones ? JSON.stringify(config_integraciones) : null,

        // Licencia
        plan_estado || null,
        plan_tipo || null,
        plan_vencimiento || null,
        plan_precio || null,

        // WHERE
        id
      ]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error('❌ [ERROR PUT EMPRESA]:', e);
    if (e.code === '23505') {
      return res.status(400).json({ error: 'El dominio o slug ya está en uso por otra empresa.' });
    }
    res.status(500).json({ error: 'Error interno al actualizar la empresa.' });
  }
});

app.delete('/api/empresas/:id', withAuth, async (req, res) => {
  if (!isSuper(req)) return res.status(403).json({ error: 'Solo superadmin' });
  try {
    await query(`DELETE FROM empresas WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando (tiene datos asociados)' });
  }
});

app.get('/api/empresas/:id', withAuth, getEmpresaById);

// --------------------------------------------------
// CUENTAS BANCARIAS DE EMPRESA (Multi-cuentas)
// --------------------------------------------------

// 1. Obtener todas las cuentas de una empresa
app.get('/api/empresas/:id/cuentas', withAuth, async (req, res) => {
  try {
    const empresaId = Number(req.params.id);
    const esSuper = isSuper(req);
    const myEmpresa = getEmpresaIdFromToken(req);

    // Seguridad: Si no es super, solo puede ver sus propias cuentas
    if (!esSuper && empresaId !== myEmpresa) {
        return res.status(403).json({ error: 'No autorizado' });
    }

    // Ordenamos por ID descendente para ver las últimas primero
    const rows = await query(
      `SELECT * FROM empresa_cuentas_bancarias WHERE empresa_id = $1 ORDER BY id DESC`,
      [empresaId]
    );
    res.json(rows);
  } catch (e) {
    console.error('ERROR GET CUENTAS:', e);
    res.status(500).json({ error: 'Error obteniendo cuentas' });
  }
});

// 2. Obtener historial de pagos de una empresa
app.get('/api/empresas/:id/pagos', withAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Seguridad: Solo el dueño o Super Admin pueden ver
    if (req.user.role !== 'super' && req.user.empresa_id != id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const rows = await query(
      'SELECT * FROM historial_pagos WHERE empresa_id = $1 ORDER BY fecha DESC LIMIT 50',
      [id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener pagos' });
  }
});

// 3. Agregar cuenta a empresa
app.post('/api/empresas/:id/cuentas', withAuth, async (req, res) => {
  try {
    const empresaId = Number(req.params.id);
    const { banco, alias, cbu, titular } = req.body; // Campos extendidos
    const esSuper = isSuper(req);
    const myEmpresa = getEmpresaIdFromToken(req);

    if (!esSuper && empresaId !== myEmpresa) {
        return res.status(403).json({ error: 'No autorizado' });
    }
    
    // Validamos que haya al menos algo útil
    if (!banco && !alias && !cbu) return res.status(400).json({ error: 'Faltan datos de la cuenta' });

    await query(
      `INSERT INTO empresa_cuentas_bancarias 
        (empresa_id, banco, alias, cbu, titular) 
       VALUES ($1, $2, $3, $4, $5)`,
      [empresaId, banco, alias || null, cbu || null, titular || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('ERROR ADD CUENTA:', e);
    // Manejo de duplicados (UNIQUE constraint en tabla)
    if (e.message && e.message.includes('unique')) {
      return res.status(400).json({ error: 'Ya existe una cuenta con ese Alias o CBU' });
    }
    res.status(500).json({ error: 'Error agregando cuenta' });
  }
});

// 4. Borrar cuenta
app.delete('/api/empresas/cuentas/:id', withAuth, async (req, res) => {
  try {
    const cuentaId = Number(req.params.id);
    const esSuper = isSuper(req);
    const myEmpresa = getEmpresaIdFromToken(req);

    // Verificamos propiedad de la cuenta antes de borrar
    const check = await query('SELECT empresa_id FROM empresa_cuentas_bancarias WHERE id=$1', [cuentaId]);
    if (!check.length) return res.status(404).json({ error: 'Cuenta no encontrada' });

    if (!esSuper && check[0].empresa_id !== myEmpresa) {
        return res.status(403).json({ error: 'No autorizado' });
    }

    await query('DELETE FROM empresa_cuentas_bancarias WHERE id = $1', [cuentaId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('ERROR DEL CUENTA:', e);
    res.status(500).json({ error: 'Error eliminando cuenta' });
  }
});

// 5. Subir/actualizar landing HTML de una empresa
app.post('/api/empresas/:id/landing-page', withAuth, pagesUploader.single('file'),
  async (req, res) => {
    try {
      const requestedId = Number(req.params.id);
      if (!Number.isFinite(requestedId) || requestedId <= 0) {
        return res.status(400).json({ error: 'empresa_id inválido' });
      }

      // Empresa del usuario autenticado (o la que elija si es super)
      const authEmpresaId = resolveEmpresaId(req);

      // Solo súper admin puede subir para otra empresa
      if (!isSuper(req) && authEmpresaId !== requestedId) {
        return res.status(403).json({ error: 'No podés modificar esta empresa' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Falta archivo .html' });
      }

      // --- CORRECCIÓN AQUÍ: Quitamos las llaves { } ---
      const rows = await query(
        'SELECT landing_slug FROM empresas WHERE id = $1 LIMIT 1',
        [requestedId]
      );

      if (!rows || !rows.length) {
        return res.status(404).json({ error: 'Empresa no encontrada' });
      }

      // HTML subido
      const html = req.file.buffer.toString('utf8');

      // Nos aseguramos que la carpeta pages exista
      if (!fs.existsSync(PAGES_DIR)) {
        await fs.promises.mkdir(PAGES_DIR, { recursive: true });
      }

      // Guardamos SIEMPRE con el ID interno (empresa_X.html)
      const filePath = getEmpresaLandingPath(requestedId);
      
      await fs.promises.writeFile(filePath, html, 'utf8');

      console.log('Landing actualizada:', filePath);

      return res.json({
        ok: true,
        slug: rows[0].landing_slug || '(sin slug)', 
        path: `/pages/empresa_${requestedId}.html` // Devolvemos ruta técnica o url pública si prefieres
      });
    } catch (err) {
      console.error('Error subiendo landing html:', err);
      return res.status(500).json({ error: 'Error guardando página' });
    }
  }
);

// 5. Borrar landing HTML de una empresa
app.delete('/api/empresas/:id/landing-page', withAuth, async (req, res) => {
  try {
    const requestedId = Number(req.params.id);
    if (!Number.isFinite(requestedId) || requestedId <= 0) {
      return res.status(400).json({ error: 'empresa_id inválido' });
    }

    const authEmpresaId = resolveEmpresaId(req);
    if (!isSuper(req) && authEmpresaId !== requestedId) {
      return res.status(403).json({ error: 'No podés modificar esta empresa' });
    }

    const filePath = getEmpresaLandingPath(requestedId);

    try {
      await fs.promises.unlink(filePath);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('Error eliminando landing:', e);
        return res.status(500).json({ error: 'Error eliminando página' });
      }
      // Si no existía, igual devolvemos ok
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error en delete landing html:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// --------------------------------------------------
// CONFIGURACIÓN DE ENTREGA POR EMPRESA
// --------------------------------------------------

app.get('/api/entrega/config', withAuth, async (req, res) => {
  try {
    // Igual que marketing: respeta empresa del token o parámetro si sos super
    const empresaId = resolveEmpresaId(req);

    const rows = await query(
      'SELECT config_entrega FROM empresas WHERE id=$1',
      [empresaId]
    );

    res.json(rows[0]?.config_entrega || {});
  } catch (e) {
    console.error('ENTREGA CONFIG GET ERROR', e);
    res.status(500).json({ error: 'Error leyendo configuración de entrega' });
  }
});

app.put('/api/entrega/config', withAuth, async (req, res) => {
  try {
    const empresaId = resolveEmpresaId(req);
    const nuevaConfig = req.body || {};

    // Si viene empresa_id para el helper, lo sacamos del JSON a guardar
    delete nuevaConfig.empresa_id;

    await query(
      'UPDATE empresas SET config_entrega = $1 WHERE id = $2',
      [JSON.stringify(nuevaConfig), empresaId]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('ENTREGA CONFIG PUT ERROR', e);
    res.status(500).json({ error: 'Error guardando configuración de entrega' });
  }
});

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

app.get('/api/zonas', withAuth, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    const empresaTarget = esSuper ? (Number(req.query.empresa_id) || null) : getEmpresaIdFromToken(req);
    
    // Si soy super y no elegí empresa, devuelvo array vacío (o todas, según prefieras)
    if (esSuper && !empresaTarget) return res.json([]);

    // NOTA: Solo seleccionamos 'poligono' (JSON texto) para el frontend.
    // No necesitamos traer 'geom' (binario) aquí a menos que quieras convertirlo.
    let sql = `SELECT id, empresa_id, nombre, poligono FROM zonas_geograficas`;
    const params = [];
    
    if (empresaTarget) {
      sql += ` WHERE empresa_id = $1`;
      params.push(empresaTarget);
    }
    sql += ` ORDER BY id ASC`;
    
    const rows = await query(sql, params);
    
    // Parseo seguro del polígono para el frontend
    const ret = rows.map(r => {
      try { 
        r.poligono = typeof r.poligono === 'string' ? JSON.parse(r.poligono) : r.poligono; 
      } catch (err) {
        r.poligono = [];
      }
      return r;
    });
    res.json(ret);
  } catch (e) { 
    console.error(e);
    res.status(500).json({ error: 'Error obteniendo zonas' }); 
  }
});

app.post('/api/zonas', withAuth, async (req, res) => {
  try {
    const { nombre, poligono, empresa_id } = req.body;
    const esSuper = isSuper(req);
    let finalEmpresaId = esSuper && empresa_id ? Number(empresa_id) : getEmpresaIdFromToken(req);

    if (!finalEmpresaId) return res.status(400).json({ error: 'Empresa requerida' });
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    if (!poligono || !Array.isArray(poligono) || poligono.length < 3) {
        return res.status(400).json({ error: 'Polígono inválido (mínimo 3 puntos)' });
    }

    // --- LÓGICA POSTGIS ---
    // 1. Cerrar el polígono si no lo está (Primer punto === Último punto)
    const pStart = poligono[0];
    const pEnd   = poligono[poligono.length - 1];
    
    // Validamos coordenadas numéricas antes de comparar
    if (Array.isArray(pStart) && Array.isArray(pEnd)) {
        if (pStart[0] !== pEnd[0] || pStart[1] !== pEnd[1]) {
            poligono.push(pStart); // Cerramos el loop
        }
    }

    // 2. Preparar el JSON string para la columna vieja (visualización frontend)
    const poliJson = JSON.stringify(poligono);
    
    // 3. Preparar el objeto GeoJSON para la columna nueva (PostGIS)
    const geoJsonObj = {
      type: 'Polygon',
      coordinates: [poligono], // PostGIS espera un array de anillos (el primero es el exterior)
      crs: { type: 'name', properties: { name: 'EPSG:4326' } }
    };

    // 4. Insertar en ambas columnas
    // Usamos ST_GeomFromGeoJSON para convertir el JSON al formato binario de PostGIS
    const rows = await query(
      `INSERT INTO zonas_geograficas (empresa_id, nombre, poligono, geom) 
       VALUES ($1, $2, $3, ST_GeomFromGeoJSON($4)) 
       RETURNING id`,
      [finalEmpresaId, nombre, poliJson, JSON.stringify(geoJsonObj)]
    );

    res.json(rows[0]);
  } catch (e) { 
    console.error(e);
    res.status(500).json({ error: 'Error creando zona' }); 
  }
});

app.put('/api/zonas/:id', withAuth, async (req, res) => {
  try {
    const { nombre, poligono } = req.body;
    const esSuper = isSuper(req);
    const miEmpresa = getEmpresaIdFromToken(req);
    
    // Validación de propiedad
    let where = 'WHERE id=$1';
    let params = [req.params.id];
    if (!esSuper) { where += ' AND empresa_id=$2'; params.push(miEmpresa); }

    const check = await query(`SELECT id FROM zonas_geograficas ${where}`, params);
    if (!check.length) return res.status(404).json({ error: 'Zona no encontrada o sin permiso' });

    const sets = [], vals = [];
    let idx = 1;
    
    if (nombre) { sets.push(`nombre=$${idx++}`); vals.push(nombre); }
    
    if (poligono) { 
        if (!Array.isArray(poligono) || poligono.length < 3) return res.status(400).json({error: 'Polígono inválido'});
        
        // --- LÓGICA POSTGIS ---
        // 1. Cerrar el polígono
        const pStart = poligono[0];
        const pEnd   = poligono[poligono.length - 1];
        if (Array.isArray(pStart) && Array.isArray(pEnd)) {
             if (pStart[0] !== pEnd[0] || pStart[1] !== pEnd[1]) {
                 poligono.push(pStart);
             }
        }

        // 2. Preparar JSONs
        const poliJson = JSON.stringify(poligono);
        const geoJsonObj = {
            type: 'Polygon',
            coordinates: [poligono],
            crs: { type: 'name', properties: { name: 'EPSG:4326' } }
        };

        // 3. Actualizar AMBAS columnas
        sets.push(`poligono=$${idx++}`); 
        vals.push(poliJson); 

        // Insertamos la función SQL directamente en el SET
        sets.push(`geom=ST_GeomFromGeoJSON($${idx++})`);
        vals.push(JSON.stringify(geoJsonObj));
    }
    
    if (sets.length === 0) return res.json({ ok: true });

    vals.push(req.params.id);
    await query(`UPDATE zonas_geograficas SET ${sets.join(', ')} WHERE id=$${idx}`, vals);
    
    res.json({ ok: true });
  } catch (e) { 
    console.error(e);
    res.status(500).json({ error: 'Error actualizando zona' }); 
  }
});

app.delete('/api/zonas/:id', withAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID de zona inválido' });

  const esSuper = isSuper(req);
  const empresaId = getEmpresaIdFromToken(req);

  try {
    // Por seguridad: si NO soy super y no tengo empresa, ni intento borrar
    if (!esSuper && !empresaId) {
      return res.status(400).json({ error: 'Empresa no encontrada en token' });
    }

    // 1) Limpio relaciones, por si en la DB la FK no tiene CASCADE/SET NULL
    await query('DELETE FROM zona_chofer WHERE zona_id = $1', [id]);
    await query('UPDATE puntos_entrega SET zona_id = NULL WHERE zona_id = $1', [id]);

    // 2) Borro la zona
    let sql = 'DELETE FROM zonas_geograficas WHERE id = $1';
    const params = [id];

    if (!esSuper) {
      sql += ' AND empresa_id = $2';
      params.push(empresaId);
    }

    const result = await query(sql, params);

    if (!result || result.rowCount === 0) {
      return res.status(404).json({ error: 'Zona no encontrada o no pertenece a tu empresa' });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('Error eliminando zona:', e);
    return res.status(500).json({
      error: e.detail || e.message || 'Error eliminando zona'
    });
  }
});

// --------------------------------------------------
// CHOFERES (CRUD)
// --------------------------------------------------

app.get('/api/choferes', withAuth, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    const empresaTarget = esSuper ? (Number(req.query.empresa_id) || null) : getEmpresaIdFromToken(req);
    if (!empresaTarget && !esSuper) return res.status(400).json({ error: 'Empresa requerida' });

    let sql = `SELECT id, nombre, telefono, email, tipo, sla_horas FROM choferes`;
    const params = [];
    if (empresaTarget) { sql += ` WHERE empresa_id=$1`; params.push(empresaTarget); }
    sql += ` ORDER BY nombre ASC`;

    const rows = await query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error obteniendo choferes' }); }
});

app.post('/api/choferes', withAuth, async (req, res) => {
  try {
    const { nombre, telefono, email, tipo, sla_horas, empresa_id } = req.body;
    const esSuper = isSuper(req);
    let finalEmpresaId = esSuper && empresa_id ? Number(empresa_id) : getEmpresaIdFromToken(req);

    const rows = await query(
      `INSERT INTO choferes (empresa_id, nombre, telefono, email, tipo, sla_horas)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [finalEmpresaId, nombre, telefono, email, tipo || 'propio', sla_horas]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Error creando chofer' }); }
});

app.put('/api/choferes/:id', withAuth, async (req, res) => {
  try {
    const { nombre, telefono, email, tipo, sla_horas } = req.body;
    // (Omitimos chequeo de empresa_id estricto por brevedad, idealmente validar ownership)
    await query(
      `UPDATE choferes SET nombre=$1, telefono=$2, email=$3, tipo=$4, sla_horas=$5 WHERE id=$6`,
      [nombre, telefono, email, tipo, sla_horas, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error actualizando chofer' }); }
});

app.delete('/api/choferes/:id', withAuth, async (req, res) => {
  try {
    await query(`DELETE FROM choferes WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error eliminando chofer' }); }
});

// --------------------------------------------------
// ASIGNACIONES (Tabla: zona_chofer)
// --------------------------------------------------

app.get('/api/zonas/choferes', withAuth, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    const empresaIdParam = Number(req.query.empresa_id) || null;
    const empresaId = esSuper ? empresaIdParam : getEmpresaIdFromToken(req);

    let sql = `
      SELECT z.id as zona_id, z.nombre as zona_nombre, zc.chofer_id
      FROM zonas_geograficas z
      JOIN zona_chofer zc ON z.id = zc.zona_id
    `;
    const params = [];
    if (empresaId) { 
      sql += ` WHERE z.empresa_id=$1`; 
      params.push(empresaId); 
    }
    
    const rows = await query(sql, params);
    const map = {};
    for (const r of rows) {
      if (!map[r.zona_id]) {
        map[r.zona_id] = { id: r.zona_id, nombre: r.zona_nombre, choferes: [] };
      }
      map[r.zona_id].choferes.push({ id: r.chofer_id });
    }
    res.json(Object.values(map));
  } catch (e) { 
    console.error('ERROR zonas/choferes', e);
    res.status(500).json({ error: 'Error obteniendo asignaciones' }); 
  }
});

app.post('/api/asignarChofer', withAuth, async (req, res) => {
  try {
    const { chofer_id, zona_id, empresa_id } = req.body || {};
    const choferIdNum = Number(chofer_id);
    const zonaIdNum = Number(zona_id);

    if (!Number.isInteger(choferIdNum) || !Number.isInteger(zonaIdNum)) {
      return res.status(400).json({ error: 'chofer_id y zona_id deben ser enteros' });
    }

    const esSuper = isSuper(req);
    let empresaId = esSuper && empresa_id ? Number(empresa_id) : getEmpresaIdFromToken(req);

    // 1) Validar zona y obtener empresa real de la zona
    const zonaRows = await query(
      'SELECT id, empresa_id FROM zonas_geograficas WHERE id = $1',
      [zonaIdNum]
    );
    if (!zonaRows.length) {
      return res.status(400).json({ error: 'Zona no encontrada' });
    }
    const empresaZonaId = zonaRows[0].empresa_id;

    // Si el token trae empresa, chequear coherencia (salvo super)
    if (!esSuper && empresaId && empresaId !== empresaZonaId) {
      return res.status(403).json({ error: 'Zona no pertenece a tu empresa' });
    }

    // Forzamos empresaId a la de la zona para que quede consistente
    empresaId = empresaZonaId;

    // 2) Validar chofer y coherencia de empresa
    const choferRows = await query(
      'SELECT id, empresa_id FROM choferes WHERE id = $1',
      [choferIdNum]
    );
    if (!choferRows.length) {
      return res.status(400).json({ error: 'Chofer no encontrado' });
    }
    const empresaChoferId = choferRows[0].empresa_id;

    if (empresaChoferId !== empresaId) {
      return res.status(400).json({ error: 'Chofer y zona pertenecen a empresas distintas' });
    }

    // 3) Insertar asignación
    await query(
      `INSERT INTO zona_chofer (empresa_id, zona_id, chofer_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (zona_id, chofer_id) DO NOTHING`,
      [empresaId, zonaIdNum, choferIdNum]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('ERROR ASIGNAR:', e);
    res.status(500).json({ error: 'Error asignando: ' + (e.message || e) });
  }
});

app.delete('/api/desasignarChofer', withAuth, async (req, res) => {
  try {
    const { chofer_id, zona_id } = req.body || {};
    const choferIdNum = Number(chofer_id);
    const zonaIdNum = Number(zona_id);

    if (!Number.isInteger(choferIdNum) || !Number.isInteger(zonaIdNum)) {
      return res.status(400).json({ error: 'chofer_id y zona_id deben ser enteros' });
    }

    await query(
      'DELETE FROM zona_chofer WHERE chofer_id=$1 AND zona_id=$2',
      [choferIdNum, zonaIdNum]
    );
    res.json({ ok: true });
  } catch (e) { 
    console.error('ERROR DESASIGNAR:', e);
    res.status(500).json({ error: 'Error desasignando' }); 
  }
});

// --------------------------------------------------
// PRODUCTOS (CRUD)
// --------------------------------------------------

// Listar Productos
app.get('/api/productos', withAuth, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    let empresaId = getEmpresaIdFromToken(req);
    if (esSuper && req.query.empresa_id) {
      empresaId = Number(req.query.empresa_id);
    }

    // Solo super: permite incluir borrados lógicos
    const includeDeleted = esSuper && String(req.query.include_deleted || '') === '1';

    if (!empresaId && !esSuper) {
      return res.status(400).json({ error: 'Falta empresa' });
    }

    const whereDeleted = includeDeleted ? '' : 'AND deleted_at IS NULL';

    const rows = await query(`
      SELECT 
        id, empresa_id,
        nombre, descripcion, precio, imagen, activo,
        sku, external_id,
        stock_min, stock_max,
        categoria, orden,
        etiqueta, imagen_promo, mostrar_en_catalogo, mostrar_en_landing,
        config_activo,
        created_at, updated_at, deleted_at
      FROM productos
      WHERE empresa_id = $1 ${whereDeleted}
      ORDER BY nombre ASC
    `, [empresaId]);

    res.json(rows);
  } catch (e) {
    console.error('PRODUCTOS ERROR:', e);
    res.status(500).json({ error: 'Error listando productos' });
  }
});

// Crear Producto (POST)
app.post('/api/productos', withAuth, async (req, res) => {
  try {
    const {
      nombre, descripcion, precio, imagen, empresa_id,
      stock_min, stock_max,
      categoria, orden,
      etiqueta, imagen_promo, mostrar_en_catalogo, mostrar_en_landing,
      sku, external_id,
      config_activo
    } = req.body;

    const esSuper = isSuper(req);
    const targetEmpresa = (esSuper && empresa_id) ? Number(empresa_id) : getEmpresaIdFromToken(req);

    if (!targetEmpresa) {
      return res.status(400).json({ error: 'Falta empresa.' });
    }

    const nombreOk = String(nombre || '').trim();
    if (!nombreOk) return res.status(400).json({ error: 'Falta nombre.' });

    const precioNum = Number(precio);
    if (!Number.isFinite(precioNum) || precioNum < 0) {
      return res.status(400).json({ error: 'Precio inválido.' });
    }

    const ordenNum = (orden === undefined || orden === null || orden === '')
      ? null
      : Number(orden);

    const skuNorm = (sku === undefined || sku === null) ? null : String(sku).trim().toUpperCase();
    const skuFinal = skuNorm && skuNorm.length ? skuNorm : null;

    const externalNorm = (external_id === undefined || external_id === null) ? null : String(external_id).trim();
    const externalFinal = externalNorm && externalNorm.length ? externalNorm : null;

    // Si no viene, guardamos NULL; si viene objeto, PG lo castea a JSONB
    const configActivo = (config_activo === undefined) ? null : config_activo;

    const uid = req.user?.uid ?? null;

    const rows = await query(`
      INSERT INTO productos (
        empresa_id,
        nombre, descripcion, precio, imagen, activo,
        sku, external_id,
        stock_min, stock_max,
        categoria, orden,
        etiqueta, imagen_promo, mostrar_en_catalogo, mostrar_en_landing,
        config_activo,
        created_by, updated_by, updated_at
      )
      VALUES (
        $1,
        $2, $3, $4, $5, true,
        $6, $7,
        $8, $9,
        $10, $11,
        $12, $13, $14, $15,
        $16,
        $17, $18, NOW()
      )
      RETURNING id
    `, [
      targetEmpresa,
      nombreOk,
      (descripcion ? String(descripcion) : null),
      precioNum,
      (imagen ? String(imagen) : null),
      skuFinal,
      externalFinal,
      Number(stock_min || 0),
      Number(stock_max || 0),
      (categoria ? String(categoria) : null),
      ordenNum,
      (etiqueta ? String(etiqueta) : null),
      (imagen_promo ? String(imagen_promo) : null),
      (mostrar_en_catalogo !== undefined ? !!mostrar_en_catalogo : true),
      (mostrar_en_landing !== undefined ? !!mostrar_en_landing : false),
      configActivo,
      uid,
      uid
    ]);

    res.json({ id: rows[0].id });
  } catch (e) {
    if (e?.code === '23505') {
      return res.status(409).json({ error: 'SKU o External ID ya existe para esta empresa.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Error creando producto' });
  }
});

// Editar Producto (PUT)
app.put('/api/productos/:id', withAuth, async (req, res) => {
  try {
    const {
      nombre, descripcion, precio, imagen, activo,
      stock_min, stock_max,
      categoria, orden,
      etiqueta, imagen_promo, mostrar_en_catalogo, mostrar_en_landing,
      sku, external_id,
      config_activo,
      empresa_id // solo super (opcional)
    } = req.body;

    const esSuper = isSuper(req);

    // Resolver empresa objetivo:
    let targetEmpresa = (!esSuper) ? getEmpresaIdFromToken(req) : null;

    if (esSuper && empresa_id) {
      targetEmpresa = Number(empresa_id);
    }

    // Si es super y no vino empresa_id, inferimos por DB para evitar cross-tenant por id
    if (esSuper && !targetEmpresa) {
      const r = await query(`SELECT empresa_id FROM productos WHERE id=$1`, [req.params.id]);
      if (!r.length) return res.status(404).json({ error: 'Producto no encontrado' });
      targetEmpresa = r[0].empresa_id;
    }

    if (!targetEmpresa && !esSuper) {
      return res.status(400).json({ error: 'Falta empresa.' });
    }

    const sets = [];
    const vals = [];
    let idx = 1;

    // Campos básicos
    if (nombre !== undefined)       { sets.push(`nombre=$${idx++}`);       vals.push(String(nombre).trim()); }
    if (descripcion !== undefined)  { sets.push(`descripcion=$${idx++}`);  vals.push(descripcion ? String(descripcion) : null); }
    if (precio !== undefined)       { sets.push(`precio=$${idx++}`);       vals.push(Number(precio)); }
    if (imagen !== undefined)       { sets.push(`imagen=$${idx++}`);       vals.push(imagen ? String(imagen) : null); }
    if (activo !== undefined)       { sets.push(`activo=$${idx++}`);       vals.push(!!activo); }
    if (stock_min !== undefined)    { sets.push(`stock_min=$${idx++}`);    vals.push(Number(stock_min)); }
    if (stock_max !== undefined)    { sets.push(`stock_max=$${idx++}`);    vals.push(Number(stock_max)); }

    // Organización de catálogo
    if (categoria !== undefined) {
      sets.push(`categoria=$${idx++}`);
      vals.push(categoria ? String(categoria) : null);
    }
    if (orden !== undefined) {
      const ordenNum = (orden === null || orden === '') ? null : Number(orden);
      sets.push(`orden=$${idx++}`);
      vals.push(ordenNum);
    }

    // Nuevos campos
    if (etiqueta !== undefined)          { sets.push(`etiqueta=$${idx++}`);          vals.push(etiqueta ? String(etiqueta) : null); }
    if (imagen_promo !== undefined)      { sets.push(`imagen_promo=$${idx++}`);      vals.push(imagen_promo ? String(imagen_promo) : null); }
    if (mostrar_en_catalogo !== undefined) { sets.push(`mostrar_en_catalogo=$${idx++}`); vals.push(!!mostrar_en_catalogo); }
    if (mostrar_en_landing !== undefined)  { sets.push(`mostrar_en_landing=$${idx++}`);  vals.push(!!mostrar_en_landing); }

    // Config de activo/alquiler (JSONB)
    if (config_activo !== undefined) {
      sets.push(`config_activo=$${idx++}`);
      vals.push(config_activo); // objeto JS → JSONB en PG
    }

    // Multi-tenancy helpers
    if (sku !== undefined) {
      const skuNorm = (sku === null) ? null : String(sku).trim().toUpperCase();
      sets.push(`sku=$${idx++}`);
      vals.push(skuNorm && skuNorm.length ? skuNorm : null);
    }
    if (external_id !== undefined) {
      const extNorm = (external_id === null) ? null : String(external_id).trim();
      sets.push(`external_id=$${idx++}`);
      vals.push(extNorm && extNorm.length ? extNorm : null);
    }

    if (!sets.length) return res.json({ ok: true });

    // Auditoría
    const uid = req.user?.uid ?? null;
    sets.push(`updated_at=NOW()`);
    sets.push(`updated_by=$${idx++}`);
    vals.push(uid);

    // WHERE multi-tenant + soft delete
    vals.push(req.params.id);
    const idPos = idx++;
    vals.push(targetEmpresa);
    const empPos = idx++;

    const r = await query(
      `UPDATE productos 
       SET ${sets.join(', ')} 
       WHERE id=$${idPos} AND empresa_id=$${empPos} AND deleted_at IS NULL
       RETURNING id`,
      vals
    );

    if (!r.length) return res.status(404).json({ error: 'Producto no encontrado' });

    res.json({ ok: true });
  } catch (e) {
    if (e?.code === '23505') {
      return res.status(409).json({ error: 'SKU o External ID ya existe para esta empresa.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Error actualizando producto' });
  }
});

// Eliminar Producto
app.delete('/api/productos/:id', withAuth, async (req, res) => {
  try {
    const esSuper = isSuper(req);

    // Resolver empresa objetivo
    let targetEmpresa = (!esSuper) ? getEmpresaIdFromToken(req) : null;

    // Opcional para super: permitir mandar empresa_id por query
    if (esSuper && req.query.empresa_id) {
      targetEmpresa = Number(req.query.empresa_id);
    }

    // Si es super y no vino empresa_id, inferimos por DB
    if (esSuper && !targetEmpresa) {
      const r = await query(`SELECT empresa_id FROM productos WHERE id=$1`, [req.params.id]);
      if (!r.length) return res.status(404).json({ error: 'Producto no encontrado' });
      targetEmpresa = r[0].empresa_id;
    }

    if (!targetEmpresa && !esSuper) {
      return res.status(400).json({ error: 'Falta empresa.' });
    }

    // Solo super: borrado físico
    const hard = esSuper && String(req.query.hard || '') === '1';
    if (hard) {
      const r = await query(
        `DELETE FROM productos WHERE id=$1 AND empresa_id=$2 RETURNING id`,
        [req.params.id, targetEmpresa]
      );
      if (!r.length) return res.status(404).json({ error: 'Producto no encontrado' });
      return res.json({ ok: true, hard: true });
    }

    // Borrado lógico (default)
    const uid = req.user?.uid ?? null;
    const r = await query(
      `UPDATE productos 
       SET deleted_at=NOW(), deleted_by=$1, activo=false, updated_at=NOW(), updated_by=$1
       WHERE id=$2 AND empresa_id=$3 AND deleted_at IS NULL
       RETURNING id`,
      [uid, req.params.id, targetEmpresa]
    );

    if (!r.length) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo eliminar (posiblemente en uso)' });
  }
});

// --------------------------------------------------
// COSTOS (Tabla: chofer_costos)
// --------------------------------------------------

app.get('/api/choferes/:id/costos', withAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT cc.*, p.nombre as producto_nombre 
       FROM chofer_costos cc
       JOIN productos p ON p.id = cc.producto_id
       WHERE cc.chofer_id = $1`, [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error costos' }); }
});

// Agregar o Actualizar costo (Upsert)
app.post('/api/choferes/:id/costos', withAuth, async (req, res) => {
  try {
    const { producto_id, costo_unitario } = req.body;
    
    // Obtener empresa_id del chofer
    const empresaId = getEmpresaIdFromToken(req) || 
      (await query('SELECT empresa_id FROM choferes WHERE id=$1', [req.params.id]))[0]?.empresa_id;
    
    if (!empresaId) return res.status(400).json({ error: 'No se pudo determinar la empresa del chofer' });

    // Usamos ON CONFLICT para que actúe como "Guardar o Actualizar"
    await query(
      `INSERT INTO chofer_costos (empresa_id, chofer_id, producto_id, costo_unitario) 
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (empresa_id, chofer_id, producto_id) 
       DO UPDATE SET costo_unitario = EXCLUDED.costo_unitario`,
      [empresaId, req.params.id, producto_id, costo_unitario]
    );
    
    res.json({ ok: true });
  } catch (e) { 
    console.error('ERROR COSTOS:', e); // Esto te mostrará el error real en los logs de Render
    res.status(500).json({ error: 'Error guardando costo: ' + (e.message || e) }); 
  }
});

app.put('/api/choferes/:id/costos/:pid', withAuth, async (req, res) => {
  try {
    const { costo_unitario } = req.body;
    await query(
      `UPDATE chofer_costos SET costo_unitario=$1 WHERE chofer_id=$2 AND producto_id=$3`,
      [costo_unitario, req.params.id, req.params.pid]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error actualizando costo' }); }
});

app.delete('/api/choferes/:id/costos/:pid', withAuth, async (req, res) => {
  try {
    await query(`DELETE FROM chofer_costos WHERE chofer_id=$1 AND producto_id=$2`, [req.params.id, req.params.pid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error borrando costo' }); }
});

// --------------------------------------------------
// ESCALAS (Tablas: chofer_escalas, chofer_escala_tramos)
// --------------------------------------------------

app.get('/api/choferes/:id/escalas', withAuth, async (req, res) => {
  try {
    const escalas = await query(`SELECT * FROM chofer_escalas WHERE chofer_id=$1`, [req.params.id]);
    for (let e of escalas) {
      e.tramos = await query(`SELECT * FROM chofer_escala_tramos WHERE escala_id=$1 ORDER BY rango_min`, [e.id]);
    }
    res.json(escalas);
  } catch (e) { res.status(500).json({ error: 'Error escalas' }); }
});

app.post('/api/choferes/:id/escalas', withAuth, async (req, res) => {
  try {
    const { nombre, vigente_desde, vigente_hasta, notas } = req.body;
    // Obtener empresa_id
    const empresaId = getEmpresaIdFromToken(req) || (await query('SELECT empresa_id FROM choferes WHERE id=$1', [req.params.id]))[0]?.empresa_id;

    await query(
      `INSERT INTO chofer_escalas (empresa_id, chofer_id, nombre, vigente_desde, vigente_hasta, notas)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [empresaId, req.params.id, nombre, vigente_desde, vigente_hasta || null, notas]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error creando escala' }); }
});

app.put('/api/escalas/:id', withAuth, async (req, res) => {
  try {
    const { nombre, vigente_desde, vigente_hasta, notas } = req.body;
    if (nombre) await query(`UPDATE chofer_escalas SET nombre=$1, vigente_desde=$2, vigente_hasta=$3, notas=$4 WHERE id=$5`, [nombre, vigente_desde, vigente_hasta, notas, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error editando escala' }); }
});

app.delete('/api/escalas/:id', withAuth, async (req, res) => {
  try {
    await query(`DELETE FROM chofer_escalas WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error borrando escala' }); }
});

app.post('/api/escalas/:id/tramos', withAuth, async (req, res) => {
  try {
    const { rango_min, rango_max, monto } = req.body;
    await query(`INSERT INTO chofer_escala_tramos (escala_id, rango_min, rango_max, monto) VALUES ($1, $2, $3, $4)`, [req.params.id, rango_min, rango_max || null, monto]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error creando tramo' }); }
});

app.put('/api/tramos/:id', withAuth, async (req, res) => {
  try {
    const { rango_min, rango_max, monto } = req.body;
    await query(`UPDATE chofer_escala_tramos SET rango_min=$1, rango_max=$2, monto=$3 WHERE id=$4`, [rango_min, rango_max || null, monto, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error editando tramo' }); }
});

app.delete('/api/tramos/:id', withAuth, async (req, res) => {
  try {
    await query(`DELETE FROM chofer_escala_tramos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error borrando tramo' }); }
});

// --------------------------------------------------
// USUARIOS (ADMIN - Creación/Gestión)
// --------------------------------------------------

app.post('/api/admin/usuarios', withAuth, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    const { username, password, role, empresa_id, chofer_id } = req.body || {};
    const cleanUser = String(username || '').trim();
    if (!cleanUser) return res.status(400).json({ error: 'Falta username' });
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'Clave min 6 chars' });

    let targetEmpresa = null;
    if (role === 'super') {
       if (!esSuper) return res.status(403).json({ error: 'Solo super crea super' });
    } else if (esSuper) {
       targetEmpresa = Number(empresa_id);
    } else {
       targetEmpresa = getEmpresaIdFromToken(req);
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(String(password), salt);

    const rows = await query(
      `INSERT INTO usuarios (username, password, role, empresa_id, chofer_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, username`,
      [cleanUser, hash, role || 'user', targetEmpresa, chofer_id || null]
    );
    res.json(rows[0]);
  } catch (e) { 
    if(e.message.includes('unique')) return res.status(400).json({error: 'Username en uso'});
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/admin/usuarios', withAuth, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    const empresaId = esSuper ? (Number(req.query.empresa_id) || null) : getEmpresaIdFromToken(req);
    let sql = `SELECT id, username, role, empresa_id, chofer_id FROM usuarios`;
    const params = [];
    if (empresaId) { sql += ` WHERE empresa_id=$1`; params.push(empresaId); }
    sql += ` ORDER BY id ASC`;
    const rows = await query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error usuarios' }); }
});

app.put('/api/admin/usuarios/:id', withAuth, async (req, res) => {
  if (!isSuper(req)) return res.status(403).json({ error: 'Solo superadmin' });
  try {
    const { username, password, role, empresa_id, chofer_id } = req.body;
    const sets = []; const vals = []; let idx = 1;

    if (username) { sets.push(`username=$${idx++}`); vals.push(username); }
    if (password && String(password).trim().length > 0) { 
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(String(password), salt);
      sets.push(`password=$${idx++}`); vals.push(hash); 
    } 
    if (role) { sets.push(`role=$${idx++}`); vals.push(role); }
    if (empresa_id !== undefined) { sets.push(`empresa_id=$${idx++}`); vals.push(Number(empresa_id) || null); }
    if (chofer_id !== undefined) { sets.push(`chofer_id=$${idx++}`); vals.push(Number(chofer_id) || null); }

    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    await query(`UPDATE usuarios SET ${sets.join(', ')} WHERE id=$${idx}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error actualizando usuario' }); }
});

app.delete('/api/admin/usuarios/:id', withAuth, async (req, res) => {
  if (!isSuper(req)) return res.status(403).json({ error: 'Solo super' });
  try {
    await query(`DELETE FROM usuarios WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error borrando usuario' }); }
});

app.get('/api/admin/empresas-list', withAuth, async (req, res) => {
  if (req.user.role !== 'super') return res.sendStatus(403);
  
  try {
    const empresas = await query('SELECT id, nombre FROM empresas ORDER BY id ASC');
    res.json(empresas);
  } catch (e) {
    res.status(500).json({ error: 'Error al listar empresas' });
  }
});

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

// 5. Resumen del día del repartidor
app.get('/api/repartidor/resumen-dia', withAuth, async (req, res) => {
  try {
    const { chofer_id } = req.user || {};
    if (!chofer_id) {
      return res.json({ entregados: 0, pendientes: 0, dinero: 0 });
    }

    const sql = `
      SELECT 
        COUNT(*) FILTER (WHERE estado = 'entregado') AS entregados,
        COUNT(*) FILTER (WHERE estado IN ('pendiente','en_ruta','en_camino')) AS pendientes,
        COALESCE(SUM(monto) FILTER (WHERE estado = 'entregado'), 0) AS dinero
      FROM pedidos
      WHERE chofer_id = $1
        AND fecha >= CURRENT_DATE
        AND fecha < (CURRENT_DATE + INTERVAL '1 day')
    `;
    
    const rows = await query(sql, [chofer_id]);
    res.json(rows[0] || { entregados: 0, pendientes: 0, dinero: 0 });
  } catch (e) {
    console.error('ERROR /api/repartidor/resumen-dia', e);
    res.status(500).json({ error: 'Error resumen' });
  }
});

// 6. Stock del repartidor (por chofer)
app.get('/api/repartidor/stock', withAuth, async (req, res) => {
  try {
    const { chofer_id } = req.user || {};
    const empId = getEmpresaIdFromToken(req);

    if (!chofer_id || !empId) {
      return res.status(400).json({ error: 'Faltan datos de empresa/chofer' });
    }

    const at = (req.query.at || '').toString().slice(0, 10);
    let rows;

    if (at) {
      // Saldo histórico hasta esa fecha (incluida) desde chofer_stock_mov
      rows = await query(`
        SELECT
          csm.producto_id,
          p.nombre AS producto,
          COALESCE(SUM(csm.cantidad), 0) AS cantidad
        FROM chofer_stock_mov csm
        JOIN productos p
          ON p.id = csm.producto_id
        WHERE csm.empresa_id = $1
          AND csm.chofer_id  = $2
          AND csm.fecha < ($3::date + INTERVAL '1 day')
        GROUP BY csm.producto_id, p.nombre
        HAVING COALESCE(SUM(csm.cantidad), 0) <> 0
        ORDER BY p.nombre
      `, [empId, chofer_id, at]);
    } else {
      // Stock "actual" desde la tabla agregada chofer_stock
      rows = await query(`
        SELECT
          cs.producto_id,
          p.nombre AS producto,
          COALESCE(cs.cantidad, 0) AS cantidad
        FROM chofer_stock cs
        JOIN productos p
          ON p.id = cs.producto_id
        WHERE cs.empresa_id = $1
          AND cs.chofer_id  = $2
          AND COALESCE(cs.cantidad, 0) <> 0
        ORDER BY p.nombre
      `, [empId, chofer_id]);
    }

    res.json(rows);
  } catch (e) {
    console.error('REPARTIDOR STOCK ERROR', e);
    res.status(500).json({ error: 'Error cargando stock del repartidor' });
  }
});

// 7. Pago diario del chofer según escala (usado por panel del repartidor)
app.get('/api/repartidor/pago-dia', withAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.chofer_id) {
      return res.status(400).json({ error: 'Usuario sin chofer asociado' });
    }

    const choferId = user.chofer_id;
    const fecha = (req.query.fecha || new Date().toISOString().slice(0, 10)).slice(0, 10);

    const empresaId =
      getEmpresaIdFromToken(req) ||
      (await query('SELECT empresa_id FROM choferes WHERE id=$1', [choferId]))[0]?.empresa_id;

    if (!empresaId) {
      return res.status(400).json({ error: 'No se pudo determinar la empresa del chofer' });
    }

    const row = (
      await query(
        `
        WITH entregas AS (
          SELECT COALESCE(SUM(it.cantidad),0) AS q
          FROM items_pedido it
          JOIN pedidos p          ON p.id = it.pedido_id
          JOIN puntos_entrega pe  ON pe.id = p.punto_entrega_id
          WHERE pe.empresa_id = $1
            AND p.chofer_id  = $2
            AND p.fecha >= $3::date
            AND p.fecha < ($3::date + INTERVAL '1 day')
            AND LOWER(p.estado) = 'entregado'
        ),
        escala_sel AS (
          SELECT ce.id
          FROM chofer_escalas ce
          WHERE ce.empresa_id = $4
            AND (ce.chofer_id = $5 OR ce.chofer_id IS NULL)
            AND $6::date BETWEEN DATE(ce.vigente_desde)
                             AND DATE(COALESCE(ce.vigente_hasta,'9999-12-31'))
          ORDER BY (ce.chofer_id IS NOT NULL) DESC, ce.vigente_desde DESC
          LIMIT 1
        ),
        monto_sel AS (
          SELECT t.monto
          FROM chofer_escala_tramos t
          JOIN entregas e ON TRUE
          JOIN escala_sel s ON t.escala_id = s.id
          WHERE e.q BETWEEN t.rango_min AND COALESCE(t.rango_max, 999999)
          LIMIT 1
        )
        SELECT
          (SELECT q FROM entregas) AS cantidad,
          COALESCE((SELECT monto FROM monto_sel), 0) AS pago
      `,
        [empresaId, choferId, fecha, empresaId, choferId, fecha]
      )
    )[0] || {};

    res.json({
      fecha,
      cantidad: Number(row.cantidad || 0),
      pago: Number(row.pago || 0),
    });
  } catch (e) {
    console.error('ERROR /api/repartidor/pago-dia', e);
    res.status(500).json({ error: 'Error calculando pago del día' });
  }
});

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

app.get('/api/pedidos', withAuth, checkLicencia, async (req, res) => {
  try {
    const { from, to, estado, chofer_id, empresa_id } = req.query || {};
    const esSuper = isSuper(req);
    
    let targetEmpresa = esSuper 
      ? (empresa_id ? Number(empresa_id) : null) 
      : getEmpresaIdFromToken(req);

    let sql = `
      SELECT 
        p.id,
        p.fecha,
        p.estado,
        p.monto,
        p.metodo_pago,
        pe.cliente,
        pe.telefono,
        pe.direccion,
        p.empresa_id,
        p.zona_id,
        p.chofer_id,
        c.nombre AS chofer_nombre
      FROM pedidos p
      JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
      LEFT JOIN choferes c   ON p.chofer_id = c.id
      WHERE 1=1
    `;
    
    const params = [];
    let idx = 1;

    // Empresa
    if (targetEmpresa) {
      sql += ` AND pe.empresa_id = $${idx++}`;
      params.push(targetEmpresa);
    }

    // Filtros varios
    if (chofer_id) {
      sql += ` AND p.chofer_id = $${idx++}`;
      params.push(Number(chofer_id));
    }
    if (estado) {
      sql += ` AND p.estado = $${idx++}`;
      params.push(estado);
    }

    // Fechas (rango, sin tocar la columna)
    if (from) {
      sql += ` AND p.fecha >= $${idx++}::date`;
      params.push(from.toString().slice(0, 10));
    }
    if (to) {
      sql += ` AND p.fecha < ($${idx++}::date + INTERVAL '1 day')`;
      params.push(to.toString().slice(0, 10));
    }

    sql += ` ORDER BY p.fecha DESC, p.id DESC LIMIT 500`;

    const rows = await query(sql, params);
    res.json(rows);

  } catch (e) {
    console.error('ERROR GET PEDIDOS:', e);
    res.status(500).json({ error: 'Error cargando pedidos' });
  }
});

app.put('/api/pedidos/:id', withAuth, async (req, res) => {
  try {
    const { estado, metodo_pago, empresa_id, chofer_id, zona_id } = req.body;
    
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
    if (empresa_id != null) {
      sets.push(`empresa_id = $${idx++}`);
      vals.push(empresa_id);
    }
    if (chofer_id != null) {
      sets.push(`chofer_id = $${idx++}`);
      vals.push(chofer_id);
    }
    if (zona_id != null) {
      sets.push(`zona_id = $${idx++}`);
      vals.push(zona_id);
    }

    if (sets.length) {
      vals.push(req.params.id);
      await query(`UPDATE pedidos SET ${sets.join(', ')} WHERE id = $${idx}`, vals);

      // --- LÓGICA DE NOTIFICACIÓN AUTOMÁTICA ---
      if (estado === 'en_ruta') {
        const targetEmpresa = empresa_id || getEmpresaIdFromToken(req);
        // Ejecutamos sin await para no demorar la respuesta de la API
        notificarEnRuta(req.params.id, targetEmpresa).catch(err => 
          console.error('Error en notificación background:', err)
        );
      }
      // -----------------------------------------
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error actualizando pedido' });
  }
});

app.delete('/api/pedidos/:id', withAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const esSuper = isSuper(req);
    const myEmpresa = getEmpresaIdFromToken(req);

    // 1. Verificamos que el pedido exista y pertenezca a tu empresa
    const rows = await query('SELECT id, empresa_id FROM pedidos WHERE id=$1', [id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const pedido = rows[0];

    // Seguridad: Si no eres super, solo puedes borrar pedidos de tu empresa
    if (!esSuper && pedido.empresa_id !== myEmpresa) {
      return res.status(403).json({ error: 'No tienes permiso para borrar este pedido' });
    }

    // 2. Borrado en Cascada Manual (para limpiar tablas satélite)
    // Primero borramos los ítems del pedido
    await query('DELETE FROM items_pedido WHERE pedido_id=$1', [id]);
    
    // CORRECCIÓN IMPORTANTE: La tabla se llama "pedido_track_points"
    await query('DELETE FROM pedido_track_points WHERE pedido_id=$1', [id]); 
    
    // Borramos comprobantes asociados si existen
    await query('DELETE FROM comprobantes_transferencia WHERE pedido_id=$1', [id]);

    // 3. Finalmente borramos el pedido principal
    await query('DELETE FROM pedidos WHERE id=$1', [id]);

    res.json({ ok: true });

  } catch (e) {
    console.error('ERROR DELETE PEDIDO:', e);
    res.status(500).json({ error: 'Error interno al eliminar el pedido' });
  }
});

app.put('/api/pedidos/:id/items', withAuth, async (req, res) => {
  const pedidoId = req.params.id;
  const { items: nuevosItems } = req.body; // Array de { producto, cantidad, precio_unitario }
  const empresaId = getEmpresaIdFromToken(req);

  // Usamos un cliente específico para poder hacer ROLLBACK si algo falla
  const client = await pool.connect();

  try {
    await client.query('BEGIN'); // <--- Inicio Transacción

    // 1. Obtener datos clave del pedido (estado y chofer)
    const pedData = await client.query(
      'SELECT chofer_id, estado, empresa_id FROM pedidos WHERE id = $1', 
      [pedidoId]
    );

    if (pedData.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const { chofer_id, estado } = pedData.rows[0];

    // --- CORRECCIÓN DE BUG DE STOCK ---
    // Solo tocamos stock físico si el pedido ya fue marcado como "entregado".
    const stockYaDescontado = (estado === 'entregado');

    // 2. Si corresponde, obtener ítems viejos para DEVOLVER el stock antes de borrar
    if (chofer_id && stockYaDescontado) {
      const itemsViejos = await client.query(
        'SELECT producto, cantidad FROM items_pedido WHERE pedido_id = $1',
        [pedidoId]
      );

      for (const oldIt of itemsViejos.rows) {
        // Buscamos ID producto
        const prod = await client.query(
          'SELECT id FROM productos WHERE nombre = $1 AND empresa_id = $2',
          [oldIt.producto, empresaId]
        );
        
        if (prod.rows.length > 0) {
          const prodId = prod.rows[0].id;
          
          // DEVOLUCIÓN: Sumamos stock al chofer
          await client.query(`
            INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (empresa_id, chofer_id, producto_id)
            DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
          `, [empresaId, chofer_id, prodId, Number(oldIt.cantidad)]);

          // Registrar movimiento (Auditoría)
          await client.query(`
              INSERT INTO chofer_stock_mov (empresa_id, chofer_id, producto_id, cantidad, tipo, motivo, referencia)
              VALUES ($1, $2, $3, $4, 'DEVOLUCION', 'Corrección items pedido (Restauración)', $5)
            `, [empresaId, chofer_id, prodId, Number(oldIt.cantidad), `Edit Pedido #${pedidoId}`]);
        }
      }
    }

    // 3. Reemplazo de Ítems en la BD
    // Borrar viejos
    await client.query(`DELETE FROM items_pedido WHERE pedido_id=$1`, [pedidoId]);
    
    // Insertar nuevos
    if (Array.isArray(nuevosItems)) {
      for (const it of nuevosItems) {
        await client.query(
          `INSERT INTO items_pedido (pedido_id, producto, cantidad, precio_unitario) VALUES ($1, $2, $3, $4)`,
          [pedidoId, it.producto, Number(it.cantidad), Number(it.precio_unitario)]
        );

        // 4. Si corresponde, DESCONTAR el nuevo stock
        if (chofer_id && stockYaDescontado) {
          const prod = await client.query(
            'SELECT id FROM productos WHERE nombre = $1 AND empresa_id = $2',
            [it.producto, empresaId]
          );
          
          if (prod.rows.length > 0) {
            const prodId = prod.rows[0].id;
            const cantidadDescontar = Number(it.cantidad);

            // RESTA: Descontamos stock al chofer
            await client.query(`
              UPDATE chofer_stock 
              SET cantidad = cantidad - $1 
              WHERE chofer_id = $2 AND producto_id = $3`,
              [cantidadDescontar, chofer_id, prodId]
            );
            
            // Registrar movimiento
            await client.query(`
              INSERT INTO chofer_stock_mov (empresa_id, chofer_id, producto_id, cantidad, tipo, motivo, referencia)
              VALUES ($1, $2, $3, $4, 'venta', 'Corrección items pedido (Nueva salida)', $5)
            `, [empresaId, chofer_id, prodId, -cantidadDescontar, `Edit Pedido #${pedidoId}`]);
          }
        }
      }
    }
    
    // 5. Recalcular monto total del pedido
    await client.query(`
      UPDATE pedidos 
      SET monto = (SELECT COALESCE(SUM(cantidad*precio_unitario),0) FROM items_pedido WHERE pedido_id=$1)
      WHERE id=$1`, 
      [pedidoId]
    );

    await client.query('COMMIT'); // <--- Confirmar cambios
    client.release();
    res.json({ ok: true });

  } catch (e) { 
    await client.query('ROLLBACK'); // <--- Cancelar todo si hay error
    client.release();
    console.error('Error editando ítems y stock:', e);
    res.status(500).json({ error: 'Error procesando cambios y stock' }); 
  }
});

app.get('/api/pedidos/:id/items', withAuth, async (req, res) => {
  try {
    const pedidoId = Number(req.params.id);
    if (!Number.isInteger(pedidoId)) {
      return res.status(400).json({ error: 'ID de pedido inválido' });
    }

    const esSuper   = isSuper(req);
    const myEmpresa = getEmpresaIdFromToken(req);

    // Validar acceso
    const ped = await query('SELECT empresa_id FROM pedidos WHERE id=$1', [pedidoId]);
    if (!ped.length) return res.status(404).json({ error: 'Pedido no encontrado' });

    if (!esSuper && ped[0].empresa_id !== myEmpresa) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const items = await query(
      `SELECT id, producto, cantidad, precio_unitario
         FROM items_pedido
        WHERE pedido_id=$1
        ORDER BY id`,
      [pedidoId]
    );

    res.json(items);
  } catch (e) {
    console.error('ERROR GET ITEMS PEDIDO:', e);
    res.status(500).json({ error: 'Error cargando ítems' });
  }
});

// --------------------------------------------------
// STOCK
// --------------------------------------------------

app.get('/api/stock/summary', withAuth, async (req, res) => {
  try {
    const empresaId = isSuper(req) && req.query.empresa_id
      ? Number(req.query.empresa_id)
      : getEmpresaIdFromToken(req);

    if (!empresaId) {
      return res.status(400).json({ error: 'empresa_id requerido' });
    }

    // Resumen general: suma de stock de todos los choferes por producto
    const sql = `
      SELECT 
        p.id,
        p.nombre,
        p.stock_min,
        p.stock_max,
        COALESCE(SUM(cs.cantidad), 0) AS stock_fisico
      FROM productos p
      LEFT JOIN chofer_stock cs
        ON cs.producto_id = p.id
       AND cs.empresa_id  = p.empresa_id   -- ⬅️ importante para multi-empresa
      WHERE p.empresa_id = $1
      GROUP BY p.id, p.nombre, p.stock_min, p.stock_max
      ORDER BY p.nombre
    `;
    const rows = await query(sql, [empresaId]);
    res.json(rows);
  } catch (e) {
    console.error('ERROR /api/stock/summary', e);
    res.status(500).json({ error: 'Error stock' });
  }
});

// Ajuste de Stock (Movimiento manual)
app.post('/api/stock/ajuste', withAuth, async (req, res) => {
  try {
    const { producto_id, qty, tipo, motivo, chofer_id, empresa_id } = req.body;
    // tipo en el body: 'ADJUST+' (Entrada) o 'ADJUST-' (Salida)

    const esSuper = isSuper(req);
    const targetEmpresa = (esSuper && empresa_id)
      ? Number(empresa_id)
      : getEmpresaIdFromToken(req);

    if (!targetEmpresa) {
      return res.status(400).json({ error: 'empresa_id requerido' });
    }

    if (!chofer_id) {
      return res.status(400).json({ error: 'Se requiere chofer para asignar el stock' });
    }

    const cantidadNum = Number(qty);
    if (!Number.isFinite(cantidadNum) || cantidadNum <= 0) {
      return res.status(400).json({ error: 'Cantidad inválida' });
    }

    // 1. Registrar movimiento en historial
    const signo = tipo === 'ADJUST-' ? -1 : 1;
    const cantidadReal = Math.abs(cantidadNum) * signo;

    await query(
      `
      INSERT INTO chofer_stock_mov
        (empresa_id, chofer_id, producto_id, fecha, tipo, cantidad, motivo, created_at)
      VALUES
        ($1,        $2,        $3,          NOW(), 'ajuste', $4,      $5,    NOW())
      `,
      [targetEmpresa, chofer_id, producto_id, cantidadReal, motivo || 'Ajuste manual']
    );

    // 2. Actualizar tabla acumuladora (Upsert)
    await query(`
      INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (empresa_id, chofer_id, producto_id)
      DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
    `, [targetEmpresa, chofer_id, producto_id, cantidadReal]);

    res.json({ ok: true });
  } catch (e) {
    console.error('ERROR /api/stock/ajuste', e);
    res.status(500).json({ error: 'Error ajuste stock' });
  }
});

// Kardex (Historial por producto)
app.get('/api/stock/kardex/:id', withAuth, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    const empresaId = esSuper && req.query.empresa_id
      ? Number(req.query.empresa_id)
      : getEmpresaIdFromToken(req);

    if (!empresaId) {
      return res.status(400).json({ error: 'empresa_id requerido' });
    }

    const productoId = Number(req.params.id);

    const rows = await query(
      `
      SELECT *,
             COALESCE(referencia, motivo) as notas
      FROM chofer_stock_mov
      WHERE producto_id = $1
        AND empresa_id  = $2      -- ⬅️ importantísimo para multi-tenant
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [productoId, empresaId]
    );
    res.json(rows);
  } catch (e) {
    console.error('ERROR /api/stock/kardex', e);
    res.status(500).json({ error: 'Error kardex' });
  }
});

// Stock por tipo de chofer (propio vs fletero) para cada producto
app.get('/api/stock/por-tipo', withAuth, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    const empresaId = esSuper && req.query.empresa_id
      ? Number(req.query.empresa_id)
      : getEmpresaIdFromToken(req);

    const productoId = req.query.producto_id
      ? Number(req.query.producto_id)
      : null;
    const tipo = (req.query.tipo || '').toLowerCase(); // 'propio' / 'fletero' (opcional)

    if (!empresaId) {
      return res.status(400).json({ error: 'empresa_id requerido' });
    }

    let sql = `
      SELECT
        p.id              AS producto_id,
        p.nombre,
        p.stock_min,
        p.stock_max,
        ch.tipo           AS tipo_chofer,
        COALESCE(SUM(cs.cantidad), 0) AS stock
      FROM productos p
      LEFT JOIN chofer_stock cs
             ON cs.producto_id = p.id
            AND cs.empresa_id  = p.empresa_id
      LEFT JOIN choferes ch
             ON ch.id = cs.chofer_id
      WHERE p.empresa_id = $1
    `;

    const params = [empresaId];
    let idx = 2;

    if (productoId) {
      sql += ` AND p.id = $${idx++}`;
      params.push(productoId);
    }

    if (tipo === 'propio' || tipo === 'fletero') {
      sql += ` AND ch.tipo = $${idx++}`;
      params.push(tipo);
    }

    sql += `
      GROUP BY
        p.id, p.nombre, p.stock_min, p.stock_max, ch.tipo
      ORDER BY
        p.nombre, ch.tipo
    `;

    const rows = await query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('ERROR /api/stock/por-tipo', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Movimientos por tipo_chofer y producto (cargado vs entregado)
app.get('/api/stock/movimientos-por-tipo', withAuth, checkLicencia, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    const empresaId = esSuper && req.query.empresa_id
      ? Number(req.query.empresa_id)
      : getEmpresaIdFromToken(req);

    if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

    const { from, to, producto_id, tipo } = req.query || {};

    const dateFrom = from ? from.toString().slice(0, 10) : '2000-01-01';
    const dateTo   = to   ? to.toString().slice(0, 10)   : '2100-12-31';

    let sql = `
      WITH 
      entradas AS (
        SELECT 
            csm.chofer_id, 
            csm.producto_id, 
            SUM(csm.cantidad) as total_cargado
        FROM chofer_stock_mov csm
        WHERE csm.empresa_id = $1
          AND csm.cantidad > 0 
          AND csm.tipo <> 'venta' -- ⬅️ para no contar ventas como "cargado"
          -- Filtro fecha con Zona Horaria Argentina
          AND (csm.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $2::date 
          AND (csm.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $3::date
        GROUP BY 1, 2
      ),
      salidas_ventas AS (
        SELECT 
            p.chofer_id, 
            pr.id as producto_id, 
            SUM(ip.cantidad) as total_entregado
        FROM pedidos p
        JOIN items_pedido ip ON ip.pedido_id = p.id
        JOIN productos pr ON pr.nombre = ip.producto AND pr.empresa_id = p.empresa_id
        WHERE p.empresa_id = $1
          AND p.estado = 'entregado'
          -- Usar fecha_entrega si existe, para coincidir con el resumen del chofer
          AND (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $2::date 
          AND (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $3::date
        GROUP BY 1, 2
      )

      SELECT
        p.id              AS producto_id,
        p.nombre,
        p.stock_min,
        p.stock_max,
        ch.tipo           AS tipo_chofer,
        COALESCE(e.total_cargado, 0)   AS cargado,
        COALESCE(s.total_entregado, 0) AS entregado,
        (COALESCE(e.total_cargado, 0) - COALESCE(s.total_entregado, 0)) AS neto
      
      FROM productos p
      CROSS JOIN choferes ch 
      LEFT JOIN entradas       e ON e.producto_id = p.id AND e.chofer_id = ch.id
      LEFT JOIN salidas_ventas s ON s.producto_id = p.id AND s.chofer_id = ch.id
      
      WHERE p.empresa_id = $1
        AND ch.empresa_id = $1
    `;

    const params = [empresaId, dateFrom, dateTo];
    let idx = 4;

    if (producto_id) {
      sql += ` AND p.id = $${idx++}`;
      params.push(Number(producto_id));
    }

    if (tipo && (tipo === 'propio' || tipo === 'fletero')) {
      sql += ` AND ch.tipo = $${idx++}`;
      params.push(tipo);
    }

    // Filtrar filas vacías para limpiar el reporte
    sql += `
      AND (COALESCE(e.total_cargado, 0) > 0 OR COALESCE(s.total_entregado, 0) > 0)
      ORDER BY p.nombre, ch.tipo
    `;

    const rows = await query(sql, params);
    res.json(rows);

  } catch (e) {
    console.error('ERROR /api/stock/movimientos-por-tipo', e);
    res.status(500).json({ error: 'Error calculando movimientos' });
  }
});

// --------------------------------------------------
// REPORTES - PEDIDOS ENTREGADOS
// --------------------------------------------------

app.get('/api/reportes/entregados', withAuth, async (req, res) => {
  try {
    const { from, to, zona_id, chofer_id, metodo_pago, empresa_id } = req.query || {};
    const esSuper       = isSuper(req);
    const myEmpresa     = getEmpresaIdFromToken(req);
    const targetEmpresa = (esSuper && empresa_id) ? Number(empresa_id) : myEmpresa;

    if (!targetEmpresa) {
      return res.status(400).json({ error: 'Empresa no determinada' });
    }

    // MODIFICADO: Agregamos LEFT JOIN con transferencias para saber si ya está "pagado" (validado)
    let sql = `
      SELECT 
        p.id,
        p.fecha,
        pe.cliente,
        pe.telefono,
        pe.direccion,
        p.metodo_pago,
        p.monto,
        p.cantidad_entregada,
        p.chofer_id,
        c.nombre AS chofer_nombre,
        pe.zona_id,
        -- Devuelve true si existe un registro en la tabla financiera para este pedido
        (CASE WHEN t.id IS NOT NULL THEN true ELSE false END) as pagado 
      FROM pedidos p
      JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
      LEFT JOIN choferes c   ON p.chofer_id = c.id
      LEFT JOIN transferencias t ON t.pedido_id = p.id AND t.empresa_id = p.empresa_id
      WHERE p.estado = 'entregado'
        AND pe.empresa_id = $1
    `;

    const params = [targetEmpresa];
    let idx = 2;

    // Fechas como rango
    if (from) {
      sql += ` AND p.fecha >= $${idx++}::date`;
      params.push(from.toString().slice(0, 10));
    }
    if (to) {
      sql += ` AND p.fecha < ($${idx++}::date + INTERVAL '1 day')`;
      params.push(to.toString().slice(0, 10));
    }

    if (zona_id) {
      sql += ` AND pe.zona_id = $${idx++}`;
      params.push(Number(zona_id));
    }

    if (chofer_id) {
      sql += ` AND p.chofer_id = $${idx++}`;
      params.push(Number(chofer_id));
    }

    if (metodo_pago) {
      sql += ` AND p.metodo_pago = $${idx++}`;
      params.push(metodo_pago);
    }

    sql += ` ORDER BY p.fecha DESC, p.id DESC`;

    const rows = await query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('ERROR /api/reportes/entregados', e);
    res.status(500).json({ error: 'Error generando reporte de entregados' });
  }
});

// Endpoint para el Checkbox (Toggle Pago)
app.post('/api/pedidos/:id/toggle-pago', withAuth, async (req, res) => {
  try {
    const pedidoId = Number(req.params.id);
    const { marcado } = req.body; // true = validar, false = anular validación
    const esSuper = isSuper(req);
    let empresaId = getEmpresaIdFromToken(req);

    if (!pedidoId) return res.status(400).json({ error: 'ID inválido' });

    // Si es SuperAdmin y no viene empresa en el token, resolvemos por el pedido.
    // Si NO es super, exigimos empresaId y validamos que el pedido pertenezca a esa empresa.
    let pRows = [];
    if (esSuper && !empresaId) {
      pRows = await query(
        'SELECT empresa_id, monto, chofer_id, fecha FROM pedidos WHERE id = $1',
        [pedidoId]
      );
      if (pRows.length) empresaId = Number(pRows[0].empresa_id);
    } else {
      if (!empresaId) return res.status(400).json({ error: 'Empresa inválida' });
      pRows = await query(
        'SELECT monto, chofer_id, fecha FROM pedidos WHERE id = $1 AND empresa_id = $2',
        [pedidoId, empresaId]
      );
    }
    if (!pRows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    const p = pRows[0];

    if (marcado) {
      // 1) MARCAR COMO PAGADO: crear registro contable en transferencias (si no existe)
      const existe = await query(
        'SELECT id FROM transferencias WHERE pedido_id = $1 AND empresa_id = $2',
        [pedidoId, empresaId]
      );

      if (!existe.length) {
        await query(
          `
          INSERT INTO transferencias (
            empresa_id, chofer_id, fecha, monto, metodo_pago,
            referencia, estado, tipo, pedido_id, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, 'transferencia',
            'Verificado manual desde Estadísticas', 'verificado', 'transferencia', $5, NOW(), NOW()
          )
          `,
          [empresaId, p.chofer_id, p.fecha, p.monto, pedidoId]
        );
      }

      // 2) Validar comprobante asociado (si existe)
      await query(
        'UPDATE comprobantes_transferencia SET validado = 1 WHERE pedido_id = $1 AND empresa_id = $2',
        [pedidoId, empresaId]
      );
    } else {
      // DESMARCAR: eliminar registro contable asociado a este pedido (solo dentro de la empresa)
      await query(
        'DELETE FROM transferencias WHERE pedido_id = $1 AND empresa_id = $2',
        [pedidoId, empresaId]
      );

      // Desvalidar comprobante asociado (si existe)
      await query(
        'UPDATE comprobantes_transferencia SET validado = 0 WHERE pedido_id = $1 AND empresa_id = $2',
        [pedidoId, empresaId]
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('ERROR TOGGLE PAGO:', e);
    res.status(500).json({ error: 'Error actualizando pago' });
  }
});

// --------------------------------------------------
// ESTADÍSTICAS AVANZADAS 
// --------------------------------------------------

app.get('/api/estadisticas/dashboard', withAuth, checkLicencia, async (req, res) => {
  try {
    const { from, to, empresa_id, chofer_id } = req.query;
    const esSuper = isSuper(req);
    const targetEmpresa = (esSuper && empresa_id) ? Number(empresa_id) : getEmpresaIdFromToken(req);

    if (!targetEmpresa) {
      return res.status(400).json({ error: 'Empresa no detectada' });
    }

    const dateFrom = from || '2000-01-01';
    const dateTo = (to || '2100-12-31') + ' 23:59:59';

    // 1) Ventas + unidades + costo variable diario (escala)
    const sqlDaily = `
      WITH daily_data AS (
        SELECT
          p.chofer_id,
          (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS fecha_dia,
          COUNT(DISTINCT p.id) as pedidos,
          COALESCE(SUM(p.monto), 0) as ventas,
          COALESCE(
            SUM((SELECT SUM(cantidad) FROM items_pedido WHERE pedido_id = p.id)),
            0
          ) as unidades
        FROM pedidos p
        JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
        WHERE p.estado = 'entregado'
          AND pe.empresa_id = $1
          AND p.fecha >= $2 AND p.fecha <= $3
          ${chofer_id ? 'AND p.chofer_id = ' + Number(chofer_id) : ''}
        GROUP BY 1, 2
      )
      SELECT
        dd.*,
        COALESCE((
          SELECT cet.monto
          FROM chofer_escalas ce
          JOIN chofer_escala_tramos cet ON ce.id = cet.escala_id
          WHERE (ce.chofer_id = dd.chofer_id OR ce.chofer_id IS NULL)
            AND ce.empresa_id = $1
            AND ce.vigente_desde <= dd.fecha_dia
            AND (ce.vigente_hasta IS NULL OR ce.vigente_hasta >= dd.fecha_dia)
            AND dd.unidades >= cet.rango_min
            AND (cet.rango_max IS NULL OR dd.unidades <= cet.rango_max)
          ORDER BY (ce.chofer_id IS NOT NULL) DESC, ce.vigente_desde DESC, cet.rango_min DESC
          LIMIT 1
        ), 0) as costo_var_dia
      FROM daily_data dd
    `;

    // 2) CP (reposiciones / costo mercadería)
    const sqlProdCosts = `
      SELECT chofer_id, SUM(monto) as costo_prod
      FROM gastos_repartidor
      WHERE empresa_id = $1
        AND fecha >= $2 AND fecha <= $3
        AND tipo IN ('carga_llenos', 'compra_mercaderia')
        ${chofer_id ? 'AND chofer_id = ' + Number(chofer_id) : ''}
      GROUP BY 1
    `;

    // 3) CF (gastos operativos)
    const sqlFixedCosts = `
      SELECT chofer_id, SUM(monto) as gastos
      FROM gastos_repartidor
      WHERE empresa_id = $1
        AND fecha >= $2 AND fecha <= $3
        AND tipo NOT IN ('carga_llenos', 'compra_mercaderia', 'descarga_vacios', 'stock')
        ${chofer_id ? 'AND chofer_id = ' + Number(chofer_id) : ''}
      GROUP BY 1
    `;

    // 4) Top productos
    const sqlTopProducts = `
      SELECT
        it.producto AS producto,
        SUM(it.cantidad) AS cantidad,
        SUM(it.cantidad * it.precio_unitario) AS ventas
      FROM items_pedido it
      JOIN pedidos p         ON p.id = it.pedido_id
      JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
      WHERE p.estado = 'entregado'
        AND pe.empresa_id = $1
        AND p.fecha >= $2 AND p.fecha <= $3
        ${chofer_id ? 'AND p.chofer_id = ' + Number(chofer_id) : ''}
      GROUP BY it.producto
    `;

    const [dailyRes, prodRes, fixedRes, choferesRes, topProdRes] = await Promise.all([
      query(sqlDaily,      [targetEmpresa, dateFrom, dateTo]),
      query(sqlProdCosts,  [targetEmpresa, dateFrom, dateTo]),
      query(sqlFixedCosts, [targetEmpresa, dateFrom, dateTo]),
      query('SELECT id, nombre, tipo FROM choferes WHERE empresa_id=$1', [targetEmpresa]),
      query(sqlTopProducts,[targetEmpresa, dateFrom, dateTo]),
    ]);

    // === Consolidado por chofer + mapa para prorrateo ===
    const choferCostMap = new Map();

    const report = (choferesRes || []).map(c => {
      const id = Number(c.id);
      const dayRows  = (dailyRes || []).filter(d => Number(d.chofer_id) === id);
      const prodRow  = (prodRes  || []).find(r => Number(r.chofer_id) === id);
      const fixedRow = (fixedRes || []).find(r => Number(r.chofer_id) === id);

      const ventas = dayRows.reduce((a, b) => a + Number(b.ventas || 0), 0);
      const cv     = dayRows.reduce((a, b) => a + Number(b.costo_var_dia || 0), 0);
      const cp     = Number(prodRow?.costo_prod || 0);
      const cf     = Number(fixedRow?.gastos || 0);
      const rent   = ventas - cv - cp - cf;

      choferCostMap.set(id, { ventasTotal: ventas, cp, cf });

      return {
        id,
        chofer: c.nombre,
        tipo: c.tipo,
        pedidos:  dayRows.reduce((a, b) => a + Number(b.pedidos  || 0), 0),
        unidades: dayRows.reduce((a, b) => a + Number(b.unidades || 0), 0),
        ventas, cv, cp, cf, rent,
        margen: ventas ? (rent / ventas * 100) : 0
      };
    }).filter(r => r.pedidos > 0 || r.cp > 0 || r.cf > 0);

    const products = (topProdRes || []).map(r => ({
      producto: r.producto,
      cantidad: Number(r.cantidad) || 0,
      ventas:   Number(r.ventas)   || 0
    }));

    // === Evolución diaria con prorrateo CP/CF ===
    const evoMap = new Map(); // key YYYY-MM-DD

    (dailyRes || []).forEach(row => {
      const choferId  = Number(row.chofer_id);
      const fechaKey  = String(row.fecha_dia);
      const ventasDia = Number(row.ventas || 0);
      const cvDia     = Number(row.costo_var_dia || 0);

      const costosChofer = choferCostMap.get(choferId) || { ventasTotal: 0, cp: 0, cf: 0 };

      let cpAlloc = 0, cfAlloc = 0;
      if (ventasDia > 0 && costosChofer.ventasTotal > 0) {
        const ratio = ventasDia / costosChofer.ventasTotal;
        cpAlloc = costosChofer.cp * ratio;
        cfAlloc = costosChofer.cf * ratio;
      }

      const rentDia = ventasDia - cvDia - cpAlloc - cfAlloc;

      const prev = evoMap.get(fechaKey) || { fecha: fechaKey, ventas: 0, rent: 0 };
      prev.ventas += ventasDia;
      prev.rent   += rentDia;
      evoMap.set(fechaKey, prev);
    });

    const evolution = Array.from(evoMap.values())
      .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

    return res.json({ report, products, evolution });

  } catch (e) {
    console.error('DASHBOARD ERROR:', e);
    return res.status(500).json({ error: 'Error en el cálculo de estadísticas' });
  }
});

// --------------------------------------------------
// CLIENTES 
// --------------------------------------------------

// 1. Obtener listado completo (Campos ampliados)
app.get('/api/clientes/master', withAuth, checkLicencia, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    const empresaId = esSuper && req.query.empresa_id 
      ? Number(req.query.empresa_id) 
      : getEmpresaIdFromToken(req);

    const rows = await query(`
      SELECT *
      FROM puntos_entrega
      WHERE empresa_id = $1
      ORDER BY cliente ASC
    `, [empresaId]);
    
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo clientes' });
  }
});

app.get('/api/clientes/buscar', withAuth, checkLicencia, async (req, res) => {
  try {
    const esSuper = isSuper(req);
    const empresaId = esSuper && req.query.empresa_id 
      ? Number(req.query.empresa_id) 
      : getEmpresaIdFromToken(req);

    const termino = req.query.q || '';
    
    // Validación rápida: si no hay término o es muy corto, devolver array vacío
    if (termino.length < 2) {
      return res.json([]); 
    }

    // Buscamos en varios campos usando ILIKE (insensible a mayúsculas/minúsculas)
    // Limitamos a 20 resultados para no sobrecargar la red
    const sql = `
      SELECT 
        id, 
        cliente, 
        direccion, 
        ciudad, 
        telefono, 
        razon_social, 
        cuit
      FROM puntos_entrega
      WHERE empresa_id = $1
        AND (
             cliente      ILIKE $2 OR 
             direccion    ILIKE $2 OR 
             telefono     ILIKE $2 OR 
             razon_social ILIKE $2 OR 
             cuit         ILIKE $2
        )
      ORDER BY cliente ASC
      LIMIT 20
    `;

    const rows = await query(sql, [empresaId, `%${termino}%`]);
    res.json(rows);

  } catch (e) {
    console.error('Error en búsqueda de clientes:', e);
    res.status(500).json({ error: 'Error buscando clientes' });
  }
});

app.post('/api/clientes', withAuth, async (req, res) => {
  try {
    const { 
      cliente, telefono, direccion, ciudad, provincia, pais, 
      latitud, longitud, notas, empresa_id, zona_id,
      razon_social, cuit, condicion_iva
    } = req.body;

    const esSuper = isSuper(req);
    const targetEmpresa = (esSuper && empresa_id) ? Number(empresa_id) : getEmpresaIdFromToken(req);

    if (!targetEmpresa) return res.status(400).json({ error: 'Empresa requerida' });
    if (!cliente) return res.status(400).json({ error: 'Nombre del cliente requerido' });

    const telNorm = telefono ? normalizePhone(telefono) : null;

    const rows = await query(`
      INSERT INTO puntos_entrega (
        cliente, telefono, telefono_normalizado, direccion,
        ciudad, provincia, pais, latitud, longitud, notas,
        empresa_id, zona_id,
        razon_social, cuit, condicion_iva
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, $13, $14, $15)
      RETURNING id
    `, [
      cliente, telefono || null, telNorm, direccion || null,
      ciudad || null, provincia || null, pais || 'Argentina',
      latitud ? Number(latitud) : null, longitud ? Number(longitud) : null, notas || null,
      targetEmpresa, zona_id ? Number(zona_id) : null,
      razon_social || null, cuit || null, condicion_iva || null
    ]);

    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('Error creando cliente:', e);
    res.status(500).json({ error: 'Error al crear cliente' });
  }
});

app.put('/api/clientes/:id', withAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      cliente, telefono, direccion, ciudad, provincia, pais, 
      latitud, longitud, notas, empresa_id, zona_id,
      razon_social, cuit, condicion_iva
    } = req.body;
    
    const esSuper = isSuper(req);
    const myEmpresa = getEmpresaIdFromToken(req);

    if (!esSuper) {
        const check = await query('SELECT id FROM puntos_entrega WHERE id=$1 AND empresa_id=$2', [id, myEmpresa]);
        if (check.length === 0) return res.status(403).json({ error: 'No autorizado' });
    }

    const sets = [];
    const vals = [];
    let idx = 1;

    const add = (field, val) => { sets.push(`${field}=$${idx++}`); vals.push(val); };

    if (cliente !== undefined) add('cliente', cliente);
    if (telefono !== undefined) {
      add('telefono', telefono);
      add('telefono_normalizado', telefono ? normalizePhone(telefono) : null);
    }
    if (direccion !== undefined) add('direccion', direccion);
    if (ciudad !== undefined) add('ciudad', ciudad);
    if (provincia !== undefined) add('provincia', provincia);
    if (pais !== undefined) add('pais', pais);
    if (latitud !== undefined) add('latitud', latitud ? Number(latitud) : null);
    if (longitud !== undefined) add('longitud', longitud ? Number(longitud) : null);
    if (notas !== undefined) add('notas', notas);
    if (esSuper && empresa_id !== undefined) add('empresa_id', Number(empresa_id));
    if (zona_id !== undefined) add('zona_id', zona_id ? Number(zona_id) : null);
    
    // Nuevos campos
    if (razon_social !== undefined) add('razon_social', razon_social);
    if (cuit !== undefined) add('cuit', cuit);
    if (condicion_iva !== undefined) add('condicion_iva', condicion_iva);

    if (sets.length === 0) return res.json({ ok: true });

    // Seguridad multi-tenant: filtrar en SQL también (no solo en el check previo)
    vals.push(id);
    const tenantParam = esSuper ? null : Number(myEmpresa);
    vals.push(tenantParam);

    await query(
      `UPDATE puntos_entrega SET ${sets.join(', ')} WHERE id=$${idx} AND ($${idx + 1}::int IS NULL OR empresa_id=$${idx + 1})`,
      vals
    );
    res.json({ ok: true });

  } catch (e) {
    console.error('Error actualizando cliente:', e);
    res.status(500).json({ error: 'Error al actualizar cliente' });
  }
});

app.delete('/api/clientes/:id', withAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const esSuper = isSuper(req);
    const myEmpresa = getEmpresaIdFromToken(req);

    const checkSql = esSuper 
      ? 'SELECT id, empresa_id FROM puntos_entrega WHERE id=$1' 
      : 'SELECT id, empresa_id FROM puntos_entrega WHERE id=$1 AND empresa_id=$2';
    
    const check = await query(checkSql, esSuper ? [id] : [id, myEmpresa]);
    if (!check.length) return res.status(404).json({ error: 'Cliente no encontrado' });

    const targetEmpresa = Number(check[0].empresa_id);

    // Borrado tenant-safe (evita borrar pedidos de otra empresa por accidente)
    await query(`DELETE FROM pedidos WHERE punto_entrega_id=$1 AND empresa_id=$2`, [id, targetEmpresa]);
    await query(`DELETE FROM puntos_entrega WHERE id=$1 AND empresa_id=$2`, [id, targetEmpresa]);

    res.json({ ok: true });
  } catch (e) {
    console.error('Error delete cliente:', e);
    res.status(500).json({ error: 'Error eliminando cliente' });
  }
});

// --------------------------------------------------
// ENDPOINT DE TRACKING (Necesario para el Repartidor)
// --------------------------------------------------

app.post('/api/track/update', withAuth, async (req, res) => {
  try {
    const { pedido_id, lat, lng } = req.body;
    const choferId = req.user?.chofer_id;
    const empresaId = req.user?.empresa_id;

    if (!choferId) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const pid = Number(pedido_id);
    const latN = Number(lat);
    const lngN = Number(lng);

    if (!Number.isFinite(pid) || !Number.isFinite(latN) || !Number.isFinite(lngN)) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }

    // 1) Validar que el pedido sea del chofer y de la misma empresa
    const pedRows = await query(`
      SELECT empresa_id, chofer_id
      FROM pedidos
      WHERE id = $1
        AND empresa_id = $2
      LIMIT 1
    `, [pid, empresaId]);

    if (!pedRows.length) {
      // si no está, puede ser inexistente o de otra empresa → no filtramos info
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const ped = pedRows[0];
    if (ped.chofer_id !== choferId) {
      return res.status(403).json({ error: 'No puedes actualizar este pedido' });
    }

    // 2) Insertar punto en historial
    await query(`
      INSERT INTO pedido_track_points (pedido_id, latitud, longitud, timestamp, source, precision, speed, heading)
      VALUES ($1, $2, $3, NOW(), 'gps', 0, 0, 0)
    `, [pid, latN, lngN]);

    res.json({ ok: true });
  } catch (e) {
    console.error('TRACK UPDATE ERROR:', e);
    res.status(500).json({ error: 'Error guardando ubicación' });
  }
});

/**
 * Genera token (si no existe) y envía WPP de 'En Ruta' **solo la primera vez**
 */

async function notificarEnRuta(pedidoId, empresaId) {
  try {
    // 1. Buscamos datos Y el token existente
    const rows = await query(`
      SELECT 
        p.id, 
        p.monto, 
        p.tracking_token,           -- token actual (si ya se generó antes)
        pe.cliente, 
        pe.telefono, 
        pe.direccion,
        e.landing_domain, 
        e.landing_slug
      FROM pedidos p
      JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      JOIN empresas e        ON e.id = pe.empresa_id
      WHERE p.id = $1 AND pe.empresa_id = $2
    `, [pedidoId, empresaId]);

    if (!rows.length) return;
    const datos = rows[0];

    // 2) Saber si ya tenía token (ya se envió link alguna vez)
    let token = datos.tracking_token;
    const yaTeniaToken = !!token;

    // Si no tenía token, lo generamos y lo guardamos
    if (!token) {
      token = crypto.randomBytes(16).toString('hex');
      await query(
        `UPDATE pedidos SET tracking_token = $1 WHERE id = $2 AND empresa_id = $3`,
        [token, pedidoId, empresaId]
      );
    }

    // 3) Armar URL de tracking (siempre reutilizamos el mismo token)
    let host = datos.landing_domain || 'https://aguahidro.com.ar';
    if (!host.startsWith('http')) host = 'https://' + host;

    const trackingUrl = `${host}/pedidos/seguimiento.html?t=${token}`;

    // 4) Si el pedido YA tenía token, asumimos que el link ya fue enviado
    //    -> NO reenviamos el WhatsApp para evitar mensajes duplicados.
    if (yaTeniaToken) {
      if (process.env.DEBUG_ORDERS === '1') {
        console.log(
          `[TRACKING] Pedido ${pedidoId} ya tenía tracking_token, no reenvío link`
        );
      }
      return;
    }

    // 5) Primera vez: armamos y enviamos el mensaje
    const mensaje =
      `🚚 *¡Tu pedido está en camino!*\n\n` +
      `Hola ${datos.cliente}, tu pedido ya salió hacia ${datos.direccion}.\n\n` +
      `🗺️ *Seguí al repartidor en vivo aquí:*\n${trackingUrl}\n\n` +
      `¡Nos vemos pronto! 👋`;

    await enqueueWppMessage({
      phone: datos.telefono,
      message: mensaje,
      empresa_id: empresaId
    });

  } catch (e) {
    console.error('Error enviando notificación en ruta:', e);
  }
}

/**
 * Notifica al cliente que su pedido se pagará por transferencia,
 * busca la cuenta principal (por prioridad) de empresa_cuentas_bancarias
 * y muestra el alias (y otros datos si existen).
 */

async function notificarPedidoTransferencia(pedidoId, empresaId) {
  try {
    // 1) Datos del pedido + cliente + empresa
    const rows = await query(`
      SELECT 
        p.id,
        p.monto,
        pe.cliente,
        pe.telefono,
        pe.direccion,
        e.nombre AS empresa_nombre,
        e.id    AS empresa_id
      FROM pedidos p
      JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      JOIN empresas e        ON e.id = pe.empresa_id
      WHERE p.id = $1 AND pe.empresa_id = $2
    `, [pedidoId, empresaId]);

    if (!rows.length) return;

    const datos = rows[0];
    if (!datos.telefono) return;

    // 2) Buscar la cuenta principal (por prioridad) de esa empresa
    const cuentas = await query(`
      SELECT alias, banco, tipo, cbu, titular
      FROM empresa_cuentas_bancarias
      WHERE empresa_id = $1
        AND activa = TRUE
      ORDER BY prioridad DESC, id ASC
      LIMIT 1
    `, [empresaId]);

    const cuenta = cuentas[0]; // puede ser undefined si no hay cuentas

    // 3) Formatear monto
    const montoNumber = Number(datos.monto || 0);
    const montoFmt = new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 2
    }).format(montoNumber);

    const empresaLabel = datos.empresa_nombre || 'Hidro';

    // 4) Armar el mensaje
    let mensaje =
      `🏦 *Pago por transferencia*\n\n` +
      `Hola ${datos.cliente || ''}, tu pedido fue marcado para pagar por *transferencia* (${montoFmt}).\n\n`;

    // 4.1. Si encontramos una cuenta bancaria principal, mostramos sus datos
    if (cuenta) {
      const alias   = (cuenta.alias   || '').trim();
      const banco   = (cuenta.banco   || '').trim();
      const cbu     = (cuenta.cbu     || '').trim();
      const titular = (cuenta.titular || '').trim();

      mensaje += `💳 *Datos para transferir:*\n`;

      // 👉 alias principal (lo que te interesaba)
      if (alias) {
        mensaje += `Alias: ${alias}\n`;
      }

      // Extras útiles si están cargados (podés borrar lo que no quieras)
      if (cbu) {
        mensaje += `CBU: ${cbu}\n`;
      }
      if (banco) {
        mensaje += `Banco: ${banco}\n`;
      }
      if (titular) {
        mensaje += `Titular: ${titular}\n`;
      }

      mensaje += `\n`;
    }

    // 4.2. Cierre del mensaje
    mensaje +=
      `Por favor, adjuntá el *comprobante de transferencia* respondiendo a este mensaje ` +
      `para poder acreditar el pago.\n\n` +
      `¡Muchas gracias!\n${empresaLabel}`;

    // 5) Encolar mensaje de WhatsApp
    await enqueueWppMessage({
      phone: datos.telefono,
      message: mensaje,
      empresa_id: empresaId
    });
  } catch (e) {
    console.error('Error enviando notificación de pago por transferencia:', e);
  }
}

// ==================================================
// 💰 SISTEMA DE COBRO DE LICENCIAS (Mercado Pago)
// ==================================================

/**
 * 1. GENERAR PAGO
 * Endpoint privado: Lo llama el admin desde el panel para pedir su link.
 */
app.post('/api/admin/licencia/generar-pago', withAuth, async (req, res) => {
  try {
    const empresaId = req.user.empresa_id; //
    
    // 1. Buscamos datos frescos de la empresa
    const rows = await query(
      'SELECT nombre, telefono, email, plan_precio FROM empresas WHERE id = $1', 
      [empresaId]
    );
    
    if (!rows.length) return res.status(404).json({ error: 'Empresa no encontrada' });
    
    const emp = rows[0];
    const precio = Number(emp.plan_precio);

    // 2. Validación de seguridad: Precio debe existir
    if (!precio || precio <= 0) {
      return res.status(400).json({ 
        error: 'Tu plan no tiene un precio configurado. Por favor contacta a soporte.' 
      });
    }

    // 3. Llamamos al servicio para crear la preferencia en MP
    const linkPago = await crearPreferenciaLicencia({
      empresaId,
      nombreEmpresa: emp.nombre,
      precio: precio,
      email: emp.email
    });

    // 4. Enviamos el link por WhatsApp al dueño
    if (emp.telefono) {
      const msg = 
        `👋 Hola *${emp.nombre}*.\n\n` +
        `Para reactivar o renovar tu licencia de uso, por favor realizá el pago en el siguiente link:\n\n` +
        `🔗 ${linkPago}\n\n` +
        `💰 Monto: $${precio}\n` +
        `⏳ El sistema se activará automáticamente apenas se acredite el pago.`;

      await enqueueWppMessage({
        phone: emp.telefono,
        message: msg,
        empresa_id: empresaId
      });
    }

    // Retornamos éxito al frontend
    res.json({ ok: true, message: 'Link enviado por WhatsApp', link: linkPago });

  } catch (e) {
    console.error('[GENERAR PAGO ERROR]', e);
    res.status(500).json({ error: 'Error interno generando el pago.' });
  }
});

/**
 * 2. WEBHOOK (LISTENER) - VERSIÓN FINAL BLINDADA + SOPORTE ALQUILERES 🛡️📜
 */
app.post('/api/webhooks/mercadopago', async (req, res) => {
  const { query, body } = req;

  // 0. Seguridad extra opcional por "secreto"
  const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;
  if (MP_WEBHOOK_SECRET) {
    const providedSecret = query.secret || req.headers['x-mp-secret'];
    if (providedSecret !== MP_WEBHOOK_SECRET) {
      console.warn('⚠️ [WEBHOOK] Notificación rechazada: secreto inválido');
      return res.sendStatus(403);
    }
  }

  const topic = query.topic || query.type;

  // 1. Detección robusta del ID de la operación
  let id = query.id || query['data.id'] || body?.data?.id;
  if (!id && query.data && query.data.id) {
    id = query.data.id;
  }

  console.log(`📩 [WEBHOOK] Tópico: ${topic} | ID: ${id}`);

  try {
    // Sólo procesamos notificaciones de pago con ID válido
    if (topic === 'payment' && id) {
      
      // 2. Consultar estado real a la API de Mercado Pago
      const pago = await obtenerPago(id);
      
      // Si el pago está aprobado, procedemos
      if (pago.status === 'approved') {
        const externalRef = pago.external_reference || '';
        const montoPagado = pago.transaction_amount;
        const referenciaPago = String(id);

        console.log(`🔄 [DB] Procesando pago aprobado. Ref: ${externalRef} | Monto: ${montoPagado}`);

        // ============================================================
        // 🔒 INICIO DE TRANSACCIÓN CRÍTICA
        // ============================================================
        await query('BEGIN');

        try {
            // ------------------------------------------------------------
            // PASO A: DETERMINAR EL TIPO DE PAGO Y LA EMPRESA
            // ------------------------------------------------------------
            let empresaId = 0;
            let esAlquiler = false;

            // Lógica de detección: ¿Es Alquiler (ALQ|...) o Licencia (ID numérico)?
            if (externalRef.startsWith('ALQ')) {
                esAlquiler = true;
                // Formato esperado: ALQ|emp:1|cli:5|per:01/2026
                const parts = externalRef.split('|');
                const empPart = parts.find(p => p.startsWith('emp:'));
                if (empPart) empresaId = Number(empPart.split(':')[1]);
            } else {
                // Caso Licencia: la referencia es solo el ID de la empresa
                empresaId = Number(externalRef);
            }

            // Sanity check de empresaId
            if (!Number.isInteger(empresaId) || empresaId <= 0) {
                console.error(`❌ [WEBHOOK] ID de empresa inválido en referencia: ${externalRef}`);
                await query('ROLLBACK');
                return res.sendStatus(200); // Respondemos OK para que MP no reintente con basura
            }

            // ------------------------------------------------------------
            // PASO B: IDEMPOTENCIA (Bloqueo de duplicados)
            // ------------------------------------------------------------
            // Insertamos en historial_pagos. Si el ID de MP ya existe, esto fallará
            // y saltará al catch (code 23505), evitando procesar dos veces.
            await query(`
                INSERT INTO historial_pagos (empresa_id, monto, referencia, fecha, metodo, estado)
                VALUES ($1, $2, $3, NOW(), 'mercadopago', 'approved')
            `, [empresaId, montoPagado, referenciaPago]);


            // ------------------------------------------------------------
            // PASO C: APLICAR LÓGICA SEGÚN TIPO
            // ------------------------------------------------------------
            
            if (esAlquiler) {
                // === LÓGICA DE ALQUILER ===
                // Parsear referencia: ALQ|emp:1|cli:5|per:05/2025
                const parts = externalRef.split('|');
                const cliStr = parts.find(p => p.startsWith('cli:'))?.split(':')[1];
                const perStr = parts.find(p => p.startsWith('per:'))?.split(':')[1]; // Ej: "05/2025"

                if (cliStr && perStr) {
                    // Convertir "05/2025" a formato fecha ISO "2025-05-01" para PostgreSQL
                    const [mes, anio] = perStr.split('/');
                    const periodoDate = `${anio}-${mes}-01`;
                    const clienteId = Number(cliStr);

                    // Actualizar estado del alquiler a 'cobrado'
                    const upd = await query(`
                        UPDATE empresa_activos_alquileres
                        SET estado = 'cobrado',
                            ultimo_pago_fecha = NOW(),
                            ultimo_pago_monto = $4,
                            updated_at = NOW()
                        WHERE empresa_id = $1
                          AND cliente_id = $2
                          AND periodo = $3::date
                        RETURNING id
                    `, [empresaId, clienteId, periodoDate, montoPagado]);

                    if (upd.length > 0) {
                        console.log(`✅ [ALQUILER] Alquiler ID ${upd[0].id} marcado como cobrado.`);
                    } else {
                        console.warn(`⚠️ [ALQUILER] No se encontró el registro de alquiler para ${externalRef}. Se guardó el pago en historial pero no se actualizó el estado.`);
                    }
                }

            } else {
                // === LÓGICA DE LICENCIA (SaaS) ===
                // Extendemos la licencia 30 días
                const result = await query(`
                    UPDATE empresas
                       SET plan_estado = 'active',
                           plan_vencimiento = CASE
                             WHEN plan_vencimiento > NOW() THEN plan_vencimiento + INTERVAL '30 days'
                             ELSE NOW() + INTERVAL '30 days'
                           END
                     WHERE id = $1
                     RETURNING id, nombre, plan_vencimiento, telefono
                `, [empresaId]);

                if (result.length === 0) {
                     throw new Error(`Empresa ID ${empresaId} no encontrada para actualizar licencia.`);
                }

                // Notificación WhatsApp al dueño de la empresa
                const emp = result[0];
                if (emp.telefono) {
                    const nuevaFecha = new Date(emp.plan_vencimiento).toLocaleDateString('es-AR');
                    const msgExito =
                      `✅ *¡Pago de Licencia Acreditado!*\n\n` +
                      `Tu servicio ha sido renovado correctamente.\n` +
                      `📅 *Nuevo Vencimiento:* ${nuevaFecha}\n\n` +
                      `Gracias por confiar en nosotros. 🚀`;

                    await enqueueWppMessage({
                      phone: emp.telefono,
                      message: msgExito,
                      empresa_id: empresaId
                    });
                }
                console.log(`✅ [LICENCIA] Licencia actualizada para empresa ${empresaId}`);
            }

            // ------------------------------------------------------------
            // PASO D: CONFIRMAR TRANSACCIÓN
            // ------------------------------------------------------------
            await query('COMMIT');
            console.log(`🏁 [DB] Transacción finalizada con éxito.`);

        } catch (dbErr) {
          // 🛑 REVERTIR TODO SI HUBO ERROR O DUPLICADO
          await query('ROLLBACK');

          // Código 23505 es violation de unique constraint en PostgreSQL (Pago Duplicado)
          if (dbErr.code === '23505') {
            console.log(`🔁 [WEBHOOK] Idempotencia: El pago ${id} ya estaba registrado. No se realizaron cambios.`);
          } else {
            console.error('❌ [WEBHOOK DB ERROR]', dbErr);
            throw dbErr; // Relanzar para registro global de errores
          }
        }

      } else {
        console.log('⚠️ [WEBHOOK] El pago no está aprobado, estado:', pago.status);
      }
    } else {
      if (topic !== 'merchant_order') {
        console.log(`⏩ [WEBHOOK] Ignorando tópico: ${topic}`);
      }
    }

    // SIEMPRE responder 200 OK a Mercado Pago rápido
    return res.sendStatus(200);

  } catch (e) {
    console.error('❌ [WEBHOOK ERROR FATAL]:', e.message);
    if (e.cause) console.error('Causa:', e.cause);
    // Igual respondemos 200 para que MP no siga reintentando eternamente si es un error interno nuestro
    return res.sendStatus(200);
  }
});

// --------------------------------------------------
// CONFIGURACIÓN GLOBAL Prompts (Solo Super Admin)
// --------------------------------------------------

// 1. Obtener Prompts Globales
app.get('/api/admin/prompts/global', withAuth, async (req, res) => {
  if (!isSuper(req)) return res.status(403).json({ error: 'Acceso denegado' });
  try {
    const rows = await query(
      `SELECT tipo, contenido, updated_at 
       FROM empresa_prompts 
       WHERE empresa_id IS NULL 
       ORDER BY tipo`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al leer configuración' });
  }
});

// 2. Guardar/Actualizar Prompt Global
app.post('/api/admin/prompts/global', withAuth, async (req, res) => {
  if (!isSuper(req)) return res.status(403).json({ error: 'Acceso denegado' });
  
  const { tipo, contenido } = req.body;
  if (!tipo || !contenido) return res.status(400).json({ error: 'Datos incompletos' });

  try {
    // Usamos Upsert compatible con el índice parcial (WHERE empresa_id IS NULL)
    await query(`
      INSERT INTO empresa_prompts (empresa_id, tipo, contenido, updated_at)
      VALUES (NULL, $1, $2, NOW())
      ON CONFLICT (tipo) WHERE empresa_id IS NULL
      DO UPDATE SET 
        contenido = EXCLUDED.contenido,
        updated_at = NOW()
    `, [tipo, contenido]);

    res.json({ ok: true });
  } catch (e) {
    console.error('Error guardando prompt global:', e);
    res.status(500).json({ error: 'Error al guardar' });
  }
});

// 3. Eliminar Prompt Global (Volver a hardcoded)
app.delete('/api/admin/prompts/global/:tipo', withAuth, async (req, res) => {
  if (!isSuper(req)) return res.status(403).json({ error: 'Acceso denegado' });
  try {
    await query(
      `DELETE FROM empresa_prompts WHERE empresa_id IS NULL AND tipo = $1`, 
      [req.params.tipo]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al eliminar' });
  }
});

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