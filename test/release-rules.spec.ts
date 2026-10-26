// @ts-nocheck
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The release decides its version with the commit analyzer that semantic-release loads, configured by
// release.config.cjs. These cases run that analyzer on that configuration. It is resolved from
// semantic-release's own directory, as semantic-release resolves a plugin it names (lib/plugins/utils.js,
// loadPlugin), and each case is one commit since the last release.
const localRequire = createRequire(import.meta.url);
const releaseConfig = localRequire('../release.config.cjs');
const analyzerPath = createRequire(localRequire.resolve('semantic-release')).resolve('@semantic-release/commit-analyzer');
const [, analyzerConfig] = releaseConfig.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/commit-analyzer'
);
const cwd = fileURLToPath(new URL('..', import.meta.url));

async function releaseFor(message) {
  const { analyzeCommits } = await import(pathToFileURL(analyzerPath).href);
  return analyzeCommits(analyzerConfig, {
    cwd,
    commits: [{ hash: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', message }],
    logger: { log() {} },
  });
}

describe('release rules', () => {
  it.each([
    // The dependency bump's title before it became fix(deps).
    ['chore(deps): bump @framers/* deps to latest published versions (#18)', 'patch'],
    ['fix(deps): bump @framers/* deps to latest published versions (#34)', 'patch'],
    ['chore(deps-dev): bump vitest from 1.6.0 to 1.6.1', null],
    ['chore: tidy the release guide', null],
    ['ci: refuse a pull request title outside the Conventional Commits form', null],
    ['docs: name the title check in the release guide', null],
    ['feat: add a catalog query', 'minor'],
    ['fix: keep the catalog order stable', 'patch'],
    ['Revert "feat: add a catalog query"\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.', 'patch'],
    ['feat!: drop the CommonJS entry point', 'major'],
    // The repeated default breaking rule: a commit that a configured rule matches never reaches the defaults.
    ['chore(deps)!: require @framers/agentos 0.16 or later', 'major'],
    ['chore(deps): bump @framers/agentos to 0.16.0\n\nBREAKING CHANGE: hosts on @framers/agentos 0.15 must upgrade.', 'major'],
    // A title outside the form parses with no type and releases nothing, whatever the commit changed. The
    // Pull request title check refuses such a title before the merge.
    ['Land two idle pull requests in one batch: #31, #28 (#35)', null],
  ])('%s releases %s', async (message, release) => {
    expect(await releaseFor(message)).toBe(release);
  });
});
