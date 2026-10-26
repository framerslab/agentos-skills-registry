# Releasing @framers/agentos-skills-registry

Releases are automated. Every push to `master`, whether a merged pull request or a maintainer's commit, is evaluated for a release; nobody publishes by hand.

## What happens after a push to `master`

1. The release workflow ([`release.yml`](https://github.com/framerslab/agentos-skills-registry/blob/master/.github/workflows/release.yml)) starts on the push. It does not wait for the CI workflow: it runs the same steps itself. A push whose head commit message contains `[skip ci]` is skipped.
2. The workflow runs `pnpm install --no-frozen-lockfile`, `pnpm build` and `pnpm test`. A failing step stops the run before anything is released.
3. `pnpm exec semantic-release` reads every commit since the last version tag and decides the version with the rules below. With no releasing commit, nothing publishes.
4. On a release, [semantic-release](https://semantic-release.gitbook.io/) pushes the tag `v<version>`, then publishes the package to npm, which runs `prepublishOnly` (the build) first, and creates a GitHub release with the generated notes.

The release commits nothing to the repository. The `version` field in `package.json` on `master` is not the published version. The notes are on the [releases page](https://github.com/framerslab/agentos-skills-registry/releases).

The tag `v0.19.0` marks a version that was published to npm outside this workflow. It sits on the same commit as `v0.18.4`, and releases continue from it.

## Version rules

[`release.config.cjs`](https://github.com/framerslab/agentos-skills-registry/blob/master/release.config.cjs) sets the `conventionalcommits` preset and two rules of its own, each a patch: a `chore(deps)` commit, because a dependency bump changes the ranges the package installs, and a `revert:` commit, because the squash commit's body is blank and so carries no `This reverts commit` line for the default revert rule to read. The commit analyzer's default rules decide every other commit:

| Commit | Release | Example |
|---|---|---|
| `feat:` | minor | 0.19.0 to 0.20.0 |
| `fix:`, `perf:`, `revert:`, `chore(deps):`, a revert commit as `git revert` writes it | patch | 0.19.0 to 0.19.1 |
| any type with `!` before the colon, or a `BREAKING CHANGE:` footer | major | 0.19.0 to 1.0.0 |
| `docs:`, `chore:` (`chore(deps-dev):` included), `test:`, `ci:`, `build:`, `style:`, `refactor:` | none | |

The analyzer takes a commit to its default rules only when none of the configured rules matches it, so the configuration repeats the default breaking-change rule: a `chore(deps)` or `revert` commit with `!` or a `BREAKING CHANGE:` footer releases a major, as any breaking commit does. [`test/release-rules.spec.ts`](https://github.com/framerslab/agentos-skills-registry/blob/master/test/release-rules.spec.ts) runs the analyzer on this configuration for each row.

The package is below 1.0.0, and a breaking change releases 1.0.0.

## Merging

Maintainers squash-merge. semantic-release reads the squash commit's subject and body, so before confirming, check the merge box: the subject is the pull request title and the body is empty. For a change that breaks users, the title carries `!` and the merger adds a footer to the commit body in the merge box:

```text
BREAKING CHANGE: <what users must change>
```

That footer becomes the breaking-change note in the GitHub release.

A title outside the Conventional Commits form parses with no type, so no rule matches it by type: unless the commit body carries a `BREAKING CHANGE:` footer, it releases nothing, whatever the pull request changed. The "Pull request title" check ([`pr-title.yml`](https://github.com/framerslab/agentos-skills-registry/blob/master/.github/workflows/pr-title.yml)) refuses such a title while the pull request is open; retitle the pull request and the check runs again.

## Never

- Run `npm publish`.
- Create or move a `v` tag by hand. semantic-release takes the highest version tag on `master` as the last release.
- Push a code change to `master` with `[skip ci]` in the message.

There is no prerelease channel; every release comes from `master`.

## Secrets

The release workflow uses the `NPM_TOKEN` repository secret (an npm granular access token with read and write access to the `@framers` packages) and the `GITHUB_TOKEN` that GitHub Actions provides.

The weekly dependency bump ([`bump-framers-deps.yml`](https://github.com/framerslab/agentos-skills-registry/blob/master/.github/workflows/bump-framers-deps.yml)) pushes its branch and opens its pull request with `FRAMERS_BUMP_TOKEN`, a personal access token held as a framerslab organization secret, so CI and Links start on the pull request on their own: GitHub holds the runs of a pull request opened with `GITHUB_TOKEN` until someone with write access approves them. Without the secret, the bump's first step fails the run.

## Troubleshooting

- **No release published:** no commit since the last tag has a releasing type, or the build or a test failed before the release step.
- **npm publish fails:** for example a 401 when the `NPM_TOKEN` secret has expired or lacks write access to `@framers`. semantic-release pushes the `v<version>` tag before it publishes, so that version is tagged on GitHub and missing from npm, and it is not retried: the tag is the last release from then on. Fix the cause. The next releasing commit publishes the following version; that package contains the skipped version's changes, and its release notes list only the commits after the tag.
