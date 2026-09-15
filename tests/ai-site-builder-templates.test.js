import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';

import { createAiSiteBuilderRouter } from '../src/routes/aiSiteBuilder.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildApp({ authenticated = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', createAiSiteBuilderRouter({
    projectDir: path.resolve('.'),
    query: async () => [],
    withAuth(_req, res, next) {
      if (!authenticated) return res.status(401).json({ error: 'No token' });
      return next();
    },
    isSuper: () => false,
    getEmpresaIdFromToken: () => 1,
  }));
  return app;
}

test('GET /api/ai/landing-templates lista solo plantillas disponibles', async () => {
  const app = buildApp();

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/ai/landing-templates`);
    const body = await resp.json();

    assert.equal(resp.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.templates.length >= 1);
    assert.ok(body.templates.some((template) => template.id === 'multiempresa-pro'));
    assert.ok(body.templates.every((template) => !('file' in template)));
  });
});

test('GET /api/ai/landing-templates/:id devuelve HTML de una plantilla permitida', async () => {
  const app = buildApp();

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/ai/landing-templates/multiempresa-pro`);
    const body = await resp.json();

    assert.equal(resp.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.template.id, 'multiempresa-pro');
    assert.match(body.html, /<!doctype html>|<html/i);
  });
});

test('GET /api/ai/landing-templates/:id rechaza ids fuera de allowlist', async () => {
  const app = buildApp();

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/ai/landing-templates/..%2Fserver`);
    const body = await resp.json();

    assert.equal(resp.status, 404);
    assert.equal(body.error, 'Plantilla no encontrada');
  });
});

test('GET /api/ai/landing-templates requiere autenticacion', async () => {
  const app = buildApp({ authenticated: false });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/ai/landing-templates`);
    const body = await resp.json();

    assert.equal(resp.status, 401);
    assert.equal(body.error, 'No token');
  });
});
