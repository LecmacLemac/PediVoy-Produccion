const WSFE_ENDPOINTS = {
  homologacion: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  produccion: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
};

export function getWsfeEndpoint(mode = 'homologacion') {
  return WSFE_ENDPOINTS[mode] || WSFE_ENDPOINTS.homologacion;
}

export function buildAuthXml({ token, sign, cuit }) {
  return [
    '<ar:Auth>',
    tag('ar:Token', token),
    tag('ar:Sign', sign),
    tag('ar:Cuit', cuit),
    '</ar:Auth>',
  ].join('');
}

export function buildFeCompUltimoAutorizadoEnvelope({ token, sign, cuit, puntoVenta, tipoComprobante }) {
  return soapEnvelope('FECompUltimoAutorizado', [
    buildAuthXml({ token, sign, cuit }),
    tag('ar:PtoVta', puntoVenta),
    tag('ar:CbteTipo', tipoComprobante),
  ].join(''));
}

export function buildFecaeSolicitarEnvelope({ token, sign, cuit, comprobante }) {
  const detalle = [
    tag('ar:Concepto', comprobante.concepto || 1),
    tag('ar:DocTipo', comprobante.docTipo),
    tag('ar:DocNro', comprobante.docNro),
    tag('ar:CbteDesde', comprobante.cbteDesde),
    tag('ar:CbteHasta', comprobante.cbteHasta || comprobante.cbteDesde),
    tag('ar:CbteFch', comprobante.cbteFch),
    tag('ar:ImpTotal', money(comprobante.impTotal)),
    tag('ar:ImpTotConc', money(comprobante.impTotConc || 0)),
    tag('ar:ImpNeto', money(comprobante.impNeto)),
    tag('ar:ImpOpEx', money(comprobante.impOpEx || 0)),
    tag('ar:ImpTrib', money(comprobante.impTrib || 0)),
    tag('ar:ImpIVA', money(comprobante.impIva || 0)),
    tag('ar:CondicionIVAReceptorId', comprobante.condicionIvaReceptorId || 5),
    tag('ar:MonId', comprobante.monId || 'PES'),
    tag('ar:MonCotiz', comprobante.monCotiz || 1),
  ];

  if (Array.isArray(comprobante.iva) && comprobante.iva.length) {
    detalle.push(
      '<ar:Iva>',
      ...comprobante.iva.map((item) => [
        '<ar:AlicIva>',
        tag('ar:Id', item.id),
        tag('ar:BaseImp', money(item.baseImp)),
        tag('ar:Importe', money(item.importe)),
        '</ar:AlicIva>',
      ].join('')),
      '</ar:Iva>'
    );
  }

  return soapEnvelope('FECAESolicitar', [
    buildAuthXml({ token, sign, cuit }),
    '<ar:FeCAEReq>',
    '<ar:FeCabReq>',
    tag('ar:CantReg', 1),
    tag('ar:PtoVta', comprobante.puntoVenta),
    tag('ar:CbteTipo', comprobante.tipoComprobante),
    '</ar:FeCabReq>',
    '<ar:FeDetReq>',
    '<ar:FECAEDetRequest>',
    ...detalle,
    '</ar:FECAEDetRequest>',
    '</ar:FeDetReq>',
    '</ar:FeCAEReq>',
  ].join(''));
}

export async function feCompUltimoAutorizado({
  mode = 'homologacion',
  token,
  sign,
  cuit,
  puntoVenta,
  tipoComprobante,
  fetchImpl = globalThis.fetch,
} = {}) {
  const body = buildFeCompUltimoAutorizadoEnvelope({ token, sign, cuit, puntoVenta, tipoComprobante });
  const responseXml = await postSoap({ mode, action: 'FECompUltimoAutorizado', body, fetchImpl });
  return {
    ...parseFeCompUltimoAutorizadoResponse(responseXml),
    requestXml: body,
    responseXml,
    endpoint: getWsfeEndpoint(mode),
  };
}

export async function fecaeSolicitar({
  mode = 'homologacion',
  token,
  sign,
  cuit,
  comprobante,
  fetchImpl = globalThis.fetch,
} = {}) {
  const body = buildFecaeSolicitarEnvelope({ token, sign, cuit, comprobante });
  const responseXml = await postSoap({ mode, action: 'FECAESolicitar', body, fetchImpl });
  return {
    ...parseFecaeSolicitarResponse(responseXml),
    requestXml: body,
    responseXml,
    endpoint: getWsfeEndpoint(mode),
  };
}

