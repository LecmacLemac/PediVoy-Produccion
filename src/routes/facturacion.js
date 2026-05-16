import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { loginCms } from '../integrations/arca/wsaaClient.js';
import {
  buildComprobanteFromFactura,
  fecaeSolicitar,
  feCompUltimoAutorizado,
} from '../integrations/arca/wsfeClient.js';

import { withAuth, checkLicencia, isSuper, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';
import {
  cacheWsaaCredentials,
  cancelFactura,
  deleteFactura,
  ensureFacturacionSchema,
  getCachedWsaaCredentials,
  getFacturaById,
  getFacturaByPedido,
  getFacturacionConfig,
  getFacturacionConfigForArca,
  logAfipAudit,
  markFacturaEmitida,
  markFacturaRechazada,
  listFacturas,
  listPedidosFacturables,
  requestFacturaForPedido,
  upsertFacturacionConfig,
} from '../services/facturacionService.js';

export function createFacturacionRouter() {
  const router = express.Router();
  let schemaReady = false;
  const ARCA_CREDENTIALS_DIR = path.resolve(process.cwd(), 'storage', 'arca-credentials');
  const credentialsUploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 128 * 1024, files: 2 },
  });

  async function ensureSchema() {
    if (schemaReady) return;
    await ensureFacturacionSchema(query);
    schemaReady = true;
  }

  function resolveEmpresa(req) {
    if (isSuper(req)) {
      const candidate = Number(req.query?.empresa_id ?? req.body?.empresa_id);
      if (Number.isInteger(candidate) && candidate > 0) return candidate;
    }
    return Number(getEmpresaIdFromToken(req));
  }

  function sendError(res, error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error('FACTURACION.ERROR', error);
    return res.status(status).json({ error: error?.message || 'Error de facturacion' });
  }

  function publicConfig(config) {
    if (!config) return null;
    const { certificado_ref: _certificadoRef, clave_ref: _claveRef, ...safe } = config;
    return {
      ...safe,
      certificado_cargado: Boolean(config.certificado_ref),
      clave_cargada: Boolean(config.clave_ref),
    };
  }

  function assertPem(buffer, type) {
    const text = buffer?.toString('utf8') || '';
    if (type === 'certificado' && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(text)) {
      throw Object.assign(new Error('El certificado debe estar en formato PEM'), { statusCode: 400 });
    }
    if (type === 'clave' && !/-----BEGIN (RSA |EC |)PRIVATE KEY-----[\s\S]+-----END (RSA |EC |)PRIVATE KEY-----/.test(text)) {
      throw Object.assign(new Error('La clave privada debe estar en formato PEM'), { statusCode: 400 });
    }
  }

  async function saveCredentialFile({ empresaId, file, type }) {
    if (!file?.buffer?.length) return null;
    assertPem(file.buffer, type);

    const dir = path.join(ARCA_CREDENTIALS_DIR, String(empresaId));
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

    const suffix = crypto.randomBytes(8).toString('hex');
    const filename = type === 'certificado'
      ? `certificado_${suffix}.pem`
      : `clave_${suffix}.pem`;
    const target = path.join(dir, filename);
    await fs.promises.writeFile(target, file.buffer, { mode: 0o600 });
    return target;
  }

  async function resolveWsaaCredentials(empresaId, config) {
    const cached = getCachedWsaaCredentials(config);
    if (cached) return cached;

    const login = await loginCms({
      mode: config.modo_afip,
      service: 'wsfe',
      certPath: config.certificado_ref,
      keyPath: config.clave_ref,
    });
    await cacheWsaaCredentials(query, empresaId, login);
    await logAfipAudit(query, {
      empresaId,
      servicio: 'WSAA',
      operacion: 'loginCms',
      requestXml: '[WSAA loginCms CMS firmado omitido por seguridad]',
      responseXml: login.rawLoginTicketResponse,
      resultado: 'ok',
    });
    return { token: login.token, sign: login.sign, expirationTime: login.expirationTime };
  }

  router.get('/facturacion/config', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureSchema();
      const empresaId = resolveEmpresa(req);
      const config = await getFacturacionConfig(query, empresaId);
      return res.json({ ok: true, config: publicConfig(config) });
    } catch (e) {
      return sendError(res, e);
    }
  });

  router.put('/facturacion/config', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureSchema();
      const empresaId = resolveEmpresa(req);
      const config = await upsertFacturacionConfig(query, empresaId, req.body || {});
      return res.json({ ok: true, config: publicConfig(config) });
    } catch (e) {
      return sendError(res, e);
    }
  });

  router.post('/facturacion/config/credenciales', withAuth, checkLicencia, (req, res) => {
    credentialsUploader.fields([
      { name: 'certificado', maxCount: 1 },
      { name: 'clave', maxCount: 1 },
    ])(req, res, async (err) => {
      try {
        if (err) {
          const msg = String(err?.message || 'No se pudieron cargar las credenciales');
          if (msg.includes('File too large')) return res.status(400).json({ error: 'Los archivos no pueden superar 128KB' });
          return res.status(400).json({ error: msg });
        }

        await ensureSchema();
        const empresaId = resolveEmpresa(req);
        const current = await getFacturacionConfig(query, empresaId);
        if (!current) {
          return res.status(409).json({ error: 'Primero guarda la configuracion fiscal de la empresa' });
        }

        const certificadoRef = await saveCredentialFile({
          empresaId,
          file: req.files?.certificado?.[0],
          type: 'certificado',
        });
        const claveRef = await saveCredentialFile({
          empresaId,
          file: req.files?.clave?.[0],
          type: 'clave',
        });

        if (!certificadoRef && !claveRef) {
          return res.status(400).json({ error: 'Archivo requerido' });
        }

        const config = await upsertFacturacionConfig(query, empresaId, {
          ...current,
          certificado_ref: certificadoRef,
          clave_ref: claveRef,
        });

        return res.json({ ok: true, config: publicConfig(config) });
      } catch (e) {
        return sendError(res, e);
      }
    });
  });

  router.post('/facturacion/config/probar-conexion', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureSchema();
      const empresaId = resolveEmpresa(req);
      const config = await getFacturacionConfigForArca(query, empresaId);
      if (!config) return res.status(409).json({ error: 'La empresa no tiene configuracion fiscal' });

      const cached = getCachedWsaaCredentials(config);
      if (cached) {
        return res.json({
          ok: true,
          modo_afip: config.modo_afip,
          service: req.body?.service || 'wsfe',
          cached: true,
          expiration_time: cached.expirationTime,
        });
      }

      const login = await loginCms({
        mode: config.modo_afip,
        service: req.body?.service || 'wsfe',
        certPath: config.certificado_ref,
        keyPath: config.clave_ref,
      });

      await cacheWsaaCredentials(query, empresaId, login);
      await logAfipAudit(query, {
        empresaId,
        servicio: 'WSAA',
        operacion: 'loginCms',
        requestXml: '[WSAA loginCms CMS firmado omitido por seguridad]',
        responseXml: login.rawLoginTicketResponse,
        resultado: 'ok',
      });

      return res.json({
        ok: true,
        modo_afip: config.modo_afip,
        endpoint: login.endpoint,
        generation_time: login.generationTime,
        expiration_time: login.expirationTime,
      });
    } catch (e) {
      try {
        const empresaId = resolveEmpresa(req);
        await logAfipAudit(query, {
          empresaId,
          servicio: 'WSAA',
          operacion: 'loginCms',
          resultado: 'error',
          errorMensaje: e?.message || String(e),
        });
      } catch {
        // no bloquear la respuesta por un fallo secundario de auditoria
      }
      return sendError(res, e);
    }
  });

  router.post('/pedidos/:pedidoId/factura/solicitar', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureSchema();
      const pedidoId = Number(req.params.pedidoId);
      if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
        return res.status(400).json({ error: 'Pedido invalido' });
      }

      const empresaId = resolveEmpresa(req);
      const factura = await requestFacturaForPedido(query, {
        pedidoId,
        empresaId,
        userId: req.user?.id || null,
        datosFiscales: req.body?.datos_fiscales || req.body || {},
      });
      return res.status(201).json({ ok: true, factura });
    } catch (e) {
      return sendError(res, e);
    }
  });

  router.get('/pedidos/:pedidoId/factura', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureSchema();
      const pedidoId = Number(req.params.pedidoId);
      if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
        return res.status(400).json({ error: 'Pedido invalido' });
      }

      const empresaId = resolveEmpresa(req);
      const factura = await getFacturaByPedido(query, { pedidoId, empresaId });
      if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
      return res.json({ ok: true, factura });
    } catch (e) {
      return sendError(res, e);
    }
  });

  router.get('/facturas', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureSchema();
      const empresaId = resolveEmpresa(req);
      const rows = await listFacturas(query, {
        empresaId,
        estado: req.query?.estado,
        limit: req.query?.limit,
      });
      return res.json({ ok: true, facturas: rows });
    } catch (e) {
      return sendError(res, e);
    }
  });

  router.get('/facturacion/pedidos', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureSchema();
      const empresaId = resolveEmpresa(req);
      const rows = await listPedidosFacturables(query, {
        empresaId,
        from: req.query?.from,
        to: req.query?.to,
        estadoFactura: req.query?.estado_factura,
        q: req.query?.q,
        limit: req.query?.limit,
      });

      const total = rows[0]?.total_count || 0;
      return res.json({
        ok: true,
        total,
        pedidos: rows.map(({ total_count: _total, ...row }) => row),
      });
    } catch (e) {
      return sendError(res, e);
    }
  });

  router.get('/facturas/:id', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureSchema();
      const facturaId = Number(req.params.id);
      if (!Number.isInteger(facturaId) || facturaId <= 0) {
        return res.status(400).json({ error: 'Factura invalida' });
      }

      const empresaId = resolveEmpresa(req);
      const factura = await getFacturaById(query, { facturaId, empresaId });
      if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
      return res.json({ ok: true, factura });
    } catch (e) {
      return sendError(res, e);
    }
  });

  router.post('/facturas/:id/emitir', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureSchema();
      const facturaId = Number(req.params.id);
      if (!Number.isInteger(facturaId) || facturaId <= 0) {
        return res.status(400).json({ error: 'Factura invalida' });
      }

      const empresaId = resolveEmpresa(req);
      const config = await getFacturacionConfigForArca(query, empresaId);
      if (!config) return res.status(409).json({ error: 'La empresa no tiene configuracion fiscal' });
      if (config.modo_afip !== 'homologacion') {
        return res.status(409).json({
          error: 'Emision en produccion bloqueada hasta validacion contable/operativa',
        });
      }

      const factura = await getFacturaById(query, { facturaId, empresaId });
      if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
      if (factura.estado === 'emitida') return res.json({ ok: true, factura, already_emitted: true });
      if (!factura.codigo_comprobante_afip || !factura.importe_total) {
        return res.status(400).json({ error: 'Factura incompleta para emitir' });
      }

      const auth = await resolveWsaaCredentials(empresaId, config);
      const ultimo = await feCompUltimoAutorizado({
        mode: config.modo_afip,
        token: auth.token,
        sign: auth.sign,
        cuit: config.cuit,
        puntoVenta: config.punto_venta,
        tipoComprobante: factura.codigo_comprobante_afip,
      });
      await logAfipAudit(query, {
        empresaId,
        facturaId,
        servicio: 'WSFEv1',
        operacion: 'FECompUltimoAutorizado',
        requestXml: ultimo.requestXml,
        responseXml: ultimo.responseXml,
        resultado: 'ok',
      });

      const comprobante = buildComprobanteFromFactura({
        factura,
        config,
        lastNumber: ultimo.cbteNro,
      });
      const cae = await fecaeSolicitar({
        mode: config.modo_afip,
        token: auth.token,
        sign: auth.sign,
        cuit: config.cuit,
        comprobante,
      });
      await logAfipAudit(query, {
        empresaId,
        facturaId,
        servicio: 'WSFEv1',
        operacion: 'FECAESolicitar',
        requestXml: cae.requestXml,
        responseXml: cae.responseXml,
        resultado: cae.resultado || 'sin_resultado',
        errorMensaje: cae.errors?.length ? cae.errors.map((e) => e.msg).join('; ') : null,
      });

      if (cae.resultado !== 'A' || !cae.cae) {
        await markFacturaRechazada(query, {
          facturaId,
          empresaId,
          errorCodigo: cae.errors?.[0]?.code || cae.observations?.[0]?.code || null,
          errorMensaje: cae.errors?.[0]?.msg || cae.observations?.[0]?.msg || 'AFIP/ARCA no aprobo el comprobante',
        });
        return res.status(409).json({ ok: false, resultado: cae.resultado, errors: cae.errors, observations: cae.observations });
      }

      await markFacturaEmitida(query, {
        facturaId,
        empresaId,
        userId: req.user?.id || null,
        numeroComprobante: cae.cbteDesde,
        cae: cae.cae,
        caeVencimiento: cae.caeFchVto,
      });
      const emitted = await getFacturaById(query, { facturaId, empresaId });
      return res.json({ ok: true, factura: emitted, wsfe: { resultado: cae.resultado, observations: cae.observations } });
    } catch (e) {
      try {
        const empresaId = resolveEmpresa(req);
        await logAfipAudit(query, {
          empresaId,
          facturaId: Number(req.params.id) || null,
          servicio: 'WSFEv1',
          operacion: 'emitir',
          resultado: 'error',
          errorMensaje: e?.message || String(e),
        });
      } catch {
        // no bloquear la respuesta por un fallo secundario de auditoria
      }
      return sendError(res, e);
    }
  });

  router.post('/facturas/:id/cancelar', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureSchema();
      const facturaId = Number(req.params.id);
      if (!Number.isInteger(facturaId) || facturaId <= 0) {
        return res.status(400).json({ error: 'Factura invalida' });
      }

      const empresaId = resolveEmpresa(req);
      const factura = await cancelFactura(query, { facturaId, empresaId });
      if (!factura) {
        return res.status(409).json({ error: 'Solo se pueden cancelar facturas pendientes o rechazadas' });
      }
      return res.json({ ok: true, factura });
    } catch (e) {
      return sendError(res, e);
    }
  });

  router.delete('/facturas/:id', withAuth, checkLicencia, async (req, res) => {
    try {
      await ensureSchema();
      const facturaId = Number(req.params.id);
      if (!Number.isInteger(facturaId) || facturaId <= 0) {
        return res.status(400).json({ error: 'Factura invalida' });
      }

      const empresaId = resolveEmpresa(req);
      const factura = await deleteFactura(query, { facturaId, empresaId });
      if (!factura) {
        return res.status(409).json({ error: 'Solo se pueden eliminar facturas pendientes o rechazadas' });
      }
      return res.json({ ok: true, deleted: true, factura });
    } catch (e) {
      return sendError(res, e);
    }
  });

  return router;
}
