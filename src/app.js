// src/app.js
// Crea y configura la app Express (extraído desde server.js)

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { registerLandingRoutes } from './routes/landingRoutes.js';
import { mountApiModules } from './routes/mountApiModules.js';
import { createPublicLegacyPedidosRouter } from './routes/publicLegacyPedidos.js';
import { createPublicLegacyCatalogRouter } from './routes/publicLegacyCatalog.js';
import { createPublicLegacyMarketplaceRouter } from './routes/publicLegacyMarketplace.js';
import { registerPublicLegacyCreatePedidoRoute } from './routes/publicLegacyCreatePedido.js';
import { toNum, inRange, round, buildOrderSummary, getAliasEmpresa } from './public/pedidosLegacyHelpers.js';
import { registerWhatsAppWeb } from './wpp/whatsappWeb.js';
import { assertProductionEnv } from './bootstrap/env.js';

/**
 * createApp(deps)
 * deps: inyecta implementaciones (db/query, auth, etc.) para testear fácil.
 */
export function createApp(deps) {
  const {
    projectDir,

    // core
    query,
    pool,

    // auth/tenant
    withAuth,
    isSuper,
    getEmpresaIdFromToken,
    resolveEmpresaId,

    // MP/licencias
    crearPreferenciaLicencia,
    obtenerPago,

    // repartidor helpers
    notifyEstadoPedidoPush,
    notificarEnRuta,
    notificarPedidoTransferencia,
    ejecutarEstrategiaVecinos,
    ejecutarReposicionPredictiva,
    ejecutarCampaniaClima,
    registrarMovimientosActivosDesdePedido,

    // wpp
    ENABLE_WPP,
    wpp: {
      Client,
      LocalAuth,
      qrcode,
      handlers,
      enqueueWppMessage,
      checkLicencia,
    } = {},

  } = deps || {};

  if (!projectDir) throw new Error('createApp: falta projectDir');
  if (typeof query !== 'function') throw new Error('createApp: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createApp: falta withAuth(fn)');

  const app = express();

  // Seguridad producción
  assertProductionEnv();

  app.set('trust proxy', 1);

  const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    console.warn('[security] CORS_ALLOWED_ORIGINS no configurado; CORS queda en modo compatible (abierto).');
  }

  const corsOrigin = (origin, cb) => {
    // Requests server-to-server o same-origin sin header Origin
    if (!origin) return cb(null, true);

    // Modo explícito (recomendado): allowlist por env
    if (allowedOrigins.length > 0) {
      return cb(null, allowedOrigins.includes(origin));
    }

    // Compat legacy: mantener comportamiento actual si no hay allowlist
    return cb(null, true);
  };

  app.use(cors({ origin: corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: https:",
      "font-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline' https:",
      "script-src 'self' 'unsafe-inline' https:",
      "connect-src 'self' https: ws: wss:",
    ].join('; ');

    res.set('Content-Security-Policy', csp);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  const httpMetrics = new Map();
  const METRICS_ALERT_ERROR_RATE = Number(process.env.METRICS_ALERT_ERROR_RATE || 0.2);
  const METRICS_ALERT_P95_MS = Number(process.env.METRICS_ALERT_P95_MS || 1500);

  const requireSuper = (req, res, next) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Forbidden' });
    return next();
  };
  const pushMetric = (key, ms, statusCode) => {
    const bucket = httpMetrics.get(key) || { count: 0, errors: 0, durations: [] };
    bucket.count += 1;
    if (statusCode >= 400) bucket.errors += 1;
    bucket.durations.push(ms);
    if (bucket.durations.length > 200) bucket.durations.shift();
    httpMetrics.set(key, bucket);
  };

  app.use((req, res, next) => {
    const requestId = req.headers['x-request-id'] || randomUUID();
    req.requestId = String(requestId);
    res.set('x-request-id', req.requestId);

    const startedAt = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - startedAt;
      const key = `${req.method} ${req.path}`;
      pushMetric(key, ms, res.statusCode);
      if (process.env.NODE_ENV !== 'test') {
        console.info(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms) reqId=${req.requestId}`);
      }
    });

    next();
  });

  const snapshotMetrics = () => {
    const out = {};
    for (const [key, value] of httpMetrics.entries()) {
      const sorted = [...value.durations].sort((a, b) => a - b);
      const p95Index = sorted.length ? Math.max(0, Math.ceil(sorted.length * 0.95) - 1) : 0;
      out[key] = {
        count: value.count,
        errors: value.errors,
        errorRate: value.count ? Number((value.errors / value.count).toFixed(4)) : 0,
        p95Ms: sorted.length ? sorted[p95Index] : 0,
      };
    }
    return out;
  };

  app.get('/api/metrics/http', withAuth, requireSuper, (_req, res) => {
    res.json({ ok: true, metrics: snapshotMetrics() });
  });

  app.get('/api/metrics/alerts', withAuth, requireSuper, (_req, res) => {
    const metrics = snapshotMetrics();
    const alerts = Object.entries(metrics)
      .filter(([, m]) => m.errorRate >= METRICS_ALERT_ERROR_RATE || m.p95Ms >= METRICS_ALERT_P95_MS)
      .map(([route, m]) => ({
        route,
        errorRate: m.errorRate,
        p95Ms: m.p95Ms,
        level: (m.errorRate >= METRICS_ALERT_ERROR_RATE * 2 || m.p95Ms >= METRICS_ALERT_P95_MS * 2) ? 'high' : 'medium',
      }));

    res.json({
      ok: true,
      thresholds: {
        errorRate: METRICS_ALERT_ERROR_RATE,
        p95Ms: METRICS_ALERT_P95_MS,
      },
      alerts,
    });
  });

  app.get('/api/metrics/prometheus', withAuth, requireSuper, (_req, res) => {
    const metrics = snapshotMetrics();
    const lines = [
      '# HELP hidrov1_http_requests_total Total HTTP requests by route',
      '# TYPE hidrov1_http_requests_total gauge',
      '# HELP hidrov1_http_errors_total Total HTTP errors by route',
      '# TYPE hidrov1_http_errors_total gauge',
      '# HELP hidrov1_http_p95_ms HTTP p95 latency in milliseconds by route',
      '# TYPE hidrov1_http_p95_ms gauge',
    ];

    for (const [route, m] of Object.entries(metrics)) {
      const label = route.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      lines.push(`hidrov1_http_requests_total{route="${label}"} ${m.count}`);
      lines.push(`hidrov1_http_errors_total{route="${label}"} ${m.errors}`);
      lines.push(`hidrov1_http_p95_ms{route="${label}"} ${m.p95Ms}`);
    }

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
  });

  const healthPayload = () => ({
    ok: true,
    service: 'hidro-api',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
  });

  // Health debe registrarse antes de landing catch-all
  app.get('/health', (_req, res) => res.json(healthPayload()));
  app.get('/api/health', (_req, res) => res.json(healthPayload()));

  // ==================================================
  // RUTEO INTELIGENTE (LANDINGS vs INDEX GLOBAL)
  // ==================================================
  registerLandingRoutes(app, {
    projectDir,
    query,
    withAuth,
    resolveEmpresaId,
    isSuper,
  });

  // ==================================================
  // CARPETAS ESTÁTICAS DEL SISTEMA (Carrito, etc.)
  // ==================================================
  const PEDIDOS_DIR = path.join(projectDir, 'pedidos');
  if (fs.existsSync(PEDIDOS_DIR)) app.use('/pedidos', express.static(PEDIDOS_DIR));

  const TRANSF_DIR = path.join(projectDir, 'Transferencia');
  if (!fs.existsSync(TRANSF_DIR)) fs.mkdirSync(TRANSF_DIR, { recursive: true });
  app.use('/Transferencia', express.static(TRANSF_DIR));

  const GASTOS_DIR = path.join(projectDir, 'Gastos');
  if (!fs.existsSync(GASTOS_DIR)) fs.mkdirSync(GASTOS_DIR, { recursive: true });
  app.use('/Gastos', express.static(GASTOS_DIR));

  mountApiModules(app, {
    query,
    pool,
    withAuth,
    isSuper,
    getEmpresaIdFromToken,
    resolveEmpresaId,
    crearPreferenciaLicencia,
    obtenerPago,
    notifyEstadoPedidoPush,
    notificarEnRuta,
    notificarPedidoTransferencia,
    ejecutarEstrategiaVecinos,
    registrarMovimientosActivosDesdePedido,
    TRANSF_DIR,
    GASTOS_DIR,
    getEmpresaById: deps?.getEmpresaById,
  });

  // Endpoints públicos migrados a módulos dedicados
  app.use('/public', createPublicLegacyCatalogRouter({ query }));
  app.use('/public', createPublicLegacyMarketplaceRouter({ query }));
  app.use('/public', createPublicLegacyPedidosRouter({ query }));
  registerPublicLegacyCreatePedidoRoute(app, {
    query,
    pool,
    geocodeIfNeeded: deps?.geocodeIfNeeded,
    normalizePhone: deps?.normalizePhone,
    pointInAnyZone: deps?.pointInAnyZone,
    enqueueWppMessage: deps?.enqueueWppMessage,
    toNum,
    inRange,
    round,
    buildOrderSummary,
    getAliasEmpresa,
    ejecutarEstrategiaVecinosFn: ejecutarEstrategiaVecinos,
  });

  // --------------------------------------------------
  // WhatsApp Web integrado
  // --------------------------------------------------
  registerWhatsAppWeb(app, {
    ENABLE_WPP,
    Client,
    LocalAuth,
    qrcode,
    fs,
    path,
    __dirname: projectDir,
    query,
    pool,
    handlers,
    enqueueWppMessage,
    checkLicencia,

    ejecutarReposicionPredictiva,
    ejecutarCampaniaClima,

    withAuth,
    isSuper,
  });

  // Sin fallback legacy: toda ruta pública vive en src/routes/*

  app.use((req, res) => {
    res.status(404).json({
      error: 'Not Found',
      path: req.originalUrl,
    });
  });

  app.use((err, req, res, _next) => {
    console.error('[http.error]', {
      reqId: req?.requestId,
      method: req?.method,
      path: req?.originalUrl,
      statusCode: err?.statusCode || 500,
      message: err?.message,
      stack: err?.stack,
    });
    if (res.headersSent) return;
    res.status(err?.statusCode || 500).json({
      error: err?.message || 'Internal Server Error',
      reqId: req?.requestId,
    });
  });

  return app;
}
