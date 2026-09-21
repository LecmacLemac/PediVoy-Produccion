import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runMaintenance, loadPolicy, parseArgs } from '../scripts/storage-maintenance.js';
import { preparePuppeteerCache } from '../scripts/prepare-puppeteer-cache.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pedivoy-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function mkdirOld(target, now, ageDays = 40) {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'data.bin'), Buffer.alloc(17, 1));
  const stamp = new Date(now.getTime() - ageDays * 86_400_000);
  await fs.utimes(target, stamp, stamp);
  await fs.utimes(path.join(target, 'data.bin'), stamp, stamp);
}

function policy(root) {
  return {
    version: 1,
    minimumAgeDays: 30,
    cacheRoots: [path.join(root, 'profiles')],
    cacheDirectoryAllowlist: ['Cache', 'Code Cache', 'GPUCache'],
    protectedPathNames: ['auth', 'storage', 'IndexedDB', 'uploads', 'DB'],
    protectedPathPrefixes: ['Singleton'],
    puppeteer: {
      cacheRoot: path.join(root, 'puppeteer'),
      expectedVersions: ['chrome@expected'],
    },
  };
}

test('dry-run reports old allowlisted cache without deleting it', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  const cache = path.join(root, 'profiles', 'session-a', 'Cache');
  await mkdirOld(cache, now);

  const report = await runMaintenance({ policy: policy(root), now, apply: false, processEntries: [] });

  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.candidates.map(({ path: candidate }) => candidate), [cache]);
  assert.equal(report.bytes, 17);
  await fs.access(cache);
});

test('minimum age uses the newest entry in a cache tree', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  const cache = path.join(root, 'profiles', 'session-a', 'Cache');
  await mkdirOld(cache, now);
  const recent = new Date(now.getTime() - 2 * 86_400_000);
  await fs.utimes(path.join(cache, 'data.bin'), recent, recent);

  const report = await runMaintenance({ policy: policy(root), now, apply: true, processEntries: [] });

  assert.deepEqual(report.candidates, []);
  assert.ok(report.skipped.some((item) => item.path === cache && item.reason === 'minimum-age'));
  await fs.access(cache);
});

test('never enters protected paths and reports symlinks as skipped', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  const profiles = path.join(root, 'profiles');
  const protectedCaches = [
    path.join(profiles, 'auth', 'Cache'),
    path.join(profiles, 'storage', 'Cache'),
    path.join(profiles, 'IndexedDB', 'Cache'),
    path.join(profiles, 'uploads', 'Cache'),
    path.join(profiles, 'DB', 'Cache'),
    path.join(profiles, 'SingletonLock', 'Cache'),
  ];
  for (const cache of protectedCaches) await mkdirOld(cache, now);
  const outside = path.join(root, 'outside', 'Cache');
  await mkdirOld(outside, now);
  const link = path.join(profiles, 'linked-cache');
  await fs.mkdir(profiles, { recursive: true });
  await fs.symlink(outside, link);

  const report = await runMaintenance({ policy: policy(root), now, apply: true, processEntries: [] });

  assert.deepEqual(report.candidates, []);
  assert.ok(report.skipped.some((item) => item.path === link && item.reason === 'symlink'));
  for (const cache of protectedCaches) await fs.access(cache);
  await fs.access(outside);
});

test('keeps an allowlisted cache when it contains a protected segment', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  const cache = path.join(root, 'profiles', 'session-a', 'Cache');
  const protectedFile = path.join(cache, 'IndexedDB', 'record.bin');
  await fs.mkdir(path.dirname(protectedFile), { recursive: true });
  await fs.writeFile(protectedFile, 'persistent');
  const old = new Date(now.getTime() - 40 * 86_400_000);
  await fs.utimes(cache, old, old);
  await fs.utimes(path.dirname(protectedFile), old, old);
  await fs.utimes(protectedFile, old, old);

  const report = await runMaintenance({ policy: policy(root), now, apply: true, processEntries: [] });

  assert.deepEqual(report.candidates, []);
  assert.ok(report.skipped.some((item) => item.path === cache && item.reason === 'contains-protected-path'));
  await fs.access(protectedFile);
});

