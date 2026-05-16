import crypto from 'node:crypto';

const VALID_AFIP_MODES = new Set(['homologacion', 'produccion']);
const VALID_ESTADOS = new Set(['borrador', 'pendiente_confirmacion', 'emitiendo', 'emitida', 'rechazada', 'anulada']);
const PEDIDOS_NO_FACTURABLES = new Set(['cancelado', 'cancelada', 'cancelled', 'canceled']);

export function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

export function normalizeFiscalDoc(value) {
  return digitsOnly(value).slice(0, 11);
}

export function isValidCuit(value) {
  const cuit = normalizeFiscalDoc(value);
  if (!/^\d{11}$/.test(cuit)) return false;

  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, weight, idx) => acc + Number(cuit[idx]) * weight, 0);
  const mod = 11 - (sum % 11);
  const checkDigit = mod === 11 ? 0 : mod === 10 ? 9 : mod;
  return checkDigit === Number(cuit[10]);
}

export function normalizeAfipMode(value) {
  const mode = String(value || 'homologacion').trim().toLowerCase();
  return VALID_AFIP_MODES.has(mode) ? mode : 'homologacion';
}

export function normalizeEstado(value) {
  const estado = String(value || '').trim().toLowerCase();
  return VALID_ESTADOS.has(estado) ? estado : null;
}

export function isPedidoEstadoFacturable(value) {
  const estado = String(value || '').trim().toLowerCase();
  return !PEDIDOS_NO_FACTURABLES.has(estado);
}

export function resolveTipoComprobante({ emisorCondicionIva, receptorCondicionIva }) {
  const emisor = String(emisorCondicionIva || '').toLowerCase();
  const receptor = String(receptorCondicionIva || '').toLowerCase();

  if (emisor.includes('mono')) return { tipo: 'C', codigo: 11 };
  if (emisor.includes('responsable') && receptor.includes('responsable')) return { tipo: 'A', codigo: 1 };
  if (emisor.includes('responsable')) return { tipo: 'B', codigo: 6 };
  return { tipo: 'C', codigo: 11 };
}

