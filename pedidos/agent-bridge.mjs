#!/usr/bin/env node
// Local stdio bridge. Never use a human session JWT here.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const MAX_BYTES = 1024 * 1024;
const fail = () => new Error('No se pudo completar la operación de PediVoy. Verificá conexión, permisos y vigencia.');
let origin, token;
try {
  const url = new URL(process.env.PEDIVOY_AGENT_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && process.env.PEDIVOY_AGENT_ALLOW_HTTP_LOOPBACK === '1'))) throw fail();
  origin = url.origin;
  token = process.env.PEDIVOY_AGENT_TOKEN;
  if (!token || token.length > 4096 || /\s/.test(token) || token.split('.').length === 3) throw fail();
} catch {
  process.stderr.write('PediVoy: configuración inválida. Usá un origen HTTPS y un token dedicado; HTTP sólo en loopback con autorización de desarrollo.\n');
  process.exit(1);
}
const timeout = Math.min(30000, Math.max(100, Number(process.env.PEDIVOY_AGENT_TIMEOUT_MS) || 15000));
async function api(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > MAX_BYTES) throw fail();
    const response = await fetch(`${origin}/api/agent/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(serialized ? {'Content-Type':'application/json'} : {}) }, body: serialized
    });
    if (!response.ok) { await response.body?.cancel(); throw fail(); }
    const reader = response.body.getReader(); let bytes = 0; const chunks=[];
    for (;;) {
      const {done,value} = await reader.read(); if(done) break;
      bytes += value.byteLength; if(bytes > MAX_BYTES) { await reader.cancel(); throw fail(); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw fail(); } finally { clearTimeout(timer); }
}
async function tools() {
  const data = await api('tools');
  if(!Array.isArray(data.tools) || data.tools.length > 200) throw fail();
  for(const tool of data.tools) if(typeof tool.name !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(tool.name) || tool.inputSchema?.type !== 'object' || typeof tool.readOnly !== 'boolean') throw fail();
  return data.tools;
}
const server = new Server({name:'pedivoy-personal-agent',version:'1.0.0'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => {
  try { return {tools:(await tools()).map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema,annotations:{readOnlyHint:t.readOnly,destructiveHint:!t.readOnly}}))}; }
  catch { throw new McpError(ErrorCode.InternalError, fail().message); }
});
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const current = (await tools()).find(t=>t.name === request.params.name);
    if(!current) throw fail();
    const args = request.params.arguments ?? {};
    if(!current.readOnly && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.operation_id ?? '')) throw fail();
    const data = await api(`tools/${encodeURIComponent(current.name)}`, {arguments:args});
    if(data.ok !== true || !Object.hasOwn(data,'result')) throw fail();
    return {content:[{type:'text',text:JSON.stringify(data.result)}]};
  } catch { return {isError:true,content:[{type:'text',text:fail().message}]}; }
});
server.onerror = () => process.stderr.write('PediVoy: error de protocolo MCP.\n');
process.on('uncaughtException',()=>{process.stderr.write('PediVoy: error interno.\n');process.exit(1);});
process.on('unhandledRejection',()=>{process.stderr.write('PediVoy: operación no disponible.\n');process.exit(1);});
await server.connect(new StdioServerTransport());