test('apply aborts if a managed root becomes a symlink after scanning', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  const profiles = path.join(root, 'profiles');
  const cache = path.join(profiles, 'session-a', 'Cache');
  const outside = path.join(root, 'outside');
  const outsideCache = path.join(outside, 'session-a', 'Cache');
  await mkdirOld(cache, now);
  await mkdirOld(outsideCache, now);

  await assert.rejects(runMaintenance({
    policy: policy(root),
    now,
    apply: true,
    processEntries: [],
    beforeApply: async () => {
      await fs.rm(profiles, { recursive: true });
      await fs.symlink(outside, profiles);
    },
  }), /managed root changed or became a symlink/);
  await fs.access(outsideCache);
});

test('apply rechecks a candidate after scanning and preserves newly protected data', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  const cache = path.join(root, 'profiles', 'session-a', 'Cache');
  const protectedFile = path.join(cache, 'IndexedDB', 'new.bin');
  await mkdirOld(cache, now);

  await assert.rejects(runMaintenance({
    policy: policy(root),
    now,
    apply: true,
    processEntries: [],
    beforeApply: async () => {
      await fs.mkdir(path.dirname(protectedFile));
      await fs.writeFile(protectedFile, 'new persistent data');
    },
  }), /candidate is no longer eligible/);
  await fs.access(protectedFile);
});

test('fails closed when a managed root is unsafe or a symlink', async (t) => {
  const root = await fixture(t);
  const realRoot = path.join(root, 'real-profiles');
  const linkedRoot = path.join(root, 'profiles-link');
  await fs.mkdir(realRoot);
  await fs.symlink(realRoot, linkedRoot);

  const linkedPolicy = policy(root);
  linkedPolicy.cacheRoots = [linkedRoot];
  await assert.rejects(
    runMaintenance({ policy: linkedPolicy, processEntries: [] }),
    /managed root is a symlink/,
  );

  const parent = path.join(root, 'parent');
  const parentAlias = path.join(root, 'parent-alias');
  await fs.mkdir(path.join(parent, 'profiles'), { recursive: true });
  await fs.symlink(parent, parentAlias);
  const ancestorPolicy = policy(root);
  ancestorPolicy.cacheRoots = [path.join(parentAlias, 'profiles')];
  await assert.rejects(
    runMaintenance({ policy: ancestorPolicy, processEntries: [] }),
    /symlinked ancestor/,
  );

  const unsafePolicy = policy(root);
  unsafePolicy.cacheRoots = [path.parse(root).root];
  await assert.rejects(
    runMaintenance({ policy: unsafePolicy, processEntries: [] }),
    /unsafe managed root/,
  );
});

test('preserves caches below active Chromium user-data directories', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  const activeProfile = path.join(root, 'profiles', 'active');
  const activeAlias = path.join(root, 'active-profile-alias');
  const activeCache = path.join(activeProfile, 'Cache');
  const inactiveCache = path.join(root, 'profiles', 'inactive', 'Cache');
  await mkdirOld(activeCache, now);
  await fs.symlink(activeProfile, activeAlias);
  await mkdirOld(inactiveCache, now);

  const report = await runMaintenance({
    policy: policy(root),
    now,
    apply: true,
    processEntries: [
      { pid: 100, cwd: root, cmdline: ['chromium', `--user-data-dir=${activeAlias}`] },
      { pid: 101, cwd: root, cmdline: ['chromium', '--user-data-dir', path.join(root, 'other')] },
    ],
  });

  assert.deepEqual(report.candidates.map((item) => item.path), [inactiveCache]);
  assert.ok(report.skipped.some((item) => item.path === activeCache && item.reason === 'active-profile'));
  await fs.access(activeCache);
  await assert.rejects(fs.access(inactiveCache), { code: 'ENOENT' });

  await assert.rejects(runMaintenance({
    policy: policy(root),
    processEntries: [{ pid: 102, cmdline: ['chromium', '--user-data-dir', 'relative-profile'] }],
  }), /cannot resolve relative user-data-dir/);
});