export function calculateInvoiceTotals(items = [], { ivaRate = 0 } = {}) {
  const normalizedItems = items.map((item) => {
    const cantidad = Number(item.cantidad) || 0;
    const precioUnitario = Number(item.precio_unitario) || 0;
    const importeTotal = roundMoney(cantidad * precioUnitario);
    const alicuotaIva = Number(item.alicuota_iva ?? ivaRate) || 0;
    const importeNeto = alicuotaIva > 0
      ? roundMoney(importeTotal / (1 + alicuotaIva / 100))
      : importeTotal;
    const importeIva = roundMoney(importeTotal - importeNeto);

    return {
      producto_id: item.producto_id || null,
      descripcion: String(item.descripcion || item.producto || 'Item').trim(),
      cantidad,
      precio_unitario: precioUnitario,
      alicuota_iva: alicuotaIva,
      importe_neto: importeNeto,
      importe_iva: importeIva,
      importe_total: importeTotal,
    };
  });

  return {
    items: normalizedItems,
    importe_neto: roundMoney(normalizedItems.reduce((acc, item) => acc + item.importe_neto, 0)),
    importe_iva: roundMoney(normalizedItems.reduce((acc, item) => acc + item.importe_iva, 0)),
    importe_total: roundMoney(normalizedItems.reduce((acc, item) => acc + item.importe_total, 0)),
  };
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export async function ensureFacturacionSchema(query) {
  await query(`
    ALTER TABLE puntos_entrega
      ADD COLUMN IF NOT EXISTS requiere_factura BOOLEAN DEFAULT FALSE
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS empresa_facturacion_config (
      id BIGSERIAL PRIMARY KEY,
      empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      cuit TEXT NOT NULL,
      razon_social TEXT,
      condicion_iva TEXT,
      punto_venta INT NOT NULL,
      modo_afip TEXT NOT NULL DEFAULT 'homologacion',
      certificado_ref TEXT,
      clave_ref TEXT,
      wsaa_token_encrypted TEXT,
      wsaa_sign_encrypted TEXT,
      wsaa_expires_at TIMESTAMPTZ,
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_empresa_facturacion_config_empresa UNIQUE (empresa_id),
      CONSTRAINT chk_empresa_facturacion_config_modo
        CHECK (modo_afip IN ('homologacion', 'produccion'))
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS cliente_datos_fiscales (
      id BIGSERIAL PRIMARY KEY,
      empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      punto_entrega_id INT REFERENCES puntos_entrega(id) ON DELETE SET NULL,
      tipo_documento TEXT NOT NULL DEFAULT 'CUIT',
      numero_documento TEXT NOT NULL,
      razon_social TEXT NOT NULL,
      condicion_iva TEXT,
      domicilio_fiscal TEXT,
      email_facturacion TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_cliente_datos_fiscales_cliente UNIQUE (empresa_id, punto_entrega_id)
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_cliente_datos_fiscales_empresa_doc
      ON cliente_datos_fiscales (empresa_id, numero_documento)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS facturas (
      id BIGSERIAL PRIMARY KEY,
      empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      pedido_id INT REFERENCES pedidos(id) ON DELETE SET NULL,
      punto_entrega_id INT REFERENCES puntos_entrega(id) ON DELETE SET NULL,
      cliente_datos_fiscales_id BIGINT REFERENCES cliente_datos_fiscales(id) ON DELETE SET NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente_confirmacion',
      modo_afip TEXT NOT NULL DEFAULT 'homologacion',
      tipo_comprobante TEXT,
      codigo_comprobante_afip INT,
      punto_venta INT,
      numero_comprobante BIGINT,
      concepto TEXT NOT NULL DEFAULT 'productos',
      fecha_comprobante DATE,
      importe_neto NUMERIC(12,2) NOT NULL DEFAULT 0,
      importe_iva NUMERIC(12,2) NOT NULL DEFAULT 0,
      importe_total NUMERIC(12,2) NOT NULL DEFAULT 0,
      cae TEXT,
      cae_vencimiento DATE,
      pdf_url TEXT,
      error_codigo TEXT,
      error_mensaje TEXT,
      created_by INT REFERENCES usuarios(id) ON DELETE SET NULL,
      emitted_by INT REFERENCES usuarios(id) ON DELETE SET NULL,
      emitted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_facturas_estado
        CHECK (estado IN ('borrador', 'pendiente_confirmacion', 'emitiendo', 'emitida', 'rechazada', 'anulada')),
      CONSTRAINT chk_facturas_modo
        CHECK (modo_afip IN ('homologacion', 'produccion'))
    )
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_facturas_pedido_unica
      ON facturas (empresa_id, pedido_id)
      WHERE pedido_id IS NOT NULL AND estado <> 'anulada'
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_facturas_empresa_estado
      ON facturas (empresa_id, estado, created_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS factura_items (
      id BIGSERIAL PRIMARY KEY,
      factura_id BIGINT NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
      producto_id INT REFERENCES productos(id) ON DELETE SET NULL,
      descripcion TEXT NOT NULL,
      cantidad NUMERIC(12,3) NOT NULL DEFAULT 1,
      precio_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
      alicuota_iva NUMERIC(5,2) NOT NULL DEFAULT 0,
      importe_neto NUMERIC(12,2) NOT NULL DEFAULT 0,
      importe_iva NUMERIC(12,2) NOT NULL DEFAULT 0,
      importe_total NUMERIC(12,2) NOT NULL DEFAULT 0
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_factura_items_factura
      ON factura_items (factura_id)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS factura_afip_auditoria (
      id BIGSERIAL PRIMARY KEY,
      empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      factura_id BIGINT REFERENCES facturas(id) ON DELETE SET NULL,
      servicio TEXT NOT NULL,
      operacion TEXT NOT NULL,
      request_xml TEXT,
      response_xml TEXT,
      resultado TEXT,
      error_codigo TEXT,
      error_mensaje TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_factura_afip_auditoria_factura
      ON factura_afip_auditoria (factura_id, created_at DESC)
  `);
}

export async function upsertFacturacionConfig(query, empresaId, payload = {}) {
  const cuit = normalizeFiscalDoc(payload.cuit);
  const puntoVenta = Number(payload.punto_venta ?? payload.puntoVenta);
  if (!isValidCuit(cuit)) throw Object.assign(new Error('CUIT invalido'), { statusCode: 400 });
  if (!Number.isInteger(puntoVenta) || puntoVenta <= 0) {
    throw Object.assign(new Error('Punto de venta requerido'), { statusCode: 400 });
  }

  const rows = await query(
    `
    INSERT INTO empresa_facturacion_config (
      empresa_id, cuit, razon_social, condicion_iva, punto_venta, modo_afip,
      certificado_ref, clave_ref, activo, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (empresa_id)
    DO UPDATE SET
      cuit = EXCLUDED.cuit,
      razon_social = EXCLUDED.razon_social,
      condicion_iva = EXCLUDED.condicion_iva,
      punto_venta = EXCLUDED.punto_venta,
      modo_afip = EXCLUDED.modo_afip,
      certificado_ref = COALESCE(EXCLUDED.certificado_ref, empresa_facturacion_config.certificado_ref),
      clave_ref = COALESCE(EXCLUDED.clave_ref, empresa_facturacion_config.clave_ref),
      activo = EXCLUDED.activo,
      updated_at = NOW()
    RETURNING id, empresa_id, cuit, razon_social, condicion_iva, punto_venta, modo_afip, certificado_ref, clave_ref, activo, created_at, updated_at
    `,
    [
      empresaId,
      cuit,
      payload.razon_social || null,
      payload.condicion_iva || null,
      puntoVenta,
      normalizeAfipMode(payload.modo_afip ?? payload.modoAfip),
      payload.certificado_ref || null,
      payload.clave_ref || null,
      payload.activo !== false,
    ]
  );
  return rows[0];
}

export async function getFacturacionConfig(query, empresaId) {
  const rows = await query(
    `
    SELECT id, empresa_id, cuit, razon_social, condicion_iva, punto_venta, modo_afip,
           certificado_ref, clave_ref, activo, created_at, updated_at
    FROM empresa_facturacion_config
    WHERE empresa_id = $1
    LIMIT 1
    `,
    [empresaId]
  );
  return rows[0] || null;
}

export async function getFacturacionConfigForArca(query, empresaId) {
  const rows = await query(
    `
    SELECT id, empresa_id, cuit, razon_social, condicion_iva, punto_venta, modo_afip,
           certificado_ref, clave_ref, wsaa_token_encrypted, wsaa_sign_encrypted, wsaa_expires_at,
           activo, created_at, updated_at
    FROM empresa_facturacion_config
    WHERE empresa_id = $1
    LIMIT 1
    `,
    [empresaId]
  );
  return rows[0] || null;
}

export function getCachedWsaaCredentials(config) {
  if (!config?.wsaa_token_encrypted || !config?.wsaa_sign_encrypted) return null;
  const expiresAt = config.wsaa_expires_at ? new Date(config.wsaa_expires_at) : null;
  if (!expiresAt || expiresAt.getTime() <= Date.now() + 5 * 60 * 1000) return null;
  return {
    token: decryptSecret(config.wsaa_token_encrypted),
    sign: decryptSecret(config.wsaa_sign_encrypted),
    expirationTime: expiresAt,
  };
}

export async function cacheWsaaCredentials(query, empresaId, { token, sign, expirationTime }) {
  const tokenEncrypted = encryptSecret(token);
  const signEncrypted = encryptSecret(sign);
  const expiresAt = expirationTime instanceof Date && Number.isFinite(expirationTime.getTime())
    ? expirationTime
    : null;

  await query(
    `
    UPDATE empresa_facturacion_config
    SET wsaa_token_encrypted = $2,
        wsaa_sign_encrypted = $3,
        wsaa_expires_at = $4,
        updated_at = NOW()
    WHERE empresa_id = $1
    `,
    [empresaId, tokenEncrypted, signEncrypted, expiresAt]
  );
}

export async function logAfipAudit(query, {
  empresaId,
  facturaId = null,
  servicio,
  operacion,
  requestXml = null,
  responseXml = null,
  resultado = null,
  errorCodigo = null,
  errorMensaje = null,
}) {
  await query(
    `
    INSERT INTO factura_afip_auditoria (
      empresa_id, factura_id, servicio, operacion, request_xml, response_xml,
      resultado, error_codigo, error_mensaje
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,
    [
      empresaId,
      facturaId,
      servicio,
      operacion,
      requestXml,
      responseXml,
      resultado,
      errorCodigo,
      errorMensaje,
    ]
  );
}

export function encryptSecret(value) {
  const secret = process.env.ARCA_TOKEN_ENCRYPTION_KEY || process.env.FACTURACION_SECRET_KEY;
  if (!secret) {
    throw Object.assign(
      new Error('Falta ARCA_TOKEN_ENCRYPTION_KEY para guardar token/sign de WSAA'),
      { statusCode: 500 }
    );
  }

  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value || ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decryptSecret(payload) {
  const secret = process.env.ARCA_TOKEN_ENCRYPTION_KEY || process.env.FACTURACION_SECRET_KEY;
  if (!secret) {
    throw Object.assign(
      new Error('Falta ARCA_TOKEN_ENCRYPTION_KEY para leer token/sign de WSAA'),
      { statusCode: 500 }
    );
  }

  const [version, ivB64, tagB64, encryptedB64] = String(payload || '').split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !encryptedB64) {
    throw Object.assign(new Error('Formato de secreto WSAA invalido'), { statusCode: 500 });
  }

  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export async function requestFacturaForPedido(query, { pedidoId, empresaId, userId, datosFiscales = {} }) {
  const pedidoRows = await query(
    `
    SELECT p.id, p.empresa_id, p.punto_entrega_id, p.monto, p.estado,
           pe.cliente, pe.razon_social, pe.cuit, pe.condicion_iva, pe.requiere_factura,
           pe.direccion, pe.direccion_completa, pe.email_facturacion
    FROM pedidos p
    LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
    WHERE p.id = $1 AND p.empresa_id = $2
    LIMIT 1
    `,
    [pedidoId, empresaId]
  );
  if (!pedidoRows.length) throw Object.assign(new Error('Pedido no encontrado'), { statusCode: 404 });

  const config = await getFacturacionConfig(query, empresaId);
  if (!config) throw Object.assign(new Error('La empresa no tiene configuracion fiscal'), { statusCode: 409 });

  const pedido = pedidoRows[0];
  if (!isPedidoEstadoFacturable(pedido.estado)) {
    throw Object.assign(new Error('Los pedidos cancelados no se pueden facturar'), { statusCode: 400 });
  }
  if (pedido.requiere_factura !== true) {
    throw Object.assign(new Error('El cliente no esta habilitado para facturacion'), { statusCode: 400 });
  }
  const numeroDocumento = normalizeFiscalDoc(datosFiscales.numero_documento || datosFiscales.cuit || pedido.cuit);
  const razonSocial = String(datosFiscales.razon_social || pedido.razon_social || pedido.cliente || '').trim();
  if (!numeroDocumento || !razonSocial) {
    throw Object.assign(new Error('Faltan datos fiscales del cliente'), { statusCode: 400 });
  }

  if (String(datosFiscales.tipo_documento || 'CUIT').toUpperCase() === 'CUIT' && !isValidCuit(numeroDocumento)) {
    throw Object.assign(new Error('CUIT del cliente invalido'), { statusCode: 400 });
  }

  const clienteFiscalRows = await query(
    `
    INSERT INTO cliente_datos_fiscales (
      empresa_id, punto_entrega_id, tipo_documento, numero_documento, razon_social,
      condicion_iva, domicilio_fiscal, email_facturacion, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    ON CONFLICT (empresa_id, punto_entrega_id)
    DO UPDATE SET
      tipo_documento = EXCLUDED.tipo_documento,
      numero_documento = EXCLUDED.numero_documento,
      razon_social = EXCLUDED.razon_social,
      condicion_iva = EXCLUDED.condicion_iva,
      domicilio_fiscal = EXCLUDED.domicilio_fiscal,
      email_facturacion = EXCLUDED.email_facturacion,
      updated_at = NOW()
    RETURNING *
    `,
    [
      empresaId,
      pedido.punto_entrega_id || null,
      String(datosFiscales.tipo_documento || 'CUIT').toUpperCase(),
      numeroDocumento,
      razonSocial,
      datosFiscales.condicion_iva || pedido.condicion_iva || null,
      datosFiscales.domicilio_fiscal || pedido.direccion_completa || pedido.direccion || null,
      datosFiscales.email_facturacion || pedido.email_facturacion || null,
    ]
  );

  const itemsRows = await query(
    `
    SELECT producto_id, producto AS descripcion, cantidad, precio_unitario
    FROM items_pedido
    WHERE pedido_id = $1
    ORDER BY id ASC
    `,
    [pedidoId]
  );
  const sourceItems = itemsRows.length
    ? itemsRows
    : [{ descripcion: `Pedido #${pedidoId}`, cantidad: 1, precio_unitario: Number(pedido.monto) || 0 }];

  const tipo = resolveTipoComprobante({
    emisorCondicionIva: config.condicion_iva,
    receptorCondicionIva: clienteFiscalRows[0].condicion_iva,
  });
  const totals = calculateInvoiceTotals(sourceItems);

  const facturaRows = await query(
    `
    INSERT INTO facturas (
      empresa_id, pedido_id, punto_entrega_id, cliente_datos_fiscales_id, estado,
      modo_afip, tipo_comprobante, codigo_comprobante_afip, punto_venta, concepto,
      importe_neto, importe_iva, importe_total, created_by, updated_at
    )
    VALUES ($1,$2,$3,$4,'pendiente_confirmacion',$5,$6,$7,$8,'productos',$9,$10,$11,$12,NOW())
    ON CONFLICT (empresa_id, pedido_id) WHERE pedido_id IS NOT NULL AND estado <> 'anulada'
    DO UPDATE SET
      cliente_datos_fiscales_id = EXCLUDED.cliente_datos_fiscales_id,
      estado = CASE WHEN facturas.estado = 'emitida' THEN facturas.estado ELSE 'pendiente_confirmacion' END,
      modo_afip = EXCLUDED.modo_afip,
      tipo_comprobante = EXCLUDED.tipo_comprobante,
      codigo_comprobante_afip = EXCLUDED.codigo_comprobante_afip,
      punto_venta = EXCLUDED.punto_venta,
      importe_neto = EXCLUDED.importe_neto,
      importe_iva = EXCLUDED.importe_iva,
      importe_total = EXCLUDED.importe_total,
      error_codigo = NULL,
      error_mensaje = NULL,
      updated_at = NOW()
    RETURNING *
    `,
    [
      empresaId,
      pedidoId,
      pedido.punto_entrega_id || null,
      clienteFiscalRows[0].id,
      config.modo_afip,
      tipo.tipo,
      tipo.codigo,
      config.punto_venta,
      totals.importe_neto,
      totals.importe_iva,
      totals.importe_total,
      userId || null,
    ]
  );

  const factura = facturaRows[0];
  if (factura.estado !== 'emitida') {
    await query('DELETE FROM factura_items WHERE factura_id = $1', [factura.id]);
    for (const item of totals.items) {
      await query(
        `
        INSERT INTO factura_items (
          factura_id, producto_id, descripcion, cantidad, precio_unitario,
          alicuota_iva, importe_neto, importe_iva, importe_total
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          factura.id,
          item.producto_id,
          item.descripcion,
          item.cantidad,
          item.precio_unitario,
          item.alicuota_iva,
          item.importe_neto,
          item.importe_iva,
          item.importe_total,
        ]
      );
    }
  }

  return getFacturaById(query, { facturaId: factura.id, empresaId });
}

export async function getFacturaByPedido(query, { pedidoId, empresaId }) {
  const rows = await query(
    `
    SELECT id
    FROM facturas
    WHERE pedido_id = $1 AND empresa_id = $2 AND estado <> 'anulada'
    ORDER BY id DESC
    LIMIT 1
    `,
    [pedidoId, empresaId]
  );
  if (!rows.length) return null;
  return getFacturaById(query, { facturaId: rows[0].id, empresaId });
}

export async function getFacturaById(query, { facturaId, empresaId }) {
  const rows = await query(
    `
    SELECT f.*, cdf.razon_social AS receptor_razon_social, cdf.numero_documento AS receptor_documento,
           cdf.condicion_iva AS receptor_condicion_iva, cdf.email_facturacion AS receptor_email_facturacion
    FROM facturas f
    LEFT JOIN cliente_datos_fiscales cdf ON cdf.id = f.cliente_datos_fiscales_id
    WHERE f.id = $1 AND f.empresa_id = $2
    LIMIT 1
    `,
    [facturaId, empresaId]
  );
  if (!rows.length) return null;

  const items = await query(
    `
    SELECT id, producto_id, descripcion, cantidad, precio_unitario, alicuota_iva,
           importe_neto, importe_iva, importe_total
    FROM factura_items
    WHERE factura_id = $1
    ORDER BY id ASC
    `,
    [facturaId]
  );
  return { ...rows[0], items };
}

export async function markFacturaEmitida(query, {
  facturaId,
  empresaId,
  userId,
  numeroComprobante,
  cae,
  caeVencimiento,
}) {
  const caeDate = parseAfipDate(caeVencimiento);
  const rows = await query(
    `
    UPDATE facturas
    SET estado = 'emitida',
        numero_comprobante = $3,
        cae = $4,
        cae_vencimiento = $5,
        emitted_by = $6,
        emitted_at = NOW(),
        error_codigo = NULL,
        error_mensaje = NULL,
        updated_at = NOW()
    WHERE id = $1 AND empresa_id = $2 AND estado <> 'emitida'
    RETURNING *
    `,
    [facturaId, empresaId, numeroComprobante, cae, caeDate, userId || null]
  );
  return rows[0] || null;
}

export async function markFacturaRechazada(query, { facturaId, empresaId, errorCodigo = null, errorMensaje }) {
  const rows = await query(
    `
    UPDATE facturas
    SET estado = 'rechazada',
        error_codigo = $3,
        error_mensaje = $4,
        updated_at = NOW()
    WHERE id = $1 AND empresa_id = $2 AND estado <> 'emitida'
    RETURNING *
    `,
    [facturaId, empresaId, errorCodigo, errorMensaje || null]
  );
  return rows[0] || null;
}

export function parseAfipDate(value) {
  const s = String(value || '').replace(/\D+/g, '');
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export async function listFacturas(query, { empresaId, estado, limit = 50 }) {
  const params = [empresaId];
  let where = 'WHERE f.empresa_id = $1';
  const normalizedEstado = normalizeEstado(estado);
  if (normalizedEstado) {
    params.push(normalizedEstado);
    where += ` AND f.estado = $${params.length}`;
  }
  params.push(Math.min(100, Math.max(1, Number(limit) || 50)));

  return query(
    `
    SELECT f.id, f.pedido_id, f.estado, f.tipo_comprobante, f.punto_venta,
           f.numero_comprobante, f.importe_total, f.cae, f.created_at, f.updated_at,
           cdf.razon_social AS receptor_razon_social,
           cdf.numero_documento AS receptor_documento
    FROM facturas f
    LEFT JOIN cliente_datos_fiscales cdf ON cdf.id = f.cliente_datos_fiscales_id
    ${where}
    ORDER BY f.created_at DESC
    LIMIT $${params.length}
    `,
    params
  );
}

export async function listPedidosFacturables(query, {
  empresaId,
  from = null,
  to = null,
  estadoFactura = null,
  q = null,
  limit = 100,
} = {}) {
  const params = [empresaId];
  let where = `
    WHERE p.empresa_id = $1
      AND COALESCE(p.monto, 0) > 0
      AND LOWER(COALESCE(p.estado, '')) <> ALL(ARRAY['cancelado','cancelada','cancelled','canceled'])
      AND COALESCE(pe.requiere_factura, FALSE) = TRUE
  `;

  if (from) {
    params.push(String(from).slice(0, 10));
    where += ` AND p.fecha >= $${params.length}::date`;
  }

  if (to) {
    params.push(String(to).slice(0, 10));
    where += ` AND p.fecha < ($${params.length}::date + INTERVAL '1 day')`;
  }

  const normalizedEstado = normalizeEstado(estadoFactura);
  if (normalizedEstado) {
    params.push(normalizedEstado);
    where += ` AND f.estado = $${params.length}`;
  } else if (String(estadoFactura || '') === 'sin_factura') {
    where += ` AND f.id IS NULL`;
  }

  const queryText = String(q || '').trim();
  if (queryText) {
    params.push('%' + queryText.toLowerCase() + '%');
    where += `
      AND (
        LOWER(COALESCE(pe.cliente, '')) LIKE $${params.length}
        OR LOWER(COALESCE(pe.razon_social, '')) LIKE $${params.length}
        OR LOWER(COALESCE(pe.cuit, '')) LIKE $${params.length}
        OR LOWER(COALESCE(pe.direccion, '')) LIKE $${params.length}
      )
    `;
  }

  params.push(Math.min(250, Math.max(1, Number(limit) || 100)));

  return query(
    `
    SELECT
      p.id AS pedido_id,
      p.fecha,
      p.estado AS pedido_estado,
      p.monto,
      p.metodo_pago,
      pe.id AS punto_entrega_id,
      pe.cliente,
      pe.razon_social,
      pe.cuit,
      pe.condicion_iva,
      pe.direccion,
      pe.direccion_completa,
      pe.email_facturacion,
      pe.requiere_factura,
      f.id AS factura_id,
      f.estado AS factura_estado,
      f.tipo_comprobante,
      f.codigo_comprobante_afip,
      f.punto_venta,
      f.numero_comprobante,
      f.cae,
      f.cae_vencimiento,
      f.error_codigo,
      f.error_mensaje,
      f.created_at AS factura_created_at,
      f.emitted_at,
      COUNT(*) OVER ()::int AS total_count
    FROM pedidos p
    LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
    LEFT JOIN facturas f
      ON f.empresa_id = p.empresa_id
     AND f.pedido_id = p.id
     AND f.estado <> 'anulada'
    ${where}
    ORDER BY p.fecha DESC, p.id DESC
    LIMIT $${params.length}
    `,
    params
  );
}
