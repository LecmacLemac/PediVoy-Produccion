import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { spawn } from 'node:child_process';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const bridge = new URL('../pedidos/agent-bridge.mjs', import.meta.url).pathname;
for(const [url,token,dev] of [['http://public.example','synthetic-secret','1'],['http://127.0.0.1','synthetic-secret','0'],['https://example.com/path','synthetic-secret','0'],['https://synthetic-secret@example.com','synthetic-secret','0'],['https://example.com?token=synthetic-secret','synthetic-secret','0'],['https://example.com','human.jwt.token','0']])test(`invalid bridge environment is rejected safely: ${url.includes('synthetic-secret')?'credentialed URL':url} / ${dev}`,async()=>{
 const child=spawn(process.execPath,[bridge],{env:{...process.env,PEDIVOY_AGENT_URL:url,PEDIVOY_AGENT_TOKEN:token,PEDIVOY_AGENT_ALLOW_HTTP_LOOPBACK:dev},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
 const code=await new Promise(r=>child.once('close',r));assert.equal(code,1);assert.equal(stdout,'');assert.ok(!stderr.includes('synthetic-secret'));assert.ok(!stderr.includes(token));
});
async function fixture(t) {
  const app = express(); app.use(express.json());
  const state = { mode: 'ok', calls: [], lists: 0 };
  app.get('/api/agent/v1/tools', (req,res) => {
    state.lists++; assert.equal(req.headers.authorization, 'Bearer synthetic-secret');
    if (state.mode === 'revoked') return res.status(401).json({error:{code:'REVOKED',message:'synthetic-secret'}});
    res.json({tools:[{name:'orders_reopen',description:'Reabrir',scope:'orders:reopen',inputSchema:{type:'object',properties:{operation_id:{type:'string',format:'uuid'}},required:['operation_id']},readOnly:false}]});
  });
  app.post('/api/agent/v1/tools/:name', (req,res) => {
    state.calls.push(req.body);
    if(state.mode==='timeout') return;
    if(state.mode==='redirect') return res.redirect('http://localhost:1/leak');
    if(state.mode==='large') return res.send('x'.repeat(1100000));
    if(state.mode==='invalid') return res.send('not json synthetic-secret');
    if(state.mode==='error') return res.status(403).json({ok:false,error:{code:'FORBIDDEN',message:'synthetic-secret'}});
    res.json({ok:true,result:{operation_id:req.body.arguments.operation_id}});
  });
  const http = app.listen(0,'127.0.0.1'); await new Promise(r=>http.once('listening',r));
  const transport = new StdioClientTransport({command:process.execPath,args:[bridge],env:{...process.env,PEDIVOY_AGENT_URL:`http://127.0.0.1:${http.address().port}`,PEDIVOY_AGENT_TOKEN:'synthetic-secret',PEDIVOY_AGENT_ALLOW_HTTP_LOOPBACK:'1',PEDIVOY_AGENT_TIMEOUT_MS:'100'},stderr:'pipe'});
  let stderr=''; transport.stderr?.on('data',chunk=>stderr+=chunk);
  const client = new Client({name:'synthetic-test',version:'1.0.0'});
  t.after(async()=>{await client.close();http.closeAllConnections();await new Promise(r=>http.close(r));assert.ok(!stderr.includes('synthetic-secret'));});
  await client.connect(transport);
  return {client,state};
}
test('official MCP client discovers current tools, preserves operation ID on replay and denies revoked connections',async t=>{
  const {client,state}=await fixture(t);
  assert.equal((await client.listTools()).tools[0].name,'orders_reopen');
  const args={operation_id:'123e4567-e89b-42d3-a456-426614174000'};
  for(let i=0;i<2;i++) assert.ok(!(await client.callTool({name:'orders_reopen',arguments:args})).isError);
  assert.deepEqual(state.calls,[{arguments:args},{arguments:args}]);
  assert.equal((await client.callTool({name:'orders_reopen',arguments:{}})).isError,true);
  assert.equal(state.calls.length,2);
  state.mode='revoked'; await assert.rejects(client.listTools());
  assert.ok(state.lists>=2);
});
for(const mode of ['error','invalid','redirect','large','timeout']) test(`MCP marks ${mode} as error without secret leakage or retries`,async t=>{
  const {client,state}=await fixture(t);state.mode=mode;
  const result=await client.callTool({name:'orders_reopen',arguments:{operation_id:'123e4567-e89b-42d3-a456-426614174000'}});
  assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes('synthetic-secret'));assert.equal(state.calls.length,1);
});
