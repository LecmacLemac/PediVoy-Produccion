import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WSAA_ENDPOINTS = {
  homologacion: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  produccion: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
};

export function getWsaaEndpoint(mode = 'homologacion') {
  return WSAA_ENDPOINTS[mode] || WSAA_ENDPOINTS.homologacion;
}

export function buildLoginTicketRequest({ service = 'wsfe', uniqueId = Date.now(), now = new Date() } = {}) {
  const generationTime = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const expirationTime = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<loginTicketRequest version="1.0">',
    '  <header>',
    '    <uniqueId>' + Math.floor(Number(uniqueId) / 1000) + '</uniqueId>',
    '    <generationTime>' + generationTime + '</generationTime>',
    '    <expirationTime>' + expirationTime + '</expirationTime>',
    '  </header>',
    '  <service>' + escapeXml(service) + '</service>',
    '</loginTicketRequest>',
  ].join('\n');
}

export function buildLoginCmsEnvelope(cmsBase64) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">',
    '  <soapenv:Header/>',
    '  <soapenv:Body>',
    '    <wsaa:loginCms>',
    '      <wsaa:in0>' + escapeXml(cmsBase64) + '</wsaa:in0>',
    '    </wsaa:loginCms>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
}

export function parseLoginCmsResponse(xml) {
  const loginReturn = decodeXml(extractTag(xml, 'loginCmsReturn') || '');
  if (!loginReturn) {
    const fault = extractTag(xml, 'faultstring') || extractTag(xml, 'faultcode');
    throw new Error(fault ? 'WSAA rechazo loginCms: ' + decodeXml(fault) : 'WSAA no devolvio loginCmsReturn');
  }

  const token = extractTag(loginReturn, 'token');
  const sign = extractTag(loginReturn, 'sign');
  const expirationTime = extractTag(loginReturn, 'expirationTime');
  const generationTime = extractTag(loginReturn, 'generationTime');

  if (!token || !sign) throw new Error('WSAA respondio sin token/sign');

  return {
    token: decodeXml(token),
    sign: decodeXml(sign),
    expirationTime: expirationTime ? new Date(decodeXml(expirationTime)) : null,
    generationTime: generationTime ? new Date(decodeXml(generationTime)) : null,
    rawLoginTicketResponse: loginReturn,
  };
}

export async function signLoginTicketRequest({ traXml, certPath, keyPath, certPem, keyPem }) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pedivoy-wsaa-'));
  const traPath = path.join(tmpDir, 'login-ticket-request.xml');
  const cmsPath = path.join(tmpDir, 'login-ticket-request.cms');
  const resolvedCertPath = certPath || path.join(tmpDir, 'certificado.pem');
  const resolvedKeyPath = keyPath || path.join(tmpDir, 'clave.pem');

  try {
    await writeFile(traPath, traXml, 'utf8');
    if (!certPath) await writeFile(resolvedCertPath, certPem, { encoding: 'utf8', mode: 0o600 });
    if (!keyPath) await writeFile(resolvedKeyPath, keyPem, { encoding: 'utf8', mode: 0o600 });
    await execFileAsync('openssl', [
      'cms',
      '-sign',
      '-in', traPath,
      '-signer', resolvedCertPath,
      '-inkey', resolvedKeyPath,
      '-nodetach',
      '-outform', 'DER',
      '-out', cmsPath,
    ], { timeout: 15000 });

    const cms = await readFile(cmsPath);
    return cms.toString('base64');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function loginCms({
  mode = 'homologacion',
  service = 'wsfe',
  certPath,
  keyPath,
  certPem,
  keyPem,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  if (!certPath && !certPem) throw new Error('Falta certificado para WSAA');
  if (!keyPath && !keyPem) throw new Error('Falta clave para WSAA');
  if (typeof fetchImpl !== 'function') throw new Error('fetch no disponible para WSAA');

  const traXml = buildLoginTicketRequest({ service, uniqueId: now.getTime(), now });
  const cmsBase64 = await signLoginTicketRequest({ traXml, certPath, keyPath, certPem, keyPem });
  const envelope = buildLoginCmsEnvelope(cmsBase64);
  const endpoint = getWsaaEndpoint(mode);

  const resp = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      soapaction: '',
    },
    body: envelope,
  });

  const responseXml = await resp.text();
  if (!resp.ok) {
    throw new Error('WSAA HTTP ' + resp.status + ': ' + responseXml.slice(0, 500));
  }

  return {
    ...parseLoginCmsResponse(responseXml),
    requestXml: envelope,
    responseXml,
    endpoint,
  };
}

function extractTag(xml, tagName) {
  const re = new RegExp('<(?:\\w+:)?' + tagName + '[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?' + tagName + '>', 'i');
  return String(xml || '').match(re)?.[1] || null;
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
