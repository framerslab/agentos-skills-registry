// The commit analyzer parses each commit with the conventionalcommits preset and decides it with the rules
// below first; only a commit that none of them matches goes on to the analyzer's default rules (feat a
// minor; fix, perf and a revert a patch; a breaking change a major). A commit that matches a rule here never
// reaches the defaults, so the default breaking rule is repeated: without it, a breaking chore(deps) or
// revert commit would release a patch.
// https://github.com/semantic-release/commit-analyzer/blob/v13.0.1/index.js#L57-L67
//
// chore(deps) releases a patch, because a dependency bump changes the ranges the package installs.
// chore(deps-dev) changes nothing a user installs, and like every other chore it releases nothing.
// revert releases a patch: the squash commit's body is blank, so a revert pull request reaches master as a
// revert: subject without the "This reverts commit" line that the default revert rule reads.
module.exports = {
  branches: ['master'],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'conventionalcommits',
        releaseRules: [
          { breaking: true, release: 'major' },
          { type: 'chore', scope: 'deps', release: 'patch' },
          { type: 'revert', release: 'patch' },
        ],
      },
    ],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    '@semantic-release/npm',
    '@semantic-release/github',
  ],
};
