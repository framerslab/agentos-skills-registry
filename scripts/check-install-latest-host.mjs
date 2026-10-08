#!/usr/bin/env node

/**
 * Packs this package exactly as a release would, installs the tarball with npm
 * into an empty project next to the latest @framers/agentos, and imports it by
 * name: the root and every subpath in its `exports` map.
 *
 * npm refuses the install (ERESOLVE) when a peer range excludes the host the
 * project lists, which is what a consumer on the latest agentos meets. The
 * source once declared `^0.10.34` here while npm served `>=0.7.0`; the next
 * release would have published the narrow range. Optional dependencies are
 * resolved (their peer ranges are checked too) but not written to disk. The
 * root must have exports; a subpath only has to load, since one that carries
 * types alone has none at runtime.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name, exports: exportMap } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
// Every import target the package declares; wildcard patterns and ./package.json are left out.
const subpaths =
  exportMap && typeof exportMap === 'object' && !Array.isArray(exportMap) && Object.keys(exportMap).some((key) => key.startsWith('.'))
    ? Object.keys(exportMap).filter((key) => key !== './package.json' && !key.includes('*'))
    : ['.'];
const specifiers = subpaths.map((key) => (key === '.' ? name : `${name}${key.slice(1)}`));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'install-latest-host-'));
const packDir = path.join(work, 'pack');
const consumer = path.join(work, 'consumer');
fs.mkdirSync(packDir);
fs.mkdirSync(consumer);

// The build has already run; `--ignore-scripts` keeps `prepare` from running it again.
execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], {
  cwd: packageRoot,
  stdio: ['ignore', 'ignore', 'inherit'],
});
const tarballName = fs.readdirSync(packDir).find((file) => file.endsWith('.tgz'));
if (!tarballName) {
  console.error('npm pack produced no tarball');
  process.exit(1);
}

fs.writeFileSync(
  path.join(consumer, 'package.json'),
  `${JSON.stringify({ name: 'install-latest-host', private: true, type: 'module' }, null, 2)}\n`,
);
try {
  execFileSync(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--omit=optional',
      path.join(packDir, tarballName),
      '@framers/agentos@latest',
    ],
    { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );
} catch (error) {
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n');
  console.error(`npm would not install ${tarballName} next to @framers/agentos@latest:`);
  console.error(output.slice(-40).join('\n'));
  process.exit(1);
}

const host = JSON.parse(
  fs.readFileSync(path.join(consumer, 'node_modules', '@framers', 'agentos', 'package.json'), 'utf8'),
).version;
// One child process imports each specifier and reports its export count, or -1 when the import throws.
const importer = `
const counts = {};
for (const specifier of ${JSON.stringify(specifiers)}) {
  try {
    counts[specifier] = Object.keys(await import(specifier)).length;
  } catch (error) {
    counts[specifier] = -1;
    console.error(specifier + ': ' + String(error && error.message).split('\\n')[0]);
  }
}
console.log(JSON.stringify(counts));`;
let counts;
try {
  counts = JSON.parse(
    execFileSync('node', ['--input-type=module', '-e', importer], {
      cwd: consumer,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
      .trim()
      .split('\n')
      .pop(), // the counts are the last line, whatever an imported module prints
  );
} catch {
  console.error(`${name} installed next to @framers/agentos ${host}, but the import check did not run`);
  process.exit(1);
}
const failed = specifiers.filter((specifier) => counts[specifier] === -1);
if (failed.length > 0) {
  console.error(`Installed next to @framers/agentos ${host}, these entry points failed to import: ${failed.join(', ')}`);
  process.exit(1);
}
if (!(counts[name] > 0)) {
  console.error(`${name} imported next to @framers/agentos ${host} with no exports`);
  process.exit(1);
}
const summary = specifiers.map((specifier) => `${specifier} (${counts[specifier]})`).join(', ');
console.log(`${tarballName} installs next to @framers/agentos ${host}; imported ${summary}.`);
