#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_CACHE_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnCache',
]);

function validatePolicy(policy) {
  if (policy.version !== 1) throw new Error('unsupported storage policy version');
  if (!Number.isInteger(policy.minimumAgeDays) || policy.minimumAgeDays < 1) {
    throw new Error('minimumAgeDays must be a positive integer');
  }
  for (const field of ['cacheRoots', 'cacheDirectoryAllowlist', 'protectedPathNames', 'protectedPathPrefixes']) {
    if (!Array.isArray(policy[field])) throw new Error(`${field} must be an array`);
  }
  const puppeteerRoots = policy.puppeteer?.cacheRoots
    ?? (typeof policy.puppeteer?.cacheRoot === 'string' ? [policy.puppeteer.cacheRoot] : null);
  if (!Array.isArray(puppeteerRoots) || puppeteerRoots.length === 0
      || puppeteerRoots.some((root) => typeof root !== 'string')
      || !Array.isArray(policy.puppeteer.expectedVersions)) {
    throw new Error('puppeteer cacheRoots and expectedVersions are required');
  }
  if (policy.cacheDirectoryAllowlist.length === 0
      || policy.cacheDirectoryAllowlist.some((name) => !SAFE_CACHE_NAMES.has(name))) {
    throw new Error('unsafe cache allowlist entry');
  }
  if (policy.diskUsage) {
    const { thresholds } = policy.diskUsage;
    if (typeof policy.diskUsage.path !== 'string' || !path.isAbsolute(policy.diskUsage.path)
        || !thresholds || thresholds.warning !== 80 || thresholds.high !== 90
        || thresholds.critical !== 95) {
      throw new Error('diskUsage requires an absolute path and thresholds 80/90/95');
    }
  }
  const requiredNames = ['auth', 'storage', 'IndexedDB', 'uploads', 'DB'];
  if (requiredNames.some((name) => !policy.protectedPathNames.includes(name))
      || !policy.protectedPathPrefixes.includes('Singleton')) {
    throw new Error('policy is missing mandatory protected paths');
  }
  return policy;
}

async function inspectTree(target, isProtected = () => false) {
  const stat = await fs.lstat(target);
  const protectedPath = isProtected(path.basename(target));
  if (stat.isSymbolicLink()) {
    return { bytes: 0, newestMtimeMs: stat.mtimeMs, containsSymlink: true, containsProtected: protectedPath };
  }
  if (protectedPath) {
    return { bytes: 0, newestMtimeMs: stat.mtimeMs, containsSymlink: false, containsProtected: true };
  }
  if (!stat.isDirectory()) {
    return { bytes: stat.size, newestMtimeMs: stat.mtimeMs, containsSymlink: false, containsProtected: false };
  }
  const result = {
    bytes: 0,
    newestMtimeMs: stat.mtimeMs,
    containsSymlink: false,
    containsProtected: false,
  };
  for (const entry of await fs.readdir(target)) {
    const child = await inspectTree(path.join(target, entry), isProtected);
    result.bytes += child.bytes;
    result.newestMtimeMs = Math.max(result.newestMtimeMs, child.newestMtimeMs);
    result.containsSymlink ||= child.containsSymlink;
    result.containsProtected ||= child.containsProtected;
  }
  return result;
}

async function validateManagedRoot(root) {
  const resolved = path.resolve(root);
  if (!path.isAbsolute(root) || resolved === path.parse(resolved).root) {
    throw new Error(`unsafe managed root: ${root}`);
  }
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`managed root is a symlink: ${resolved}`);
  if (!stat.isDirectory()) throw new Error(`managed root is not a directory: ${resolved}`);
  const real = await fs.realpath(resolved);
  if (real !== resolved) throw new Error(`managed root has a symlinked ancestor: ${resolved}`);
  return resolved;
}

