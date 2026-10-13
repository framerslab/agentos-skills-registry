// @ts-nocheck
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverWorkspaceSkills, parseSkillFrontmatter } from '../src/workspace-discovery';

const tempDirs: string[] = [];

async function createTempSkillsDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentos-skills-registry-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('workspace skill discovery', () => {
  it('parses nested metadata blocks from workspace frontmatter', () => {
    const parsed = parseSkillFrontmatter(`---
name: github-helper
description: Workspace GitHub helper.
metadata:
  agentos:
    emoji: "\\U0001F419"
    primaryEnv: GITHUB_TOKEN
    requires:
      bins: ['gh']
---

# Workspace GitHub Helper
`);

    expect(parsed?.metadata).toMatchObject({
      agentos: {
        emoji: '\u{1F419}',
        primaryEnv: 'GITHUB_TOKEN',
        requires: { bins: ['gh'] },
      },
    });
  });

  it('loads workspace skills with parsed metadata through the shared loader path', async () => {
    const skillsDir = await createTempSkillsDir();
    const githubDir = path.join(skillsDir, 'github-helper');
    await fs.mkdir(githubDir, { recursive: true });
    await fs.writeFile(
      path.join(githubDir, 'SKILL.md'),
      `---
name: github-helper
description: Workspace GitHub helper.
category: developer-tools
tags: [github, workspace]
requires_secrets: [github.token]
requires_tools: [filesystem]
metadata:
  agentos:
    emoji: "\\U0001F419"
    primaryEnv: GITHUB_TOKEN
    requires:
      bins: ['gh']
---

# Workspace GitHub Helper

Use gh to manage repositories from the local workspace.
`,
      'utf-8',
    );

    const skills = await discoverWorkspaceSkills({ skillsDir });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('github-helper');
    expect(skills[0]?.requiredSecrets).toEqual(['github.token']);
    expect(skills[0]?.requiredTools).toEqual(['filesystem']);

    const loaded = await skills[0]!.loadSkill();
    expect(loaded.name).toBe('github-helper');
    expect(loaded.frontmatter.name).toBe('github-helper');
    expect(loaded.metadata?.primaryEnv).toBe('GITHUB_TOKEN');
    expect(loaded.metadata?.emoji).toBe('\u{1F419}');
    expect(loaded.metadata?.requires?.bins).toEqual(['gh']);
    expect(loaded.content).toContain('Use gh to manage repositories');
  });
});

