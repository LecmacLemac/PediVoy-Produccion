#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REQUIRED_PRODUCTS = new Set(['chrome']);

function parseExpectedVersion(value) {
  const match = /^(chrome|chrome-headless-shell)\/linux-([0-9]+(?:\.[0-9]+){3})$/.exec(value);
  if (!match) throw new Error(`unsafe Puppeteer version entry: ${value}`);
  return { key: value, product: match[1], buildId: match[2] };
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function validateInstalledRevision(cacheRoot, version) {
  const productPath = path.join(cacheRoot, version.product);
  const revisionPath = path.join(productPath, `linux-${version.buildId}`);
  for (const target of [productPath, revisionPath]) {
    const stat = await fs.lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Puppeteer cache ancestor is a symlink or not a directory: ${target}`);
    }
    const real = await fs.realpath(target);
    if (!isWithin(cacheRoot, real)) throw new Error(`Puppeteer cache ancestor escaped its root: ${target}`);
  }
  const executable = path.join(revisionPath, 'chrome-linux64', 'chrome');
  const executableStat = await fs.lstat(executable).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!executableStat?.isFile() || executableStat.isSymbolicLink()) {
    throw new Error(`incomplete Puppeteer revision: ${revisionPath}`);
  }
  const realExecutable = await fs.realpath(executable);
  if (!isWithin(revisionPath, realExecutable)) {
    throw new Error(`Puppeteer executable escaped its revision: ${executable}`);
  }
  return true;
}

async function defaultInstallBrowser(target, cacheRoot) {
  const cliPath = path.resolve('node_modules/puppeteer/lib/cjs/puppeteer/node/cli.js');
  const result = spawnSync(process.execPath, [cliPath, 'browsers', 'install', target], {
    env: { ...process.env, PUPPETEER_CACHE_DIR: cacheRoot },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`failed to install Puppeteer browser ${target}`);
}

export async function preparePuppeteerCache({
  cacheRoot,
  expectedVersions,
  installBrowser = defaultInstallBrowser,
} = {}) {
  const resolvedRoot = path.resolve(cacheRoot || '');
  if (!cacheRoot || !path.isAbsolute(cacheRoot) || resolvedRoot === path.parse(resolvedRoot).root) {
    throw new Error(`unsafe Puppeteer cache root: ${cacheRoot || '<empty>'}`);
  }
  await fs.mkdir(resolvedRoot, { recursive: true });
  const rootStat = await fs.lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(resolvedRoot) !== resolvedRoot) {
    throw new Error(`Puppeteer cache root is not a real directory: ${resolvedRoot}`);
  }
  if (!Array.isArray(expectedVersions)) throw new Error('expectedVersions must be an array');

  const report = { cacheRoot: resolvedRoot, present: [], installed: [] };
  for (const version of expectedVersions.map(parseExpectedVersion)) {
    if (!REQUIRED_PRODUCTS.has(version.product)) continue;
    if (await validateInstalledRevision(resolvedRoot, version)) {
      report.present.push(version.key);
      continue;
    }
    const target = `${version.product}@${version.buildId}`;
    await installBrowser(target, resolvedRoot);
    if (!await validateInstalledRevision(resolvedRoot, version)) {
      throw new Error(`Puppeteer installer did not create ${version.key}`);
    }
    report.installed.push(target);
  }
  return report;
}

async function main() {
  const policy = JSON.parse(await fs.readFile(path.resolve('config/storage-policy.json'), 'utf8'));
  const report = await preparePuppeteerCache({
    cacheRoot: process.env.PUPPETEER_CACHE_DIR,
    expectedVersions: policy.puppeteer?.expectedVersions,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}