async function readProcessEntries(procRoot = '/proc') {
  const entries = [];
  const names = await fs.readdir(procRoot);
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const raw = await fs.readFile(path.join(procRoot, name, 'cmdline'));
      const cmdline = raw.toString().split('\0').filter(Boolean);
      let cwd;
      let exe;
      try {
        cwd = await fs.readlink(path.join(procRoot, name, 'cwd'));
      } catch (error) {
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      }
      try {
        exe = await fs.readlink(path.join(procRoot, name, 'exe'));
      } catch (error) {
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      }
      entries.push({ pid: Number(name), cmdline, cwd, exe });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return entries;
}

async function canonicalPath(value) {
  try {
    return await fs.realpath(value);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes(error.code)) return path.resolve(value);
    throw error;
  }
}

async function activeUserDataDirs(processEntries) {
  const active = new Set();
  for (const entry of processEntries) {
    const args = Array.isArray(entry.cmdline)
      ? entry.cmdline
      : String(entry.cmdline || '').split('\0').filter(Boolean);
    for (let index = 0; index < args.length; index += 1) {
      let value;
      if (args[index].startsWith('--user-data-dir=')) value = args[index].slice(16);
      else if (args[index] === '--user-data-dir') value = args[index + 1];
      if (!value) continue;
      if (!path.isAbsolute(value) && !entry.cwd) {
        throw new Error(`cannot resolve relative user-data-dir for process ${entry.pid}`);
      }
      active.add(await canonicalPath(path.resolve(entry.cwd || '/', value)));
    }
  }
  return active;
}

async function processAbsolutePaths(processEntries) {
  const values = [];
  for (const entry of processEntries) {
    const args = Array.isArray(entry.cmdline)
      ? entry.cmdline
      : String(entry.cmdline || '').split('\0').filter(Boolean);
    const executable = entry.exe || args[0];
    if (!executable) continue;
    if (entry.exe) {
      values.push(await canonicalPath(entry.exe.replace(/ \(deleted\)$/, '')));
      continue;
    }
    if (!path.isAbsolute(executable) && !entry.cwd) {
      if (/(?:chrome|chromium|headless-shell)/i.test(executable)) {
        throw new Error(`cannot resolve relative browser executable for process ${entry.pid}`);
      }
      continue;
    }
    values.push(await canonicalPath(path.resolve(entry.cwd || '/', executable)));
  }
  return values;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function assertSafeRemoval(root, target) {
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`managed root changed or became a symlink: ${root}`);
  }
  if (!isWithin(root, target) || root === target) throw new Error(`candidate escaped managed root: ${target}`);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) throw new Error(`candidate changed or became a symlink: ${current}`);
  }
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (realRoot !== root) throw new Error(`managed root changed or became a symlink: ${root}`);
  if (!isWithin(realRoot, realTarget) || realRoot === realTarget) {
    throw new Error(`candidate escaped managed root: ${target}`);
  }
}

