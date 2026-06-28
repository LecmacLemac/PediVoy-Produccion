import test from 'node:test';
import assert from 'node:assert/strict';

import { geocodeIfNeeded } from '../src/core/geo.js';

test('geocodeIfNeeded usa Nominatim como fallback cuando Google no resuelve', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let nominatimCalls = 0;

  globalThis.fetch = async (url) => {
    calls.push(String(url));

    if (String(url).includes('maps.googleapis.com')) {
      return {
        ok: true,
        async json() {
          return { results: [] };
        },
      };
    }

    if (String(url).includes('nominatim.openstreetmap.org')) {
      nominatimCalls += 1;
      return {
        ok: true,
        async json() {
          return [{ lat: '-32.411300', lon: '-63.237400' }];
        },
      };
    }

    throw new Error(`URL inesperada: ${url}`);
  };

  try {
    const loc = await geocodeIfNeeded({
      direccion: 'San Martin 100',
      ciudad: 'Villa Maria',
      provincia: 'Cordoba',
      pais: 'Argentina',
    });

    assert.deepEqual(loc, { lat: -32.4113, lng: -63.2374 });
    assert.ok(calls.some((url) => url.includes('nominatim.openstreetmap.org')));
    assert.equal(nominatimCalls, 1);
    assert.match(calls.at(-1), /country=Argentina|q=San%20Martin%20100/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('geocodeIfNeeded prueba variantes menos estrictas si la dirección completa no resuelve', async () => {
  const originalFetch = globalThis.fetch;
  const nominatimUrls = [];

  globalThis.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.includes('maps.googleapis.com')) {
      return {
        ok: true,
        async json() {
          return { results: [] };
        },
      };
    }

    if (urlText.includes('nominatim.openstreetmap.org')) {
      nominatimUrls.push(urlText);
      return {
        ok: true,
        async json() {
          if (urlText.includes('q=San%20Martin%20100%2C%20Villa%20Maria%2C%20Argentina')) {
            return [{ lat: '-32.411300', lon: '-63.237400' }];
          }
          return [];
        },
      };
    }

    throw new Error(`URL inesperada: ${url}`);
  };

  try {
    const loc = await geocodeIfNeeded({
      direccion: 'San Martin 100',
      ciudad: 'Villa Maria',
      provincia: 'Cordoba',
      pais: 'AR',
    });

    assert.deepEqual(loc, { lat: -32.4113, lng: -63.2374 });
    assert.ok(nominatimUrls.length >= 2);
    assert.ok(nominatimUrls.some((url) => url.includes('country=Argentina')));
    assert.ok(nominatimUrls.some((url) => url.includes('Villa%20Maria%2C%20Argentina')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