describe('workspace skill discovery does not follow links', () => {
  // Text in files outside the skills folder. Each of those files has frontmatter with a name, so a read that followed
  // a link to one would list it as a skill: none of this text may appear in what discovery returns.
  const OUTSIDE_FILE = 'Outside file text, which no workspace skill may read.';
  const OUTSIDE_FOLDER = 'Outside folder text, which no workspace skill may read.';

  let warn;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  /** SKILL.md text for the skill `name`, whose description and body are both `text`. */
  function skillText(name: string, text: string): string {
    return `---\nname: ${name}\ndescription: ${text}\n---\n\n${text}\n`;
  }

  /** Make the folder `folderName` below `parent` with a SKILL.md holding `text`, and return the folder. */
  async function addSkill(parent: string, folderName: string, text: string): Promise<string> {
    const dir = path.join(parent, folderName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), text, 'utf-8');
    return dir;
  }

  /**
   * A workspace whose skills folder is the default `.agents/skills`, holding one real skill, good-skill; and beside
   * the workspace, a folder outside it holding notes.md and skill-folder/SKILL.md, both with outside text.
   */
  async function workspace(): Promise<{ cwd: string; skillsDir: string; outside: string }> {
    const root = await createTempSkillsDir();
    const cwd = path.join(root, 'workspace');
    const skillsDir = path.join(cwd, '.agents', 'skills');
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'notes.md'), skillText('outside-file', OUTSIDE_FILE), 'utf-8');
    await addSkill(outside, 'skill-folder', skillText('outside-folder', OUTSIDE_FOLDER));
    await addSkill(skillsDir, 'good', skillText('good-skill', 'Good skill text.'));
    return { cwd, skillsDir, outside };
  }

  /** The warning lines this package wrote, sorted. */
  function ownWarnings(): string[] {
    return warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[agentos-skills-registry]'))
      .sort();
  }

  it.skipIf(process.platform === 'win32')(
    'a skill folder that is a link and a SKILL.md that is a link are skipped with a warning, nothing outside is read, and the real skill is read',
    async () => {
      const { cwd, skillsDir, outside } = await workspace();
      // linked-folder is a link to the folder outside.
      const linkedFolder = path.join(skillsDir, 'linked-folder');
      await fs.symlink(path.join(outside, 'skill-folder'), linkedFolder, 'dir');
      // linked-file is a real folder whose SKILL.md is a link to the file outside.
      const linkedFile = path.join(skillsDir, 'linked-file');
      await fs.mkdir(linkedFile);
      await fs.symlink(path.join(outside, 'notes.md'), path.join(linkedFile, 'SKILL.md'));

      const skills = await discoverWorkspaceSkills({ cwd });
      const loaded = await skills[0]?.loadSkill();

      expect(skills.map((skill) => skill.name)).toEqual(['good-skill']);
      expect(loaded?.content).toBe('Good skill text.');
      const returned = JSON.stringify({ skills, loaded });
      expect(returned).not.toContain(OUTSIDE_FILE);
      expect(returned).not.toContain(OUTSIDE_FOLDER);
      expect(ownWarnings()).toEqual(
        [
          `[agentos-skills-registry] Skipped the workspace skill at ${linkedFolder}: the skill folder is a symbolic link.`,
          `[agentos-skills-registry] Skipped the workspace skill at ${linkedFile}: its SKILL.md is a symbolic link.`,
        ].sort(),
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    "a discovered skill's loader rejects once its SKILL.md or its folder has become a link, and reads nothing outside",
    async () => {
      const { cwd, skillsDir, outside } = await workspace();
      const laterFile = await addSkill(skillsDir, 'later-file', skillText('later-file', 'Later file text.'));
      const laterFolder = await addSkill(skillsDir, 'later-folder', skillText('later-folder', 'Later folder text.'));

      const skills = await discoverWorkspaceSkills({ cwd });
      const byName = new Map(skills.map((skill) => [skill.name, skill]));
      // After discovery, as a pull or a checkout could, later-file's SKILL.md becomes a link to the file outside and
      // later-folder becomes a link to the folder outside.
      await fs.rm(path.join(laterFile, 'SKILL.md'));
      await fs.symlink(path.join(outside, 'notes.md'), path.join(laterFile, 'SKILL.md'));
      await fs.rm(laterFolder, { recursive: true });
      await fs.symlink(path.join(outside, 'skill-folder'), laterFolder, 'dir');

      const fileLoad = await byName.get('later-file')?.loadSkill().catch((err) => err);
      const folderLoad = await byName.get('later-folder')?.loadSkill().catch((err) => err);
      const goodLoad = await byName.get('good-skill')?.loadSkill();

      expect([...byName.keys()].sort()).toEqual(['good-skill', 'later-file', 'later-folder']);
      expect(fileLoad).toBeInstanceOf(Error);
      expect(fileLoad.message).toBe(
        `Failed to load SKILL.md at ${path.join(laterFile, 'SKILL.md')}: its SKILL.md is a symbolic link`,
      );
      expect(folderLoad).toBeInstanceOf(Error);
      expect(folderLoad.message).toBe(
        `Failed to load SKILL.md at ${path.join(laterFolder, 'SKILL.md')}: the skill folder is a symbolic link`,
      );
      expect(goodLoad?.content).toBe('Good skill text.');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a SKILL.md that is a named pipe is skipped with a warning at once, with no wait for a writer',
    async () => {
      const { cwd, skillsDir } = await workspace();
      const piped = path.join(skillsDir, 'piped');
      await fs.mkdir(piped);
      // A named pipe that no process writes: a read that waited would wait for ever.
      execFileSync('mkfifo', [path.join(piped, 'SKILL.md')]);

      const skills = await discoverWorkspaceSkills({ cwd });

      expect(skills.map((skill) => skill.name)).toEqual(['good-skill']);
      expect(ownWarnings()).toEqual([
        `[agentos-skills-registry] Skipped the workspace skill at ${piped}: its SKILL.md is not a regular file.`,
      ]);
    },
    15_000,
  );

  it.skipIf(process.platform === 'win32')(
    'a SKILL.md swapped between its look and its open for a second name of the file outside is skipped with a warning, and that file is not read',
    async () => {
      const { cwd, skillsDir, outside } = await workspace();
      const swapped = await addSkill(skillsDir, 'swapped', skillText('swapped', 'Swapped text.'));
      const skillFile = path.join(swapped, 'SKILL.md');
      // Just before swapped/SKILL.md is opened, a hard link to the file outside takes its place. A hard link is no
      // symbolic link, so only the check that the open reached the file the look saw refuses it.
      const realOpen = fsp.open.bind(fsp);
      const swaps: string[] = [];
      const open = vi.spyOn(fsp, 'open').mockImplementation(async (file, flags, mode) => {
        if (String(file) === skillFile && swaps.length === 0) {
          swaps.push(String(file));
          await fs.link(path.join(outside, 'notes.md'), path.join(swapped, 'incoming.md'));
          await fs.rename(path.join(swapped, 'incoming.md'), skillFile);
        }
        return realOpen(file, flags, mode);
      });

      const skills = await discoverWorkspaceSkills({ cwd }).finally(() => open.mockRestore());

      expect(swaps).toEqual([skillFile]);
      expect(skills.map((skill) => skill.name)).toEqual(['good-skill']);
      expect(JSON.stringify(skills)).not.toContain(OUTSIDE_FILE);
      expect(ownWarnings()).toEqual([
        `[agentos-skills-registry] Skipped the workspace skill at ${swapped}: its SKILL.md was replaced while it was being opened.`,
      ]);
    },
  );
});
