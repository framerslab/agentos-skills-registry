#!/usr/bin/env node

/**
 * Packs this package exactly as a release would, installs the tarball with npm
 * into an empty project next to the latest @framers/agentos, and imports it by
 * name.
 *
 * npm refuses the install (ERESOLVE) when a peer range excludes the host the
 * project lists, which is what a consumer on the latest agentos meets. The
 * source once declared `^0.10.34` here while npm served `>=0.7.0`; the next
 * release would have published the narrow range. Optional dependencies are
 * resolved (their peer ranges are checked too) but not written to disk.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
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
let exportCount;
try {
  exportCount = Number(
    execFileSync(
      'node',
      ['--input-type=module', '-e', `const m = await import(${JSON.stringify(name)}); console.log(Object.keys(m).length);`],
      { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    ).trim(),
  );
} catch {
  console.error(`${name} installed next to @framers/agentos ${host}, but importing it failed`);
  process.exit(1);
}
if (!(exportCount > 0)) {
  console.error(`${name} imported next to @framers/agentos ${host} with no exports`);
  process.exit(1);
}
console.log(`${tarballName} installs next to @framers/agentos ${host} and imports with ${exportCount} exports.`);
