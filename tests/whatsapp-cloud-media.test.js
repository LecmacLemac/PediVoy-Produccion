import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createWhatsAppCloudMediaClient } from '../src/whatsappCloud/mediaClient.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]);
const sha256 = createHash('sha256').update(jpeg).digest('base64');

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

test('descarga media Cloud con metadata, Bearer, redirects deshabilitados y hash local', async () => {
  const calls = [];
  const client = createWhatsAppCloudMediaClient({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return jsonResponse({
        id: 'media-1', mime_type: 'image/jpeg', sha256, file_size: jpeg.length,
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/1',
      });
      return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) } });
    },
    timeoutMs: 1000,
    maxBytes: 1024,
  });

  const result = await client.download({
    mediaId: 'media-1', phoneNumberId: 'phone-2', accessToken: 'tenant-token',
    expectedMimeType: 'image/jpeg', expectedSha256: sha256,
  });

  assert.equal(calls[0].url, 'https://graph.facebook.com/v26.0/media-1?phone_number_id=phone-2');
  assert.equal(calls[0].options.headers.authorization, 'Bearer tenant-token');
  assert.equal(calls[1].options.redirect, 'manual');
  assert.equal(calls[1].options.headers.authorization, 'Bearer tenant-token');
  assert.deepEqual(result.buffer, jpeg);
  assert.equal(result.metadata.id, 'media-1');
  assert.equal(result.metadata.mimeType, 'image/jpeg');
  assert.equal(result.metadata.httpContentType, 'image/jpeg');
  assert.equal(result.metadata.size, jpeg.length);
  assert.equal(result.metadata.sha256, sha256);
});

test('normaliza Content-Type HTTP y descarta parámetros antes de devolver metadata', async () => {
  let calls = 0;
  const client = createWhatsAppCloudMediaClient({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({
        id: 'media-1', mime_type: 'image/jpeg', sha256, file_size: jpeg.length,
        url: 'https://lookaside.fbsbx.com/content-type',
      });
      return new Response(jpeg, {
        status: 200,
        headers: { 'content-type': ' Image/JPEG ; charset=binary ' },
      });
    },
  });

  const result = await client.download({
    mediaId: 'media-1', phoneNumberId: 'phone-2', accessToken: 'token', expectedSha256: sha256,
  });
  assert.equal(result.metadata.httpContentType, 'image/jpeg');
});

test('rechaza Content-Type HTTP ausente, vacío, inválido o múltiple antes de aceptar bytes', async () => {
  for (const contentType of [
    null, '', 'not-a-mime', 'image/jpeg, text/html',
    'image/jpeg; charset=binary, text/html',
    'image/jpeg; charset=binary, image/png',
  ]) {
    let calls = 0;
    const client = createWhatsAppCloudMediaClient({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({
          id: 'media-1', mime_type: 'image/jpeg', sha256, file_size: jpeg.length,
          url: 'https://lookaside.fbsbx.com/content-type-required',
        });
        return new Response(jpeg, {
          status: 200,
          headers: contentType == null ? {} : { 'content-type': contentType },
        });
      },
    });

    await assert.rejects(client.download({
      mediaId: 'media-1', phoneNumberId: 'phone-2', accessToken: 'token',
      expectedMimeType: 'image/jpeg', expectedSha256: sha256,
    }), error => error?.code === 'cloud_media_mime_mismatch', String(contentType));
  }
});

