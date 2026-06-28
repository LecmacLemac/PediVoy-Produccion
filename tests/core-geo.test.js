import test from 'node:test';
import assert from 'node:assert/strict';

import { geocodeIfNeeded } from '../src/core/geo.js';

test('geocodeIfNeeded usa Nominatim como fallback cuando Google no resuelve', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

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
    assert.ok(calls.at(-1).includes('San%20Martin%20100'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