export async function runMaintenance({
  policy,
  now = new Date(),
  apply = false,
  processEntries,
  processEntriesProvider,
  procRoot = '/proc',
  beforeApply = async () => {},
  diskUsageProvider = fs.statfs,
} = {}) {
  validatePolicy(policy);
  const candidates = [];
  const skipped = [];
  const allowlist = new Set(policy.cacheDirectoryAllowlist);
  const protectedNames = new Set(policy.protectedPathNames);
  const protectedPrefixes = policy.protectedPathPrefixes;
  const cutoff = now.getTime() - policy.minimumAgeDays * 86_400_000;
  const getProcesses = async () => {
    if (processEntries !== undefined) return processEntries;
    if (processEntriesProvider) return processEntriesProvider();
    return readProcessEntries(procRoot);
  };
  const processes = await getProcesses();
  const activeProfiles = await activeUserDataDirs(processes);

  const isProtected = (name) => protectedNames.has(name)
    || protectedPrefixes.some((prefix) => name.startsWith(prefix));

  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.push({ path: target, reason: 'symlink' });
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (isProtected(entry.name)) {
        skipped.push({ path: target, reason: 'protected' });
        continue;
      }
      if (allowlist.has(entry.name)) {
        if ([...activeProfiles].some((profile) => isWithin(profile, target))) {
          skipped.push({ path: target, reason: 'active-profile' });
          continue;
        }
        const tree = await inspectTree(target, isProtected);
        if (tree.containsSymlink) {
          skipped.push({ path: target, reason: 'contains-symlink' });
        } else if (tree.containsProtected) {
          skipped.push({ path: target, reason: 'contains-protected-path' });
        } else if (tree.newestMtimeMs <= cutoff) {
          candidates.push({ path: target, reason: 'allowlisted-cache', bytes: tree.bytes });
        } else {
          skipped.push({ path: target, reason: 'minimum-age' });
        }
        continue;
      }
      await walk(target);
    }
  }

  const managedRoots = [];
  for (const root of policy.cacheRoots) {
    const validated = await validateManagedRoot(root);
    if (validated) managedRoots.push(validated);
    else skipped.push({ path: path.resolve(root), reason: 'missing-root' });
  }
  for (const root of managedRoots) await walk(root);
  const removalRoots = [...managedRoots];

  const configuredPuppeteerRoots = policy.puppeteer.cacheRoots ?? [policy.puppeteer.cacheRoot];
  const processArgs = await processAbsolutePaths(processes);
  for (const configuredRoot of configuredPuppeteerRoots) {
    const puppeteerRoot = await validateManagedRoot(configuredRoot);
    if (!puppeteerRoot) {
      skipped.push({ path: path.resolve(configuredRoot), reason: 'missing-root' });
      continue;
    }
    removalRoots.push(puppeteerRoot);
    const expected = new Set(policy.puppeteer.expectedVersions);
    for (const productEntry of await fs.readdir(puppeteerRoot, { withFileTypes: true })) {
      const productPath = path.join(puppeteerRoot, productEntry.name);
      if (productEntry.isSymbolicLink()) {
        skipped.push({ path: productPath, reason: 'symlink' });
        continue;
      }
      if (isProtected(productEntry.name)) {
        skipped.push({ path: productPath, reason: 'protected' });
        continue;
      }
      if (!productEntry.isDirectory()) continue;
      for (const versionEntry of await fs.readdir(productPath, { withFileTypes: true })) {
        const versionPath = path.join(productPath, versionEntry.name);
        if (versionEntry.isSymbolicLink()) {
          skipped.push({ path: versionPath, reason: 'symlink' });
          continue;
        }
        if (!versionEntry.isDirectory()) continue;
        const versionKey = `${productEntry.name}/${versionEntry.name}`;
        if (expected.has(versionEntry.name) || expected.has(versionKey)) {
          skipped.push({ path: versionPath, reason: 'expected-puppeteer-version' });
          continue;
        }
        if (processArgs.some((argument) => isWithin(versionPath, argument))) {
          skipped.push({ path: versionPath, reason: 'active-puppeteer-version' });
          continue;
        }
        const tree = await inspectTree(versionPath, isProtected);
        if (tree.containsSymlink) {
          skipped.push({ path: versionPath, reason: 'contains-symlink' });
          continue;
        }
        if (tree.containsProtected) {
          skipped.push({ path: versionPath, reason: 'contains-protected-path' });
          continue;
        }
        if (tree.newestMtimeMs > cutoff) {
          skipped.push({ path: versionPath, reason: 'minimum-age' });
          continue;
        }
        candidates.push({
          path: versionPath,
          reason: 'unused-puppeteer-version',
          bytes: tree.bytes,
        });
      }
    }
  }
  if (apply) {
    await beforeApply(candidates);
    const rootsBySpecificity = removalRoots.toSorted((left, right) => right.length - left.length);
    for (const candidate of candidates) {
      const freshProcesses = await getProcesses();
      const freshActiveProfiles = await activeUserDataDirs(freshProcesses);
      const freshProcessPaths = await processAbsolutePaths(freshProcesses);
      const root = rootsBySpecificity.find((managedRoot) => isWithin(managedRoot, candidate.path));
      if (!root) throw new Error(`candidate has no managed root: ${candidate.path}`);
      await assertSafeRemoval(root, candidate.path);
      const tree = await inspectTree(candidate.path, isProtected);
      const becameActiveProfile = candidate.reason === 'allowlisted-cache'
        && [...freshActiveProfiles].some((profile) => isWithin(profile, candidate.path));
      const becameActiveVersion = candidate.reason === 'unused-puppeteer-version'
        && freshProcessPaths.some((processPath) => isWithin(candidate.path, processPath));
      if (tree.containsSymlink || tree.containsProtected || tree.newestMtimeMs > cutoff
          || becameActiveProfile || becameActiveVersion) {
        throw new Error(`candidate is no longer eligible: ${candidate.path}`);
      }
      await fs.rm(candidate.path, { recursive: true });
    }
  }
  let diskUsage;
  if (policy.diskUsage) {
    const stats = await diskUsageProvider(policy.diskUsage.path);
    const totalBytesBigInt = BigInt(stats.blocks) * BigInt(stats.bsize);
    const availableBytesBigInt = BigInt(stats.bavail) * BigInt(stats.bsize);
    if (totalBytesBigInt <= 0n || availableBytesBigInt < 0n || availableBytesBigInt > totalBytesBigInt) {
      throw new Error('invalid disk usage statistics');
    }
    const usedBytesBigInt = totalBytesBigInt - availableBytesBigInt;
    const usedPercent = Number((usedBytesBigInt * 10_000n) / totalBytesBigInt) / 100;
    const { thresholds } = policy.diskUsage;
    const status = usedPercent >= thresholds.critical ? 'critical'
      : usedPercent >= thresholds.high ? 'high'
        : usedPercent >= thresholds.warning ? 'warning' : 'ok';
    diskUsage = {
      path: policy.diskUsage.path,
      totalBytes: Number(totalBytesBigInt),
      availableBytes: Number(availableBytesBigInt),
      usedBytes: Number(usedBytesBigInt),
      usedPercent,
      status,
      thresholds,
    };
  }
  return {
    mode: apply ? 'apply' : 'dry-run',
    candidates,
    skipped,
    bytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
    ...(diskUsage ? { diskUsage } : {}),
  };
}

