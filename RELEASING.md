# Releasing @framers/agentos-skills-registry

Releases are automated and run once a day. At 10:17 UTC the release workflow checks master for changes to release since the last version tag and publishes them; nobody publishes by hand. A push to `master` runs CI's quick checks and never publishes.

## What happens each day

1. The release workflow ([`release.yml`](https://github.com/framerslab/agentos-skills-registry/blob/master/.github/workflows/release.yml)) starts on its schedule, at 10:17 UTC. GitHub can start a scheduled run late, or drop it, when Actions is busy.
2. Its first job, "Releasable changes", runs [`.github/scripts/release-gate.mjs`](https://github.com/framerslab/agentos-skills-registry/blob/master/.github/scripts/release-gate.mjs) with git and Node alone, before anything is installed. It reads every commit since the highest `v<version>` tag on `master` and counts a commit that both releases under the version rules below and changes what the package ships: `src/` (which `pnpm build` compiles into `dist`), `tsconfig.json`, `package.json`, `README.md` or `LICENSE`. It writes its decision and the commits behind it to the log and the run summary. With no such commit, the run ends there, green.
3. With one, the "Suite" job runs CI's whole suite on that commit ([`ci.yml`](https://github.com/framerslab/agentos-skills-registry/blob/master/.github/workflows/ci.yml), called with `release: true`): `pnpm install --no-frozen-lockfile`, `pnpm build`, `pnpm test` and the install check next to the latest `@framers/agentos`. A failing step stops the run before anything is released.
4. The "Release" job then runs `pnpm exec semantic-release`, which reads the same commits and decides the version with the rules below. With no releasing commit, nothing publishes.
5. On a release, [semantic-release](https://semantic-release.gitbook.io/) pushes the tag `v<version>`, then publishes the package to npm, which runs `prepublishOnly` (the build) first, and creates a GitHub release with the generated notes.

## Releasing now

To release without waiting for the next day, dispatch the workflow on `master`:

```bash
gh workflow run release.yml --ref master
```

or use "Run workflow" on the workflow's page under Actions. A dispatch runs the same check first. Two inputs, both off by default:

- `force`: skip the check and run the suite and semantic-release whatever changed. semantic-release still publishes nothing when no commit since the tag releases.
- `dry_run`: run the check, the suite and the release job up to the publish, and stop there; nothing is tagged, published or released.

```bash
gh workflow run release.yml --ref master -f dry_run=true
```

A dispatch on any branch other than `master` fails at its first step. One release run goes at a time; a run started while another is going waits for it and is never cancelled by it.

The release commits nothing to the repository. The `version` field in `package.json` on `master` is not the published version. The notes are on the [releases page](https://github.com/framerslab/agentos-skills-registry/releases).

The tag `v0.19.0` marks a version that was published to npm outside this workflow. It sits on the same commit as `v0.18.4`, and releases continue from it.

## Version rules

[`release.config.cjs`](https://github.com/framerslab/agentos-skills-registry/blob/master/release.config.cjs) sets the `conventionalcommits` preset and three release rules. Two are its own, each a patch: a `chore(deps)` commit, because a dependency bump changes the ranges the package installs, and a `revert:` commit, because the squash commit's body is blank and so carries no `This reverts commit` line for the default revert rule to read. The third repeats the default breaking-change rule, a major, for the reason given below the table. The commit analyzer's default rules decide every other commit:

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

There is no prerelease channel; every release comes from `master`.

## Secrets

The release workflow uses the `NPM_TOKEN` repository secret (an npm granular access token with read and write access to the `@framers` packages) and the `GITHUB_TOKEN` that GitHub Actions provides.

The weekly dependency bump ([`bump-framers-deps.yml`](https://github.com/framerslab/agentos-skills-registry/blob/master/.github/workflows/bump-framers-deps.yml)) pushes its branch and opens its pull request with `FRAMERS_BUMP_TOKEN`, a personal access token held as a framerslab organization secret, so CI and Links start on the pull request on their own: GitHub holds the runs of a pull request opened with `GITHUB_TOKEN` until someone with write access approves them. Without the secret, the bump's first step fails the run.

## Troubleshooting

- **No release published:** the day's run found no commit since the last tag that both has a releasing type and changes a shipped file (the "Releasable changes" job's summary names what it read), or the build or a test failed before the release step. A change merged after 10:17 UTC publishes the next day, or at once through a dispatch.
- **npm publish fails:** for example a 401 when the `NPM_TOKEN` secret has expired or lacks write access to `@framers`. semantic-release pushes the `v<version>` tag before it publishes, so that version is tagged on GitHub and missing from npm, and it is not retried: the tag is the last release from then on. Fix the cause. The next release run with a releasing commit publishes the following version; that package contains the skipped version's changes, and its release notes list only the commits after the tag.
