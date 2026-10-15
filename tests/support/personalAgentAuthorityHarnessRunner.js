import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const cases = [
  'personal authority: all roles, uid isolation, Origin, credential type, revocation and replay',
  'real REST + service + tools: atomic claims, replay/hash conflict, role/scope denial and error audit',
  'real reopening stays tenant-bound, rejects delivered and rolls back canonical handler failures',
];
const cache = new Map();
// In-memory only: every new gate process must execute the real isolated-PG tests.
// Include all local source dependencies, DDL, harnesses and their helpers in the key.
export function personalAuthoritySourceHash(root) {
  const hash = crypto.createHash('sha256');
  const visit = relative => {
    const absolute = path.join(root, relative);
    if (fs.statSync(absolute).isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative,name));
    } else if (/\.(?:js|json|sql)$/.test(relative)) {
      hash.update(relative); hash.update(fs.readFileSync(absolute));
    }
  };
  for (const relative of ['src','tests/support','tests/agent-authority-harness.test.js','tests/agent-tools-integration.test.js','package.json','package-lock.json']) visit(relative);
  return hash.digest('hex');
}

export function parsePersonalAuthorityTap(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('TAP version 13\n') || /^(?:not ok|Bail out!)/m.test(raw)) throw Error('authority TAP failure');
  const passed = [...raw.matchAll(/^ok (\d+) - (.+)$/gm)];
  if (passed.length !== cases.length || passed.some((match,index) => Number(match[1]) !== index+1 || match[2] !== cases[index])) throw Error('authority TAP missing/mismatched executable cases');
  for (const line of ['1..3','# tests 3','# suites 0','# pass 3','# fail 0','# cancelled 0','# skipped 0','# todo 0']) {
    if (raw.split('\n').filter(item=>item===line).length !== 1) throw Error('authority TAP invalid summary');
  }
  if (/^ok .*#\s*(?:SKIP|TODO)\b/im.test(raw)) throw Error('authority tests skipped');
  return {assertions:cases.map(name=>({name,ok:true})), results:{tests:3,pass:3,fail:0,skipped:0}};
}

export function runPersonalAgentAuthorityHarness(root) {
  const sourceHash = personalAuthoritySourceHash(root);
  const key = `${root}:${sourceHash}`;
  if (!cache.has(key)) {
    const raw = execFileSync(process.execPath, ['--test','--test-reporter=tap','tests/agent-authority-harness.test.js','tests/agent-tools-integration.test.js'], {
      cwd:root,encoding:'utf8',timeout:60_000,maxBuffer:2*1024*1024,
      // Do not inherit app DB configuration or preloaded dotenv hooks.
      env: {PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C',NODE_ENV:'test',
        DOTENV_CONFIG_PATH:'/dev/null',DATABASE_URL:'postgresql://127.0.0.1:1/unused_authority_gate'},
      stdio:['ignore','pipe','pipe'],
    });
    const parsed = parsePersonalAuthorityTap(raw);
    if (personalAuthoritySourceHash(root) !== sourceHash) throw Error('authority source changed during execution');
    cache.set(key,{...parsed,results:{...parsed.results,sourceHash}});
  }
  return structuredClone(cache.get(key));
}