test('deadline abarca el body JSON de metadata que nunca termina y limpia timer unref', async () => {
  let aborted = false;
  let unrefCalls = 0;
  let clearCalls = 0;
  const setTimeoutImpl = (callback, delay) => {
    const timer = setTimeout(callback, delay);
    const originalUnref = timer.unref.bind(timer);
    timer.unref = () => { unrefCalls += 1; return originalUnref(); };
    return timer;
  };
  const client = createWhatsAppCloudMediaClient({
    fetchImpl: async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"media-1"'));
        options.signal.addEventListener('abort', () => {
          aborted = true;
          controller.error(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    timeoutMs: 100,
    setTimeoutImpl,
    clearTimeoutImpl: timer => { clearCalls += 1; clearTimeout(timer); },
  });

  await assert.rejects(Promise.race([
    client.download({ mediaId: 'media-1', phoneNumberId: 'phone-2', accessToken: 'token' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('test_timeout')), 500)),
  ]), error => error?.code === 'cloud_media_retryable' && error?.retryable === true);
  assert.equal(aborted, true);
  assert.equal(unrefCalls, 1);
  assert.equal(clearCalls, 1);
});

test('deadline aborta descarga si el body pausa entre chunks', async () => {
  let calls = 0;
  let byteBodyAborted = false;
  const client = createWhatsAppCloudMediaClient({
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 1) return jsonResponse({
        id: 'media-1', mime_type: 'image/jpeg', sha256, file_size: jpeg.length,
        url: 'https://lookaside.fbsbx.com/paused',
      });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(jpeg.subarray(0, 2));
          options.signal.addEventListener('abort', () => {
            byteBodyAborted = true;
            controller.error(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        },
      }), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
    timeoutMs: 100,
  });

  await assert.rejects(Promise.race([
    client.download({ mediaId: 'media-1', phoneNumberId: 'phone-2', accessToken: 'token' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('test_timeout')), 500)),
  ]), error => error?.code === 'cloud_media_retryable' && error?.retryable === true);
  assert.equal(byteBodyAborted, true);
});

test('rechaza URL no HTTPS, origen no Meta, redirects, oversize y hash mismatch', async () => {
  const scenarios = [
    { url: 'http://lookaside.fbsbx.com/a', response: jpeg, code: 'cloud_media_url_invalid' },
    { url: 'https://evil.example/a', response: jpeg, code: 'cloud_media_url_invalid' },
    { url: 'https://lookaside.fbsbx.com/a', response: null, status: 302, code: 'cloud_media_redirect_rejected' },
    { url: 'https://lookaside.fbsbx.com/a', response: Buffer.alloc(20), maxBytes: 10, code: 'cloud_media_too_large' },
    { url: 'https://lookaside.fbsbx.com/a', response: jpeg, expectedSha256: Buffer.alloc(32, 7).toString('base64'), code: 'cloud_media_hash_mismatch' },
  ];

  for (const scenario of scenarios) {
    const client = createWhatsAppCloudMediaClient({
      fetchImpl: async (_url, options) => {
        if (String(_url).includes('graph.facebook.com')) return jsonResponse({
          id: 'media-1', mime_type: 'image/jpeg', sha256, file_size: jpeg.length, url: scenario.url,
        });
        return new Response(scenario.response || null, { status: scenario.status || 200, headers: { 'content-type': 'image/jpeg' } });
      },
      maxBytes: scenario.maxBytes || 1024,
    });
    await assert.rejects(client.download({
      mediaId: 'media-1', phoneNumberId: 'phone-2', accessToken: 'token',
      expectedMimeType: 'image/jpeg', expectedSha256: scenario.expectedSha256 || sha256,
    }), error => error?.code === scenario.code, scenario.code);
  }
});

test('404 de URL refresca metadata una vez; 401/403 son terminales y 429/5xx retryable', async () => {
  let metadataCalls = 0;
  let byteCalls = 0;
  const client = createWhatsAppCloudMediaClient({
    fetchImpl: async url => {
      if (String(url).includes('graph.facebook.com')) {
        metadataCalls += 1;
        return jsonResponse({
          id: 'media-1', mime_type: 'image/jpeg', sha256, file_size: jpeg.length,
          url: `https://lookaside.fbsbx.com/${metadataCalls}`,
        });
      }
      byteCalls += 1;
      return byteCalls === 1
        ? new Response(null, { status: 404 })
        : new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
  });
  assert.deepEqual((await client.download({
    mediaId: 'media-1', phoneNumberId: 'phone-2', accessToken: 'token', expectedSha256: sha256,
  })).buffer, jpeg);
  assert.equal(metadataCalls, 2);

  for (const [status, code, retryable] of [[401, 'cloud_media_auth_failed', false], [403, 'cloud_media_auth_failed', false], [429, 'cloud_media_retryable', true], [503, 'cloud_media_retryable', true]]) {
    const failing = createWhatsAppCloudMediaClient({ fetchImpl: async () => new Response(null, { status }) });
    await assert.rejects(failing.download({ mediaId: 'm', phoneNumberId: 'p', accessToken: 't' }), error => {
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      return true;
    });
  }
});