export function parseFeCompUltimoAutorizadoResponse(xml) {
  const fault = extractTag(xml, 'faultstring');
  if (fault) throw new Error('WSFE rechazo FECompUltimoAutorizado: ' + decodeXml(fault));

  const cbteNro = Number(extractTag(xml, 'CbteNro') || 0);
  const ptoVta = Number(extractTag(xml, 'PtoVta') || 0);
  const cbteTipo = Number(extractTag(xml, 'CbteTipo') || 0);
  const errors = parseErrors(xml);
  if (errors.length) throw new Error('WSFE error: ' + errors.map((e) => e.msg).join('; '));
  return { cbteNro, ptoVta, cbteTipo };
}

export function parseFecaeSolicitarResponse(xml) {
  const fault = extractTag(xml, 'faultstring');
  if (fault) throw new Error('WSFE rechazo FECAESolicitar: ' + decodeXml(fault));

  const result = extractTag(xml, 'Resultado');
  const cae = extractTag(xml, 'CAE');
  const caeFchVto = extractTag(xml, 'CAEFchVto');
  const cbteDesde = Number(extractTag(xml, 'CbteDesde') || 0);
  const cbteHasta = Number(extractTag(xml, 'CbteHasta') || cbteDesde || 0);
  const errors = parseErrors(xml);
  const observations = parseObservations(xml);

  return {
    resultado: result ? decodeXml(result) : null,
    cae: cae ? decodeXml(cae) : null,
    caeFchVto: caeFchVto ? decodeXml(caeFchVto) : null,
    cbteDesde,
    cbteHasta,
    errors,
    observations,
  };
}

export function toAfipDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return String(year) + month + day;
}

export function buildComprobanteFromFactura({ factura, config, lastNumber }) {
  const nextNumber = Number(lastNumber || 0) + 1;
  const doc = String(factura.receptor_documento || '').replace(/\D+/g, '');
  const docNro = Number(doc || 0);
  const tipoComprobante = Number(factura.codigo_comprobante_afip);
  const impIva = Number(factura.importe_iva || 0);

  const comprobante = {
    concepto: 1,
    docTipo: doc.length === 11 ? 80 : 96,
    docNro,
    cbteDesde: nextNumber,
    cbteHasta: nextNumber,
    cbteFch: toAfipDate(new Date()),
    impTotal: Number(factura.importe_total || 0),
    impTotConc: 0,
    impNeto: Number(factura.importe_neto || 0),
    impOpEx: 0,
    impTrib: 0,
    impIva,
    condicionIvaReceptorId: resolveCondicionIvaReceptorId(factura.receptor_condicion_iva),
    monId: 'PES',
    monCotiz: 1,
    puntoVenta: Number(config.punto_venta),
    tipoComprobante,
  };

  if (impIva > 0) {
    comprobante.iva = [{
      id: 5,
      baseImp: comprobante.impNeto,
      importe: impIva,
    }];
  }

  return comprobante;
}

function resolveCondicionIvaReceptorId(value) {
  const condicion = String(value || '').toLowerCase();
  if (condicion.includes('responsable') && condicion.includes('inscrip')) return 1;
  if (condicion.includes('exent')) return 4;
  if (condicion.includes('mono')) return 6;
  if (condicion.includes('no alcanz')) return 15;
  return 5;
}

async function postSoap({ mode, action, body, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch no disponible para WSFE');
  const endpoint = getWsfeEndpoint(mode);
  const resp = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      soapaction: 'http://ar.gov.afip.dif.FEV1/' + action,
    },
    body,
  });
  const responseXml = await resp.text();
  if (!resp.ok) throw new Error('WSFE HTTP ' + resp.status + ': ' + responseXml.slice(0, 500));
  return responseXml;
}

function soapEnvelope(operation, innerXml) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">',
    '<soapenv:Header/>',
    '<soapenv:Body>',
    '<ar:' + operation + '>',
    innerXml,
    '</ar:' + operation + '>',
    '</soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('');
}

function tag(name, value) {
  return '<' + name + '>' + escapeXml(value) + '</' + name + '>';
}

function money(value) {
  return (Math.round((Number(value) || 0) * 100) / 100).toFixed(2);
}

function extractTag(xml, tagName) {
  const re = new RegExp('<(?:\\w+:)?' + tagName + '[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?' + tagName + '>', 'i');
  return String(xml || '').match(re)?.[1] || null;
}

function parseErrors(xml) {
  return parseCodeMsgList(xml, 'Err');
}

function parseObservations(xml) {
  return parseCodeMsgList(xml, 'Obs');
}

function parseCodeMsgList(xml, itemTag) {
  const out = [];
  const re = new RegExp('<(?:\\w+:)?' + itemTag + '[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?' + itemTag + '>', 'gi');
  for (const match of String(xml || '').matchAll(re)) {
    out.push({
      code: decodeXml(extractTag(match[1], 'Code') || ''),
      msg: decodeXml(extractTag(match[1], 'Msg') || ''),
    });
  }
  return out.filter((item) => item.code || item.msg);
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