function expandEnvironment(value, env) {
  return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced, bare) => {
    const name = braced || bare;
    if (!env[name]) throw new Error(`missing environment variable ${name}`);
    return env[name];
  });
}

export async function loadPolicy(policyPath, env = process.env) {
  const raw = JSON.parse(await fs.readFile(path.resolve(policyPath), 'utf8'));
  const rawPuppeteerRoots = raw.puppeteer?.cacheRoots
    ?? (typeof raw.puppeteer?.cacheRoot === 'string' ? [raw.puppeteer.cacheRoot] : null);
  if (!Array.isArray(raw.cacheRoots) || !Array.isArray(rawPuppeteerRoots)) {
    throw new Error('cacheRoots and puppeteer.cacheRoots are required');
  }
  const expandPath = (value) => {
    const expanded = expandEnvironment(value, env);
    if (!path.isAbsolute(expanded)) throw new Error(`path must be absolute: ${expanded}`);
    return path.normalize(expanded);
  };
  return validatePolicy({
    ...raw,
    cacheRoots: raw.cacheRoots.map(expandPath),
    ...(raw.diskUsage ? {
      diskUsage: { ...raw.diskUsage, path: expandPath(raw.diskUsage.path) },
    } : {}),
    puppeteer: {
      ...raw.puppeteer,
      ...(typeof raw.puppeteer.cacheRoot === 'string'
        ? { cacheRoot: expandPath(raw.puppeteer.cacheRoot) }
        : {}),
      cacheRoots: rawPuppeteerRoots.map(expandPath),
    },
  });
}

export function parseArgs(argv, env = {}) {
  const options = {
    apply: false,
    policyPath: env.PEDIVOY_STORAGE_POLICY || 'config/storage-policy.json',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--policy' && argv[index + 1]) options.policyPath = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  ...maintenanceOptions
} = {}) {
  const options = parseArgs(argv, env);
  const policy = await loadPolicy(options.policyPath, env);
  const report = await runMaintenance({ policy, apply: options.apply, ...maintenanceOptions });
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.diskUsage?.status === 'critical' ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}
