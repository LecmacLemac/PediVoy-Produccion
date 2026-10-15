import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import puppeteer from 'puppeteer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createWithAuth } from '../src/core/auth.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { personalAgentHttpBoundary } from '../src/agents/httpBoundary.js';
import { mountPersonalAgentModules } from '../src/routes/mountPersonalAgents.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const root = path.resolve(import.meta.dirname, '..');
const canonicalOrigin = 'https://synthetic-agents.pedivoy.example';

test('real UI -> personal credential -> official MCP -> REST -> PostgreSQL -> audit -> revocation', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await pool.query(`CREATE TABLE empresas(id int PRIMARY KEY, plan_estado text, plan_vencimiento timestamptz);
      CREATE TABLE choferes(id int PRIMARY KEY, empresa_id int, activo boolean);
      CREATE TABLE referentes(id int PRIMARY KEY, empresa_id int, activo boolean, deleted_at timestamptz);
      CREATE TABLE usuarios(id int PRIMARY KEY, username text, role text, empresa_id int, chofer_id int, referente_id int, activo boolean);
      CREATE TABLE pedidos(id int PRIMARY KEY, empresa_id int, chofer_id int, punto_entrega_id int, monto numeric, estado text, fecha timestamptz, fecha_entrega timestamptz);
      INSERT INTO empresas VALUES(7,'active',NULL),(8,'active',NULL);
      INSERT INTO choferes VALUES(4,7,TRUE),(5,8,TRUE);
      INSERT INTO usuarios VALUES(1,'repartidor-sintetico','repartidor',7,4,NULL,TRUE);
      INSERT INTO pedidos VALUES(1,7,NULL,1,20,'pendiente',NOW(),NULL),(2,8,NULL,2,30,'pendiente',NOW(),NULL);`);
    await pool.query(await readFile(new URL('../src/agents/schema.sql', import.meta.url), 'utf8'));
    const query = async (sql, values) => (await pool.query(sql, values)).rows;
    const withTransaction = async (work, options) => {
      assert.equal(options.maxRetries, 0);
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const result = await work(async (sql, values) => (await connection.query(sql, values)).rows);
        await connection.query('COMMIT'); return result;
      } catch (error) { await connection.query('ROLLBACK'); throw error; }
      finally { connection.release(); }
    };
    const jwtSecret = randomUUID();
    const withAuth = createWithAuth({ queryFn: query, jwtSecret });
    const app = express();
    app.use(personalAgentHttpBoundary({ canonicalOrigin }));
    app.use(cors({ origin: true, credentials: true }));
    app.use(express.json({ limit: '1mb' }));
    app.use(cookieParser());
    app.use('/api', createAuthRouter({ queryFn: query, withAuth }));
    mountPersonalAgentModules(app, { query, withTransaction, withAuth, personalAgentsEnabled: true, agentCanonicalOrigin: canonicalOrigin });
    app.use('/pedidos', express.static(path.join(root, 'pedidos')));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const localOrigin = `http://127.0.0.1:${server.address().port}`;
    let browser, client, transport;
    const errors = [];
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 980 });
      await page.setCookie({ name: 'token', value: jwt.sign({ uid: 1, role: 'repartidor' }, jwtSecret, { expiresIn: '5m' }), domain: 'synthetic-agents.pedivoy.example', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
      page.on('pageerror', error => errors.push(error.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        void (async () => {
          if (!request.url().startsWith(canonicalOrigin + '/')) return request.abort();
          const target = new URL(request.url());
          const headers = { ...request.headers() };
          delete headers.host; delete headers['content-length'];
          const response = await fetch(localOrigin + target.pathname + target.search, { method: request.method(), headers, body: ['GET','HEAD'].includes(request.method()) ? undefined : request.postData(), redirect: 'manual' });
          const responseHeaders = Object.fromEntries(response.headers);
          delete responseHeaders['content-encoding']; delete responseHeaders['content-length']; delete responseHeaders['transfer-encoding'];
          await request.respond({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) });
        })().catch(() => request.abort().catch(() => {}));
      });
      await page.goto(canonicalOrigin + '/pedidos/mi-agente.html');
      await page.waitForFunction(() => document.querySelector('#status')?.dataset.ready === 'true');
      assert.equal(await page.$eval('#create', node => node.disabled), false);
      assert.equal(await page.$eval('input[value="deliveries:claim"]', node => node.checked), false);
      await page.type('#name', 'Piloto sintético de extremo a extremo');
      await page.click('input[value="deliveries:claim"]');
      await page.click('#create');
      await page.waitForSelector('#token-dialog[open]');
      const token = await page.$eval('#token', node => node.value);
      assert.match(token, /^pva_/);
      assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0,0]);
      await page.click('#close-token');
      assert.equal(await page.$eval('#token', node => node.value), '');
      client = new Client({ name: 'pedivoy-e2e-synthetic', version: '1.0.0' });
      transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'pedidos/agent-bridge.mjs')], env: { PATH: process.env.PATH, HOME: process.env.HOME, PEDIVOY_AGENT_URL: localOrigin, PEDIVOY_AGENT_TOKEN: token, PEDIVOY_AGENT_ALLOW_HTTP_LOOPBACK: '1' }, stderr: 'pipe' });
      let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(names.includes('tomar_pedido')); assert.ok(!names.includes('reabrir_pedido_cancelado'));
      const identity = await client.callTool({ name: 'mi_identidad', arguments: {} });
      assert.equal(JSON.parse(identity.content[0].text).empresa_id, 7);
      const operation = { name: 'tomar_pedido', arguments: { pedido_id: 1, operation_id: randomUUID() } };
      const result = await client.callTool(operation);
      assert.notEqual(result.isError, true);
      assert.deepEqual(JSON.parse(result.content[0].text), { pedido_id: 1, ok: true });
      const replay = await client.callTool(operation);
      assert.notEqual(replay.isError, true);
      assert.deepEqual(JSON.parse(replay.content[0].text), JSON.parse(result.content[0].text));
      const crossTenant = await client.callTool({ name: 'tomar_pedido', arguments: { pedido_id: 2, operation_id: randomUUID() } });
      assert.equal(crossTenant.isError, true);
      assert.deepEqual((await pool.query('SELECT id,chofer_id,estado FROM pedidos ORDER BY id')).rows, [ { id:1, chofer_id:4, estado:'pendiente' }, { id:2, chofer_id:null, estado:'pendiente' } ]);
      await page.click('#refresh');
      await page.waitForFunction(() => document.querySelector('#audit').textContent.includes('tomar_pedido'));
      assert.match(await page.$eval('#audit', node => node.textContent), /tomar_pedido · ok ·/);
      assert.doesNotMatch(await page.content(), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      page.once('dialog', dialog => dialog.accept());
      await page.click('[data-revoke]');
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Conexión revocada'));
      await assert.rejects(client.listTools());
      const raw = await fetch(localOrigin + '/api/agent/v1/tools', { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(raw.status, 401);
      assert.equal(stderr.includes(token), false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(process.env.TMPDIR, 'mi-agente-e2e-desktop.png'), fullPage: true });
    } finally {
      await client?.close().catch(() => {});
      await transport?.close().catch(() => {});
      await browser?.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  });
});
