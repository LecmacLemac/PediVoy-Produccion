import test from 'node:test';
import assert from 'node:assert/strict';

test('scope policy covers seven roles and never promotes old grants', async()=>{
 const p=await import('../src/agents/policy.js');
 const expected={user:['identity:read','catalog:read','orders:read','billing:read'],repartidor:['identity:read','deliveries:read','deliveries:claim'],referente:['identity:read','catalog:read','referrals:read'],facturacion:['identity:read','billing:read'],contable:['identity:read','billing:read'],admin:['identity:read','catalog:read','orders:read','billing:read','orders:reopen'],super:['identity:read','catalog:read','orders:read','billing:read','orders:reopen']};
 for(const [role,scopes] of Object.entries(expected)) assert.deepEqual(p.allowedScopesForRole(role),scopes);
 assert.deepEqual(p.effectiveScopes({scopes:['orders:reopen','identity:read'],role_at_issue:'user'},{role:'admin'}),['identity:read']);
 assert.deepEqual(p.allowedScopesForRole('unknown'),[]);
});
