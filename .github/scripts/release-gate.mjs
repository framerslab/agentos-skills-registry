#!/usr/bin/env node
// Decides whether master holds a change to release since the last release tag, before the daily release
// installs anything. A commit counts when release.config.cjs's rules would release it (its type and scope,
// a `!` before the colon, a BREAKING CHANGE note, or a revert) and it changes a file the package ships or
// a file the build reads to make one (src/, tsconfig.json). Merge commits count through the commits they
// bring in, as semantic-release reads them. The decision errs towards releasing: semantic-release reads the
// same commits again and publishes nothing when none of them releases (a commit and its revert in the same
// range, for one).
//
// FORCE=true skips the check. The result goes to $GITHUB_OUTPUT as releasable=true|false, and the reason
// to the log and the run's summary. It needs git and node only.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The parser options of the conventionalcommits preset that release.config.cjs names, as
// conventional-changelog-conventionalcommits 8.0.0 publishes them (src/parser.js, src/utils.js).
// test/release-gate.spec.ts compares them with the installed preset's own.
export const CONVENTIONALCOMMITS_PARSER = {
  headerPattern: /^(\w*)(?:\((.*)\))?!?: (.*)$/,
  breakingHeaderPattern: /^(\w*)(?:\((.*)\))?!: (.*)$/,
  noteKeywords: ['BREAKING CHANGE', 'BREAKING-CHANGE'],
  revertPattern: /^(?:Revert|revert:)\s"?([\s\S]+?)"?\s*This reverts commit (\w*)\./i,
};

