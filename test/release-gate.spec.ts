// @ts-nocheck
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONVENTIONALCOMMITS_PARSER,
  decide,
  releaseReason,
  releaseRulesOf,
  ships,
} from '../.github/scripts/release-gate.mjs';

// The daily release's first job (.github/workflows/release.yml, job "Releasable changes") runs
// .github/scripts/release-gate.mjs with git and node alone and ends the run when master holds no change to
// release. These cases hold it to the release it stands in front of: its parser patterns to the installed
// preset's, its decision on each message to the commit analyzer's, and its decision on a real git history.
const localRequire = createRequire(import.meta.url);
const releaseConfig = localRequire('../release.config.cjs');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const rules = releaseRulesOf(releaseConfig);
const analyzerPath = createRequire(localRequire.resolve('semantic-release')).resolve('@semantic-release/commit-analyzer');
const [, analyzerConfig] = releaseConfig.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/commit-analyzer'
);
const cwd = fileURLToPath(new URL('..', import.meta.url));

async function analyzerReleases(message) {
  const { analyzeCommits } = await import(pathToFileURL(analyzerPath).href);
  const release = await analyzeCommits(analyzerConfig, {
    cwd,
    commits: [{ hash: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', message }],
    logger: { log() {} },
  });
  return release !== null;
}

describe('release gate: the preset it reads', () => {
  it('uses the parser options the installed conventionalcommits preset gives', async () => {
    const { default: createPreset } = await import('conventional-changelog-conventionalcommits');
    const { parser } = await createPreset({});
    expect(String(CONVENTIONALCOMMITS_PARSER.headerPattern)).toBe(String(parser.headerPattern));
    expect(String(CONVENTIONALCOMMITS_PARSER.breakingHeaderPattern)).toBe(String(parser.breakingHeaderPattern));
    expect(String(CONVENTIONALCOMMITS_PARSER.revertPattern)).toBe(String(parser.revertPattern));
    expect(CONVENTIONALCOMMITS_PARSER.noteKeywords).toEqual(parser.noteKeywords);
  });

  it('refuses a release configuration with another preset', () => {
    const other = { plugins: [['@semantic-release/commit-analyzer', { preset: 'angular' }]] };
    expect(() => releaseRulesOf(other)).toThrow(/conventionalcommits/);
  });
});

describe('release gate: each message as the commit analyzer decides it', () => {
  it.each([
    'chore(deps): bump @framers/* deps to latest published versions (#18)',
    'fix(deps): bump @framers/* deps to latest published versions (#34)',
    'chore(deps-dev): bump vitest from 1.6.0 to 1.6.1',
    'chore: tidy the release guide',
    'chore(github): ask for the issue link, spec, pictures and docs in issues and pull requests (#38)',
    'ci: refuse a pull request title outside the Conventional Commits form',
    'docs: name the title check in the release guide',
    'test: cover the catalog order',
    'refactor: split the catalog loader',
    'feat: add a catalog query',
    'feat(catalog): add a catalog query',
    'fix: keep the catalog order stable',
    'perf: cache the parsed registry',
    'FIX: keep the catalog order stable',
    'revert: drop the catalog query',
    'Revert "feat: add a catalog query"\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.',
    'feat!: drop the CommonJS entry point',
    'chore(deps)!: require @framers/agentos 0.16 or later',
    'docs!: the guide moves',
    'chore: drop an export\n\nBREAKING CHANGE: the catalog drops the old ids.',
    'chore: drop an export\n\nBREAKING-CHANGE: the catalog drops the old ids.',
    'chore: drop an export\n\n  * breaking change the catalog drops the old ids.',
    'Land two idle pull requests in one batch: #31, #28 (#35)',
    'Land two idle pull requests in one batch: #31, #28 (#35)\n\nBREAKING CHANGE: the catalog drops the old ids.',
    'Merge pull request #39 from framerslab/ci/daily-release',
  ])('%s', async (message) => {
    expect(releaseReason(message, rules) !== null).toBe(await analyzerReleases(message));
  });
});

describe('release gate: what the package ships', () => {
  it.each([
    ['package.json', true],
    ['README.md', true],
    ['LICENSE', true],
    ['tsconfig.json', true],
    ['src/catalog.ts', true],
    ['src/catalog.spec.ts', false],
    ['dist/index.js', true],
    ['test/skills-registry.spec.ts', false],
    ['release.config.cjs', false],
    ['.github/workflows/release.yml', false],
    ['CONTRIBUTING.md', false],
    ['RELEASING.md', false],
    ['examples/capabilities/discord-community.CAPABILITY.yaml', false],
    ['scripts/check-install-latest-host.mjs', false],
  ])('%s ships: %s', (file, expected) => {
    expect(ships(file, pkg)).toBe(expected);
  });

  it('builds dist from src alone, so src and the tsconfig are the build inputs it counts', () => {
    const tsconfig = JSON.parse(fs.readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'));
    expect(tsconfig.compilerOptions.rootDir.replace(/^\.\//, '')).toBe('src');
    expect(tsconfig.compilerOptions.outDir.replace(/^\.\//, '')).toBe('dist');
    for (const pattern of tsconfig.include) expect(pattern.startsWith('src/')).toBe(true);
    expect(pkg.files).toEqual(['dist', 'README.md']);
  });
});

describe('release gate: a git history', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function repo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
    dirs.push(dir);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Release Gate',
      GIT_AUTHOR_EMAIL: 'gate@example.com',
      GIT_COMMITTER_NAME: 'Release Gate',
      GIT_COMMITTER_EMAIL: 'gate@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'master');
    const commit = (message, files) => {
      for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
      }
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    commit('feat: first', { 'package.json': '{}', 'src/index.ts': 'export {};\n' });
    return { dir, git, commit };
  }

  const run = (dir, force = false) => decide({ cwd: dir, force, pkg, config: releaseConfig });

  it('releases when no release tag is reachable', () => {
    const { dir } = repo();
    expect(run(dir)).toMatchObject({ releasable: true, lastTag: '' });
  });

  it('holds when nothing came after the tag, and when what came after does not release or ships nothing', () => {
    const { dir, git, commit } = repo();
    git('tag', 'v0.19.9');
    expect(run(dir)).toMatchObject({ releasable: false, lastTag: 'v0.19.9', commits: 0 });
    commit('docs: explain the catalog', { 'README.md': 'docs\n' });
    commit('feat: a test helper', { 'test/helper.spec.ts': 'export {};\n' });
    commit('chore(github): templates', { '.github/pull_request_template.md': 'x\n' });
    expect(run(dir)).toMatchObject({ releasable: false, commits: 3 });
  });

  it('releases a fix to src, a dependency bump and a breaking change, and reads the highest version tag', () => {
    const { dir, git, commit } = repo();
    git('tag', 'v0.18.4');
    git('tag', 'v0.19.0');
    git('tag', 'v0.9.0');
    commit('fix: keep the catalog order stable', { 'src/catalog.ts': 'export const order = 1;\n' });
    const result = run(dir);
    expect(result).toMatchObject({ releasable: true, lastTag: 'v0.19.0' });
    expect(result.releasing[0]).toMatchObject({ why: 'fix', files: ['src/catalog.ts'] });

    git('tag', 'v0.19.1');
    commit('fix(deps): bump @framers/* deps', { 'package.json': '{"dependencies":{}}' });
    expect(run(dir).releasing[0]).toMatchObject({ why: 'fix(deps)', files: ['package.json'] });

    git('tag', 'v0.19.2');
    commit('ci: move the release\n\nBREAKING CHANGE: hosts upgrade.', { 'tsconfig.json': '{}' });
    expect(run(dir).releasing[0]).toMatchObject({ why: 'breaking-change note', files: ['tsconfig.json'] });
  });

  it('counts a merge commit through the commits it brings in', () => {
    const { dir, git, commit } = repo();
    git('tag', 'v1.0.0');
    git('checkout', '-q', '-b', 'topic');
    commit('fix: a catalog bug', { 'src/catalog.ts': 'export const fixed = true;\n' });
    git('checkout', '-q', 'master');
    commit('docs: a note', { 'CONTRIBUTING.md': 'x\n' });
    git('merge', '-q', '--no-ff', '-m', 'Merge pull request #1 from topic', 'topic');
    const result = run(dir);
    expect(result).toMatchObject({ releasable: true, commits: 3 });
    expect(result.releasing.map((c) => c.why)).toEqual(['fix']);
  });

  it('releases on force without reading the commits', () => {
    const { dir, git } = repo();
    git('tag', 'v1.0.0');
    expect(run(dir, true)).toMatchObject({ releasable: true, reason: 'the force input skips the check' });
  });
});