test('apply refreshes process activity before each candidate removal', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  const first = path.join(root, 'profiles', 'a', 'Cache');
  const secondProfile = path.join(root, 'profiles', 'b');
  const second = path.join(secondProfile, 'Cache');
  await mkdirOld(first, now);
  await mkdirOld(second, now);
  let calls = 0;

  await assert.rejects(runMaintenance({
    policy: policy(root),
    now,
    apply: true,
    processEntriesProvider: async () => {
      calls += 1;
      return calls >= 3
        ? [{ pid: 300, cwd: root, cmdline: ['chromium', `--user-data-dir=${secondProfile}`] }]
        : [];
    },
  }), /candidate is no longer eligible/);

  await assert.rejects(fs.access(first), { code: 'ENOENT' });
  await fs.access(second);
  assert.ok(calls >= 3);
});

test('removes only old Puppeteer versions that are neither expected nor active', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  const versions = {
    expected: path.join(root, 'puppeteer', 'chrome', 'chrome@expected'),
    active: path.join(root, 'puppeteer', 'chrome', 'chrome@active'),
    stale: path.join(root, 'puppeteer', 'chrome', 'chrome@stale'),
    protected: path.join(root, 'puppeteer', 'chrome', 'chrome@protected'),
    protectedProduct: path.join(root, 'puppeteer', 'auth'),
    fresh: path.join(root, 'puppeteer', 'chrome', 'chrome@fresh'),
  };
  await fs.mkdir(path.join(root, 'profiles'));
  await mkdirOld(versions.expected, now);
  await mkdirOld(versions.active, now);
  await mkdirOld(versions.stale, now);
  await mkdirOld(versions.protected, now);
  await fs.mkdir(path.join(versions.protected, 'IndexedDB'));
  await mkdirOld(path.join(versions.protectedProduct, 'old-version'), now);
  await mkdirOld(versions.fresh, now, 2);

  const report = await runMaintenance({
    policy: policy(root),
    now,
    apply: true,
    processEntries: [{
      pid: 200,
      cwd: root,
      exe: path.join(versions.active, 'chrome'),
      cmdline: ['chrome'],
    }],
  });

  assert.ok(report.candidates.some((item) => item.path === versions.stale && item.reason === 'unused-puppeteer-version'));
  assert.ok(report.skipped.some((item) => item.path === versions.expected && item.reason === 'expected-puppeteer-version'));
  assert.ok(report.skipped.some((item) => item.path === versions.active && item.reason === 'active-puppeteer-version'));
  assert.ok(report.skipped.some((item) => item.path === versions.protected && item.reason === 'contains-protected-path'));
  assert.ok(report.skipped.some((item) => item.path === versions.protectedProduct && item.reason === 'protected'));
  assert.ok(report.skipped.some((item) => item.path === versions.fresh && item.reason === 'minimum-age'));
  await assert.rejects(fs.access(versions.stale), { code: 'ENOENT' });
  await fs.access(versions.expected);
  await fs.access(versions.active);
  await fs.access(versions.protected);
  await fs.access(versions.protectedProduct);
  await fs.access(versions.fresh);
});

