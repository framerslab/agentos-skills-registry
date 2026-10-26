// @ts-nocheck
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// The "Pull request title" check passes a title when `grep -E` matches the expression in
// .github/workflows/pr-title.yml. These cases read that expression from the workflow and run it through grep as
// the check does, so a change to the expression shows here.
const workflow = fs.readFileSync(new URL('../.github/workflows/pr-title.yml', import.meta.url), 'utf8');
const form = workflow.match(/^\s*form='([^']+)'$/m)[1];

/** Whether the check passes `title`: grep -E with the workflow's expression, run on the title as the check runs it. */
function passes(title) {
  const { status, error } = spawnSync('grep', ['-Eq', form], { input: `${title}\n` });
  if (error || (status !== 0 && status !== 1)) {
    throw error ?? new Error(`grep exited with ${status}`);
  }
  return status === 0;
}

// grep is the check's own program, and Windows has none on its default PATH, so the cases skip there; CI runs
// them on its ubuntu runner.
describe.skipIf(process.platform === 'win32')('pull request title check', () => {
  it.each([
    'ci: refuse a pull request title outside the Conventional Commits form',
    'fix(deps): bump @framers/* deps to latest published versions',
    'chore(deps): bump yaml from 2.8.1 to 2.8.2',
    'feat(api)!: drop the CommonJS entry point',
    'revert: drop the catalog query',
  ])('passes %s', (title) => {
    expect(passes(title)).toBe(true);
  });

  it.each([
    // No type: squashed with a blank body, the commit would release nothing, whatever it changed.
    'Land two idle pull requests in one batch: #31, #28 (#35)',
    // git revert's own subject. Squashed with this repository's blank body it carries no "This reverts commit"
    // line, so it would release nothing; the pull request is retitled revert: instead.
    'Revert "feat: add a catalog query"',
    // A type outside the list, breaking or not: a breaking change takes a listed type with `!`.
    'security!: rotate the signing keys',
    'Fix: keep the catalog order stable',
    'fix:keep the catalog order stable',
    'fix: ',
  ])('refuses %s', (title) => {
    expect(passes(title)).toBe(false);
  });
});