// The commit analyzer's own rules that this parser's fields (type, scope) can match, read when none of the
// configured rules matches a commit (@semantic-release/commit-analyzer 13.0.1, lib/default-release-rules.js).
// Its breaking and revert rules are read from the message below; its emoji, tag and component rules match
// fields this parser never sets.
const DEFAULT_TYPE_RULES = [
  { type: 'feat', release: 'minor' },
  { type: 'fix', release: 'patch' },
  { type: 'perf', release: 'patch' },
  { type: 'FEAT', release: 'minor' },
  { type: 'FIX', release: 'patch' },
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a change to `path` changes what the package publishes: npm packs every file under a `files` entry,
 * and `dist` is built by `tsc` (`pnpm build`) from tsconfig.json, which compiles every file under src/, so
 * those are counted too. test/release-gate.spec.ts holds tsconfig.json to that shape.
 */
export function ships(path, pkg) {
  if (path === 'package.json') return true;
  // npm packs these whatever "files" says.
  if (/^(README|LICEN[CS]E)(\.[^/]*)?$/i.test(path)) return true;
  // The build's inputs: the one tsconfig `tsc` reads, and everything it compiles (src/**/*.ts, test files
  // under src/ included).
  if (path === 'tsconfig.json') return true;
  if (path.startsWith('src/')) return true;
  if (pkg.main && path === pkg.main.replace(/^\.\//, '')) return true;
  const roots = (pkg.files ?? []).map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''));
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** The commit analyzer's options from release.config.cjs: its rules and its parser patterns. */
export function releaseRulesOf(config) {
  const analyzer = config.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === '@semantic-release/commit-analyzer');
  const options = Array.isArray(analyzer) ? (analyzer[1] ?? {}) : {};
  if (options.preset !== 'conventionalcommits' || options.config) {
    // This gate knows one parser. A new preset is read into it before the release uses it.
    throw new Error(`release-gate knows the conventionalcommits preset only; release.config.cjs names ${options.config ?? options.preset ?? 'the default (angular)'}`);
  }
  const parser = { ...CONVENTIONALCOMMITS_PARSER, ...(options.parserOpts ?? {}) };
  return {
    // Only rules on the type and scope: the breaking and revert rules are read from the message.
    rules: (options.releaseRules ?? []).filter((rule) => rule.release && rule.type && !rule.breaking && !rule.revert),
    header: parser.headerPattern,
    breakingHeader: parser.breakingHeaderPattern,
    noteKeywords: parser.noteKeywords,
    revert: parser.revertPattern,
  };
}

const matches = (rule, type, scope) => rule.type === type && (rule.scope === undefined || rule.scope === scope);

/** How a commit message releases: its type, `!`, a breaking-change note or a revert; null when it does not. */
export function releaseReason(message, { rules, header, breakingHeader, noteKeywords, revert }) {
  const [first = '', ...rest] = message.split('\n');
  // conventional-commits-parser 6.4's note line, case-insensitive (dist/regex.js): an indented note, a starred
  // one and one without its colon all count.
  const notes = new RegExp(`^[\\s|*]*(${noteKeywords.map(escape).join('|')})[:\\s]+`, 'i');
  if (rest.some((line) => notes.test(line))) return 'breaking-change note';
  if (breakingHeader && breakingHeader.test(first)) return `${breakingHeader.exec(first)[1]}!`;
  // git's `Revert "<header>"` message; the analyzer's own rules release a revert as a patch.
  if (revert && revert.test(message)) return 'revert';
  const match = header.exec(first);
  if (!match) return null;
  const [, type = '', scope] = match;
  // The configured rules first; the analyzer reads its own only for a commit none of them matches.
  const rule = rules.find((r) => matches(r, type, scope)) ?? DEFAULT_TYPE_RULES.find((r) => matches(r, type, scope));
  if (!rule) return null;
  return scope ? `${type}(${scope})` : type;
}

/** The newest release tag reachable from HEAD, by version, or '' when there is none. */
export function lastReleaseTag(git, tagFormat) {
  const [prefix, suffix = ''] = tagFormat.split('${version}');
  // A SemVer release version: no leading zero in a number, no pre-release or build part, as semantic-release
  // reads a release on a branch with no prerelease channel.
  const number = '(0|[1-9]\\d*)';
  const pattern = new RegExp(`^${escape(prefix)}${number}\\.${number}\\.${number}${escape(suffix)}$`);
  const tags = git('tag', '--merged', 'HEAD')
    .split('\n')
    .map((tag) => [tag.trim(), pattern.exec(tag.trim())])
    .filter(([, match]) => match)
    .map(([tag, match]) => ({ tag, version: match.slice(1, 4).map(Number) }));
  tags.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  return tags[0]?.tag ?? '';
}

/**
 * Reads the commits after the last release tag and decides.
 * @returns {{ releasable: boolean, reason: string, lastTag: string, commits: number, releasing: Array<{sha: string, header: string, why: string, files: string[]}> }}
 */
export function decide({ cwd, force = false, pkg, config }) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  const lastTag = lastReleaseTag(git, config.tagFormat ?? 'v${version}');
  if (force) {
    return { releasable: true, reason: 'the force input skips the check', lastTag, commits: 0, releasing: [] };
  }
  if (!lastTag) {
    return { releasable: true, reason: 'no release tag is reachable from master', lastTag, commits: 0, releasing: [] };
  }
  const rules = releaseRulesOf(config);
  const shas = git('rev-list', `${lastTag}..HEAD`).split('\n').filter(Boolean);
  const releasing = [];
  for (const sha of shas) {
    const message = git('log', '-1', '--format=%B', sha);
    const why = releaseReason(message, rules);
    if (!why) continue;
    const parent = git('rev-list', '--parents', '-n', '1', sha).split(' ')[1];
    // A merge commit's own change is the one its first parent lacks. -z gives each path as it is, unquoted
    // (git quotes a path with a non-ASCII character otherwise), ended by a NUL.
    const changed = parent
      ? git('diff-tree', '-r', '-z', '--no-commit-id', '--name-only', '--no-renames', parent, sha)
      : git('ls-tree', '-r', '-z', '--name-only', sha);
    const files = changed.split('\0').filter((path) => path && ships(path, pkg));
    if (files.length) releasing.push({ sha, header: message.split('\n')[0], why, files });
  }
  const reason = releasing.length
    ? `${releasing.length} of ${shas.length} commits since ${lastTag} release and change what the package ships`
    : `none of the ${shas.length} commits since ${lastTag} both releases by release.config.cjs and changes what the package ships`;
  return { releasable: releasing.length > 0, reason, lastTag, commits: shas.length, releasing };
}

/**
 * The decision as text: `log` for the job's log and `summary` (Markdown) for the run's summary. A commit's
 * subject and its paths come from whoever wrote the commit, so each is printed on one line with its control
 * characters escaped (a path may hold a newline, and a log line that starts with `::` is a workflow command),
 * and the summary shows them inside a code fence longer than any run of backticks they hold.
 */
export function report(result) {
  // JSON string escapes, without the quotes: \n, \r, \u001b and the rest.
  const oneLine = (text) => JSON.stringify(String(text)).slice(1, -1);
  const lines = [`Releasable: ${result.releasable ? 'yes' : 'no'}. ${result.reason}.`];
  for (const commit of result.releasing) {
    const files = commit.files.slice(0, 5).map((file) => JSON.stringify(file)).join(', ');
    const more = commit.files.length > 5 ? `, and ${commit.files.length - 5} more` : '';
    lines.push(`- ${commit.sha.slice(0, 7)} ${oneLine(commit.header)} (${oneLine(commit.why)}): ${files}${more}`);
  }
  const log = lines.join('\n');
  const longest = Math.max(0, ...(log.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const summary = `### Releasable changes\n\n${fence}text\n${log}\n${fence}\n`;
  return { log, summary };
}

function main() {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const config = createRequire(import.meta.url)(resolve(root, 'release.config.cjs'));
  const result = decide({ cwd: root, force: process.env.FORCE === 'true', pkg, config });
  const { log, summary } = report(result);
  console.log(log);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `releasable=${result.releasable}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