test('manages multiple Puppeteer roots and safely reports a missing root', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  await fs.mkdir(path.join(root, 'profiles'));
  const firstRoot = path.join(root, 'puppeteer-project');
  const secondRoot = path.join(root, 'puppeteer-home');
  const missingRoot = path.join(root, 'puppeteer-missing');
  const expectedFirst = path.join(firstRoot, 'chrome', 'chrome@expected');
  const expectedSecond = path.join(secondRoot, 'chrome', 'chrome@expected');
  const activeFirst = path.join(firstRoot, 'chrome', 'chrome@active-first');
  const activeSecond = path.join(secondRoot, 'chrome', 'chrome@active');
  const staleFirst = path.join(firstRoot, 'chrome', 'chrome@stale-first');
  const staleSecond = path.join(secondRoot, 'chrome', 'chrome@stale-second');
  for (const target of [expectedFirst, expectedSecond, activeFirst, activeSecond, staleFirst, staleSecond]) {
    await mkdirOld(target, now);
  }
  const multiRootPolicy = policy(root);
  multiRootPolicy.puppeteer = {
    cacheRoots: [firstRoot, secondRoot, missingRoot],
    expectedVersions: ['chrome@expected'],
  };

  const report = await runMaintenance({
    policy: multiRootPolicy,
    now,
    apply: true,
    processEntries: [
      { pid: 200, cwd: root, exe: path.join(activeFirst, 'chrome'), cmdline: ['chrome'] },
      { pid: 201, cwd: root, exe: path.join(activeSecond, 'chrome'), cmdline: ['chrome'] },
    ],
  });

  assert.deepEqual(
    report.candidates.filter((item) => item.reason === 'unused-puppeteer-version').map((item) => item.path).sort(),
    [staleFirst, staleSecond].sort(),
  );
  assert.ok(report.skipped.some((item) => item.path === missingRoot && item.reason === 'missing-root'));
  await fs.access(expectedFirst);
  await fs.access(expectedSecond);
  await fs.access(activeFirst);
  await fs.access(activeSecond);
  await assert.rejects(fs.access(staleFirst), { code: 'ENOENT' });
  await assert.rejects(fs.access(staleSecond), { code: 'ENOENT' });
});

test('fails closed when a secondary Puppeteer root becomes a symlink after scanning', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  await fs.mkdir(path.join(root, 'profiles'));
  const primary = path.join(root, 'puppeteer-primary');
  const secondary = path.join(root, 'puppeteer-secondary');
  const outside = path.join(root, 'outside');
  const stale = path.join(secondary, 'chrome', 'chrome@stale');
  const outsideStale = path.join(outside, 'chrome', 'chrome@stale');
  await fs.mkdir(primary);
  await mkdirOld(stale, now);
  await mkdirOld(outsideStale, now);
  const multiRootPolicy = policy(root);
  multiRootPolicy.puppeteer.cacheRoots = [primary, secondary];

  await assert.rejects(runMaintenance({
    policy: multiRootPolicy,
    now,
    apply: true,
    processEntries: [],
    beforeApply: async () => {
      await fs.rm(secondary, { recursive: true });
      await fs.symlink(outside, secondary);
    },
  }), /managed root changed or became a symlink/);
  await fs.access(outsideStale);
});

test('rechecks a legacy Puppeteer version that becomes active before removal', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  await fs.mkdir(path.join(root, 'profiles'));
  const canonical = path.join(root, 'puppeteer-home');
  const legacy = path.join(root, 'puppeteer-project');
  const staleLegacy = path.join(legacy, 'chrome', 'chrome@stale');
  await fs.mkdir(canonical);
  await mkdirOld(staleLegacy, now);
  const multiRootPolicy = policy(root);
  multiRootPolicy.puppeteer.cacheRoots = [canonical, legacy];
  let calls = 0;

  await assert.rejects(runMaintenance({
    policy: multiRootPolicy,
    now,
    apply: true,
    processEntriesProvider: async () => {
      calls += 1;
      return calls >= 2
        ? [{ pid: 202, cwd: root, exe: path.join(staleLegacy, 'chrome'), cmdline: ['chrome'] }]
        : [];
    },
  }), /candidate is no longer eligible/);
  await fs.access(staleLegacy);
});

test('scans .wwebjs_auth while a missing wpp_sessions root remains safe', async (t) => {
  const root = await fixture(t);
  const now = new Date('2026-09-20T12:00:00Z');
  const authRoot = path.join(root, '.wwebjs_auth');
  const sessionsRoot = path.join(root, 'wpp_sessions');
  const cache = path.join(authRoot, 'session-a', 'Cache');
  await mkdirOld(cache, now);
  await fs.mkdir(path.join(root, 'puppeteer'));
  const multiWppPolicy = policy(root);
  multiWppPolicy.cacheRoots = [authRoot, sessionsRoot];

  const report = await runMaintenance({
    policy: multiWppPolicy,
    now,
    apply: false,
    processEntries: [],
  });

  assert.ok(report.candidates.some((item) => item.path === cache));
  assert.ok(report.skipped.some((item) => item.path === sessionsRoot && item.reason === 'missing-root'));
  await fs.access(cache);
});

