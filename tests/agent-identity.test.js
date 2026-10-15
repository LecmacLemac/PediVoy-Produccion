import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../src/core/auth.js';

test('canonical loader rejects inactive identity and preserves role/link validation', async () => {
  assert.equal(typeof auth.loadCanonicalIdentity, 'function');
  const row = {id:1,username:'synthetic',role:'user',empresa_id:2,chofer_id:null,referente_id:null,activo:true};
  assert.equal((await auth.loadCanonicalIdentity(1,{query:async()=>[row]})).uid,1);
  assert.equal(await auth.loadCanonicalIdentity(1,{query:async()=>[{...row,activo:false}]}),null);
  assert.equal(await auth.loadCanonicalIdentity(1,{query:async()=>[{...row,role:'repartidor'}]}),null);
  assert.equal(await auth.loadCanonicalIdentity(1,{query:async()=>[{...row,empresa_id:null}]}),null);
});
