import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildComprobanteFromFactura,
  buildFecaeSolicitarEnvelope,
  buildFeCompUltimoAutorizadoEnvelope,
  getWsfeEndpoint,
  parseFecaeSolicitarResponse,
  parseFeCompUltimoAutorizadoResponse,
  toAfipDate,
} from '../src/integrations/arca/wsfeClient.js';

test('buildFeCompUltimoAutorizadoEnvelope arma SOAP con Auth y comprobante', () => {
  const xml = buildFeCompUltimoAutorizadoEnvelope({
    token: 'tok',
    sign: 'sig',
    cuit: '20123456786',
    puntoVenta: 1,
    tipoComprobante: 6,
  });

  assert.match(xml, /FECompUltimoAutorizado/);
  assert.match(xml, /<ar:Token>tok<\/ar:Token>/);
  assert.match(xml, /<ar:PtoVta>1<\/ar:PtoVta>/);
  assert.match(xml, /<ar:CbteTipo>6<\/ar:CbteTipo>/);
});

test('buildFecaeSolicitarEnvelope arma solicitud CAE basica', () => {
  const xml = buildFecaeSolicitarEnvelope({
    token: 'tok',
    sign: 'sig',
    cuit: '20123456786',
    comprobante: {
      puntoVenta: 1,
      tipoComprobante: 6,
      concepto: 1,
      docTipo: 80,
      docNro: 20123456786,
      cbteDesde: 10,
      cbteFch: '20260515',
      impTotal: 8200,
      impNeto: 8200,
      impIva: 0,
    },
  });

  assert.match(xml, /FECAESolicitar/);
  assert.match(xml, /<ar:CbteDesde>10<\/ar:CbteDesde>/);
  assert.match(xml, /<ar:ImpTotal>8200.00<\/ar:ImpTotal>/);
  assert.match(xml, /<ar:CondicionIVAReceptorId>5<\/ar:CondicionIVAReceptorId>/);
});

test('parseFeCompUltimoAutorizadoResponse extrae ultimo numero', () => {
  const parsed = parseFeCompUltimoAutorizadoResponse([
    '<FECompUltimoAutorizadoResponse>',
    '<FECompUltimoAutorizadoResult>',
    '<PtoVta>1</PtoVta><CbteTipo>6</CbteTipo><CbteNro>25</CbteNro>',
    '</FECompUltimoAutorizadoResult>',
    '</FECompUltimoAutorizadoResponse>',
  ].join(''));

  assert.equal(parsed.cbteNro, 25);
  assert.equal(parsed.ptoVta, 1);
  assert.equal(parsed.cbteTipo, 6);
});

test('parseFecaeSolicitarResponse extrae CAE aprobado', () => {
  const parsed = parseFecaeSolicitarResponse([
    '<FECAESolicitarResponse><FECAESolicitarResult>',
    '<FeDetResp><FECAEDetResponse>',
    '<Resultado>A</Resultado><CbteDesde>26</CbteDesde><CbteHasta>26</CbteHasta>',
    '<CAE>12345678901234</CAE><CAEFchVto>20260525</CAEFchVto>',
    '</FECAEDetResponse></FeDetResp>',
    '</FECAESolicitarResult></FECAESolicitarResponse>',
  ].join(''));

  assert.equal(parsed.resultado, 'A');
  assert.equal(parsed.cae, '12345678901234');
  assert.equal(parsed.caeFchVto, '20260525');
  assert.equal(parsed.cbteDesde, 26);
});

test('buildComprobanteFromFactura prepara proximo numero y doc tipo CUIT', () => {
  const comprobante = buildComprobanteFromFactura({
    config: { punto_venta: 2 },
    lastNumber: 5,
    factura: {
      receptor_documento: '20123456786',
      codigo_comprobante_afip: 6,
      importe_total: 1000,
      importe_neto: 1000,
      importe_iva: 0,
      receptor_condicion_iva: 'Responsable Inscripto',
    },
  });

  assert.equal(comprobante.cbteDesde, 6);
  assert.equal(comprobante.docTipo, 80);
  assert.equal(comprobante.puntoVenta, 2);
  assert.equal(comprobante.condicionIvaReceptorId, 1);
});

test('toAfipDate y endpoints WSFE', () => {
  assert.equal(toAfipDate(new Date('2026-05-15T13:00:00Z')), '20260515');
  assert.match(getWsfeEndpoint('homologacion'), /wswhomo/);
  assert.match(getWsfeEndpoint('produccion'), /servicios1/);
});