test('reports deterministic disk thresholds at 80, 90, and 95 percent', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'profiles'));
  await fs.mkdir(path.join(root, 'puppeteer'));
  const diskPolicy = policy(root);
  diskPolicy.diskUsage = {
    path: root,
    thresholds: { warning: 80, high: 90, critical: 95 },
  };

  for (const [usedPercent, status] of [[79, 'ok'], [80, 'warning'], [90, 'high'], [95, 'critical']]) {
    const report = await runMaintenance({
      policy: diskPolicy,
      processEntries: [],
      diskUsageProvider: async () => ({ blocks: 100n, bavail: BigInt(100 - usedPercent), bsize: 1n }),
    });
    assert.deepEqual(report.diskUsage, {
      path: root,
      totalBytes: 100,
      availableBytes: 100 - usedPercent,
      usedBytes: usedPercent,
      usedPercent,
      status,
      thresholds: { warning: 80, high: 90, critical: 95 },
    });
  }
});

test('CLI emits the post-cleanup machine report and exits nonzero when disk remains critical', async (t) => {
  const root = await fixture(t);
  const profiles = path.join(root, 'profiles');
  const staleCache = path.join(profiles, 'session-a', 'Cache');
  await mkdirOld(staleCache, new Date('2026-09-20T12:00:00Z'));
  await fs.mkdir(path.join(root, 'puppeteer'));
  const policyPath = path.join(root, 'policy.json');
  await fs.writeFile(policyPath, JSON.stringify({
    ...policy(root),
    minimumAgeDays: 1,
    diskUsage: { path: root, thresholds: { warning: 80, high: 90, critical: 95 } },
  }));
  const moduleUrl = new URL('../scripts/storage-maintenance.js', import.meta.url).href;
  const childScript = `
    import fs from 'node:fs/promises';
    import { main } from ${JSON.stringify(moduleUrl)};
    const exitCode = await main({
      argv: ['--apply', '--policy', ${JSON.stringify(policyPath)}],
      env: {},
      now: new Date('2026-09-20T12:00:00Z'),
      processEntries: [],
      diskUsageProvider: async () => {
        try { await fs.access(${JSON.stringify(staleCache)}); }
        catch (error) { if (error.code === 'ENOENT') return { blocks: 100n, bavail: 4n, bsize: 1n }; throw error; }
        throw new Error('disk usage measured before cleanup completed');
      },
    });
    process.exitCode = exitCode;
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'apply');
  assert.ok(report.candidates.some((item) => item.path === staleCache));
  assert.equal(report.diskUsage.status, 'critical');
  assert.equal(report.diskUsage.usedPercent, 96);
  await assert.rejects(fs.access(staleCache), { code: 'ENOENT' });
});

test('production policy covers both WPP roots and canonical plus legacy Puppeteer roots', async () => {
  const project = '/home/test/.openclaw/workspace-pedivoy/PediVoy';
  const homeCache = '/home/test/.cache/puppeteer';
  const loaded = await loadPolicy('config/storage-policy.json', {
    WWEBJS_AUTH_ROOT: path.join(project, '.wwebjs_auth'),
    WPP_SESSIONS_ROOT: path.join(project, 'wpp_sessions'),
    PUPPETEER_CACHE_DIR: homeCache,
    LEGACY_PUPPETEER_CACHE_DIR: path.join(project, '.puppeteer'),
    PEDIVOY_STORAGE_PATH: project,
  });
  assert.deepEqual(loaded.cacheRoots, [
    path.join(project, '.wwebjs_auth'),
    path.join(project, 'wpp_sessions'),
  ]);
  assert.deepEqual(loaded.puppeteer.cacheRoots, [homeCache, path.join(project, '.puppeteer')]);
  assert.deepEqual(loaded.diskUsage.thresholds, { warning: 80, high: 90, critical: 95 });

  const appUnit = await fs.readFile('ops/systemd/pedivoy.service', 'utf8');
  const maintenanceUnit = await fs.readFile('ops/systemd/pedivoy-storage-maintenance.service', 'utf8');
  assert.match(appUnit, /ExecStart=\/usr\/bin\/env PUPPETEER_CACHE_DIR=%h\/\.cache\/puppeteer \/usr\/bin\/npm start/);
  assert.match(appUnit, /ExecStartPre=\/usr\/bin\/mkdir -p %h\/\.cache\/puppeteer/);
  assert.match(appUnit, /ExecStartPre=\/usr\/bin\/env PUPPETEER_CACHE_DIR=%h\/\.cache\/puppeteer \/usr\/bin\/node scripts\/prepare-puppeteer-cache\.js/);
  assert.match(maintenanceUnit, /ExecStart=\/usr\/bin\/env [^\n]*PUPPETEER_CACHE_DIR=%h\/\.cache\/puppeteer/);
  assert.match(maintenanceUnit, /LEGACY_PUPPETEER_CACHE_DIR=%h\/\.openclaw\/workspace-pedivoy\/PediVoy\/\.puppeteer/);
  assert.match(maintenanceUnit, /WWEBJS_AUTH_ROOT=%h\/\.openclaw\/workspace-pedivoy\/PediVoy\/\.wwebjs_auth/);
  assert.match(maintenanceUnit, /WPP_SESSIONS_ROOT=%h\/\.openclaw\/workspace-pedivoy\/PediVoy\/wpp_sessions/);
});

test('canonical cache preparation installs every missing expected Puppeteer revision', async (t) => {
  const root = await fixture(t);
  const cacheRoot = path.join(root, 'canonical-cache');
  const existing = path.join(cacheRoot, 'chrome', 'linux-146.0.7680.76');
  await fs.mkdir(path.join(existing, 'chrome-linux64'), { recursive: true });
  await fs.writeFile(path.join(existing, 'chrome-linux64', 'chrome'), 'browser');
  const installed = [];

  const report = await preparePuppeteerCache({
    cacheRoot,
    expectedVersions: [
      'chrome/linux-146.0.7680.76',
      'chrome/linux-146.0.7680.31',
      'chrome-headless-shell/linux-146.0.7680.31',
    ],
    installBrowser: async (target) => {
      installed.push(target);
      const [product, buildId] = target.split('@');
      await fs.mkdir(path.join(cacheRoot, product, `linux-${buildId}`, 'chrome-linux64'), { recursive: true });
      await fs.writeFile(path.join(cacheRoot, product, `linux-${buildId}`, 'chrome-linux64', 'chrome'), 'browser');
    },
  });

  assert.deepEqual(report.present, ['chrome/linux-146.0.7680.76']);
  assert.deepEqual(installed, ['chrome@146.0.7680.31']);
  assert.deepEqual(report.installed, installed);
});

test('canonical cache preparation rejects symlinked ancestors and incomplete revisions', async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, 'outside');
  const linkedCache = path.join(root, 'linked-cache');
  await fs.mkdir(outside);
  await fs.mkdir(linkedCache);
  await fs.symlink(outside, path.join(linkedCache, 'chrome'));
  await assert.rejects(preparePuppeteerCache({
    cacheRoot: linkedCache,
    expectedVersions: ['chrome/linux-146.0.7680.76'],
    installBrowser: async () => assert.fail('must not install through a symlink'),
  }), /symlink|real directory/);

  const incompleteCache = path.join(root, 'incomplete-cache');
  await fs.mkdir(path.join(incompleteCache, 'chrome', 'linux-146.0.7680.76'), { recursive: true });
  await assert.rejects(preparePuppeteerCache({
    cacheRoot: incompleteCache,
    expectedVersions: ['chrome/linux-146.0.7680.76'],
    installBrowser: async () => assert.fail('must not trust or overwrite an incomplete revision'),
  }), /incomplete Puppeteer revision/);
});

test('policy loading expands only defined environment paths and CLI defaults to dry-run', async (t) => {
  const root = await fixture(t);
  const policyPath = path.join(root, 'policy.json');
  await fs.writeFile(policyPath, JSON.stringify({
    ...policy(root),
    cacheRoots: ['$SESSION_ROOT'],
    puppeteer: { cacheRoot: '${PUPPETEER_CACHE_DIR}', expectedVersions: [] },
  }));

  const loaded = await loadPolicy(policyPath, {
    SESSION_ROOT: path.join(root, 'sessions'),
    PUPPETEER_CACHE_DIR: path.join(root, 'browser-cache'),
  });
  assert.deepEqual(loaded.cacheRoots, [path.join(root, 'sessions')]);
  assert.equal(loaded.puppeteer.cacheRoot, path.join(root, 'browser-cache'));
  assert.deepEqual(parseArgs([]), { apply: false, policyPath: 'config/storage-policy.json' });
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
  await assert.rejects(loadPolicy(policyPath, {}), /missing environment variable SESSION_ROOT/);
  await assert.rejects(loadPolicy(policyPath, {
    SESSION_ROOT: 'relative/sessions',
    PUPPETEER_CACHE_DIR: path.join(root, 'browser-cache'),
  }), /path must be absolute/);

  await fs.writeFile(policyPath, JSON.stringify({
    ...policy(root),
    cacheDirectoryAllowlist: ['session-a'],
  }));
  await assert.rejects(loadPolicy(policyPath, {}), /unsafe cache allowlist entry/);
});

test('systemd installer is dry-run by default and blocks apply on a system/user conflict', async (t) => {
  const root = await fixture(t);
  const fakeSystemctl = path.join(root, 'systemctl');
  const log = path.join(root, 'calls.log');
  await fs.writeFile(fakeSystemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS_LOG"\nif [ "$1" = "--user" ]; then echo disabled; exit 1; fi\nif [ "$1" = "is-enabled" ] || [ "$1" = "is-active" ]; then exit 0; fi\nexit 0\n`);
  await fs.chmod(fakeSystemctl, 0o755);
  const script = path.resolve('ops/systemd/install-user-units.sh');
  const env = {
    ...process.env,
    SYSTEMCTL_BIN: fakeSystemctl,
    CALLS_LOG: log,
    XDG_CONFIG_HOME: path.join(root, 'config'),
  };

  const dryRun = spawnSync(script, [], { cwd: path.resolve('.'), env, encoding: 'utf8' });
  assert.equal(dryRun.status, 0);
  assert.match(dryRun.stdout, /conflict.*system.*pedivoy\.service/i);
  assert.match(dryRun.stdout, /dry-run/i);

  const apply = spawnSync(script, ['--apply'], { cwd: path.resolve('.'), env, encoding: 'utf8' });
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /--disable-system-conflict/);
  const calls = await fs.readFile(log, 'utf8');
  assert.doesNotMatch(calls, /disable|stop/);
});

