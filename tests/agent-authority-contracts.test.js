import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { parsePersonalAuthorityTap } from './support/personalAgentAuthorityHarnessRunner.js';
import * as contracts from './support/mutationAuthorityContracts.js';
import { discoverProductionGraph, validateMutationInventory, deriveAuthorityEvidence } from './support/productionMutationGraph.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = row => `${row.source}|${row.method}|${row.path}`;
const expected = new Map([
  ['src/routes/miAgente.js|POST|/connections', 'usuario_propio'],
  ['src/routes/miAgente.js|POST|/connections/:id/revoke', 'usuario_propio'],
  ['src/routes/agentTools.js|POST|/tools/:name', 'agente_personal_capability'],
]);
test('authority TAP rejects counters alone, skipped tests and wrong named cases', () => {
  // Synthetic parser fixture only; never accepted as a runtime proof.
  const names = [
    'personal authority: all roles, uid isolation, Origin, credential type, revocation and replay',
    'real REST + service + tools: atomic claims, replay/hash conflict, role/scope denial and error audit',
    'real reopening stays tenant-bound, rejects delivered and rolls back canonical handler failures',
  ];
  const summary = '\n1..3\n# tests 3\n# suites 0\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  const tap = 'TAP version 13\n' + names.map((name,index)=>`ok ${index+1} - ${name}`).join('\n') + summary;
  assert.equal(parsePersonalAuthorityTap(tap).assertions.length,3);
  for (const invalid of [summary,tap.replace(names[0],'decorative'),tap.replace('ok 1','not ok 1'),tap.replace(names[0],names[0]+' # SKIP'),tap.replace('# skipped 0','# skipped 1'),tap.replace('ok 3 - '+names[2],'')]) {
    assert.throws(()=>parsePersonalAuthorityTap(invalid),/authority TAP|skipped/);
  }
});

test('three exact personal mutations have endpoint-bound executable authority, without changing 191 legacy rows', () => {
  const graph = discoverProductionGraph({ root, entries: ['src/app.js'] });
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/production-mutation-inventory.json')));
  assert.equal(graph.mutations.length, 194);
  assert.equal(inventory.length, 194);
  assert.deepEqual(graph.mutations.filter(row => expected.has(key(row))).map(key).sort(), [...expected.keys()].sort());
  const personal = inventory.filter(row => expected.has(key(row)));
  assert.equal(personal.length, 3);
  assert.equal(inventory.filter(row => !expected.has(key(row))).length, 191);
  for (const row of personal) {
    assert.equal(row.classification, expected.get(key(row)));
    for (const metadata of [undefined, {...row.authorityEvidence, export:'publicAuthorityContract'}, {...row.authorityEvidence, module:'unregistered.js'}]) {
      assert.throws(() => deriveAuthorityEvidence({root,actual:graph.mutations,inventory:[{...row,authorityEvidence:metadata}]}),/authorityEvidence|contrato|módulo/i);
    }
    const args = { root, caseId: key(row), endpointKey: key(row), classification: row.classification, row };
    const outcome = contracts.personalAgentAuthorityContract(args);
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(contracts.validatePersonalAgentAuthorityProof(outcome.proof, args), true);
    assert.equal(contracts.validatePersonalAgentAuthorityProof(null, args), false);
    assert.equal(contracts.validatePersonalAgentAuthorityProof({ ...outcome.proof, results: {} }, args), false);
    assert.equal(contracts.validatePersonalAgentAuthorityProof(outcome.proof, { ...args, endpointKey: 'src/routes/auth.js|POST|/login' }), false);
    assert.equal(contracts.personalAgentAuthorityContract({ ...args, endpointKey: 'src/routes/auth.js|POST|/login' }).ok, false);
    assert.equal(contracts.personalAgentAuthorityContract({ ...args, classification: 'admin_exacto' }).ok, false);
    const drifted = structuredClone(inventory);
    drifted.find(item => key(item) === key(row)).authorityEvidence.case = [...expected.keys()].find(item => item !== key(row));
    assert.throws(() => validateMutationInventory({ actual: graph.mutations, inventory: drifted, root }), /autoridad|endpoint|case/i);
  }
});
