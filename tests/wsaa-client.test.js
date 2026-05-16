import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLoginCmsEnvelope,
  buildLoginTicketRequest,
  getWsaaEndpoint,
  parseLoginCmsResponse,
} from '../src/integrations/arca/wsaaClient.js';

test('buildLoginTicketRequest arma TRA para wsfe', () => {
  const xml = buildLoginTicketRequest({
    service: 'wsfe',
    uniqueId: 1700000000000,
    now: new Date('2026-05-15T13:00:00.000Z'),
  });

  assert.match(xml, /<loginTicketRequest version="1.0">/);
  assert.match(xml, /<service>wsfe<\/service>/);
  assert.match(xml, /<generationTime>2026-05-15T12:50:00.000Z<\/generationTime>/);
  assert.match(xml, /<expirationTime>2026-05-16T01:00:00.000Z<\/expirationTime>/);
});

test('buildLoginCmsEnvelope incluye CMS escapado', () => {
  const xml = buildLoginCmsEnvelope('abc&123');
  assert.match(xml, /<wsaa:loginCms>/);
  assert.match(xml, /abc&amp;123/);
});

test('parseLoginCmsResponse extrae token sign y vencimiento', () => {
  const response = [
    '<soapenv:Envelope>',
    '  <soapenv:Body>',
    '    <loginCmsResponse>',
    '      <loginCmsReturn>&lt;loginTicketResponse&gt;&lt;header&gt;&lt;generationTime&gt;2026-05-15T13:00:00.000Z&lt;/generationTime&gt;&lt;expirationTime&gt;2026-05-16T01:00:00.000Z&lt;/expirationTime&gt;&lt;/header&gt;&lt;credentials&gt;&lt;token&gt;tok&lt;/token&gt;&lt;sign&gt;sig&lt;/sign&gt;&lt;/credentials&gt;&lt;/loginTicketResponse&gt;</loginCmsReturn>',
    '    </loginCmsResponse>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('');

  const parsed = parseLoginCmsResponse(response);
  assert.equal(parsed.token, 'tok');
  assert.equal(parsed.sign, 'sig');
  assert.equal(parsed.expirationTime.toISOString(), '2026-05-16T01:00:00.000Z');
});

test('getWsaaEndpoint separa homologacion y produccion', () => {
  assert.match(getWsaaEndpoint('homologacion'), /wsaahomo/);
  assert.match(getWsaaEndpoint('produccion'), /wsaa\.afip/);
});