test('systemd installer treats an active system unit as a conflict even when disabled', async (t) => {
  const root = await fixture(t);
  const fakeSystemctl = path.join(root, 'systemctl');
  await fs.writeFile(fakeSystemctl, `#!/bin/sh\nif [ "$1" = "--user" ]; then echo disabled; exit 1; fi\nif [ "$1" = "is-enabled" ]; then echo disabled; exit 1; fi\nif [ "$1" = "is-active" ]; then exit 0; fi\nexit 0\n`);
  await fs.chmod(fakeSystemctl, 0o755);
  const result = spawnSync(path.resolve('ops/systemd/install-user-units.sh'), ['--apply'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      SYSTEMCTL_BIN: fakeSystemctl,
      XDG_CONFIG_HOME: path.join(root, 'config'),
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--disable-system-conflict/);
});

test('systemd installer fails closed when service state cannot be determined', async (t) => {
  const root = await fixture(t);
  const fakeSystemctl = path.join(root, 'systemctl');
  await fs.writeFile(fakeSystemctl, '#!/bin/sh\nexit 1\n');
  await fs.chmod(fakeSystemctl, 0o755);
  const result = spawnSync(path.resolve('ops/systemd/install-user-units.sh'), ['--apply'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      SYSTEMCTL_BIN: fakeSystemctl,
      XDG_CONFIG_HOME: path.join(root, 'config'),
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot determine.*system pedivoy\.service/i);
  await assert.rejects(fs.access(path.join(root, 'config', 'systemd', 'user', 'pedivoy.service')), { code: 'ENOENT' });
});
