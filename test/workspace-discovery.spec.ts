// @ts-nocheck
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
namespace: community
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
    expect(skills[0]?.namespace).toBe('community');

    const loaded = await skills[0]!.loadSkill();
    expect(loaded.name).toBe('github-helper');
    expect(loaded.frontmatter.name).toBe('github-helper');
    expect(loaded.metadata?.primaryEnv).toBe('GITHUB_TOKEN');
    expect(loaded.metadata?.emoji).toBe('\u{1F419}');
    expect(loaded.metadata?.requires?.bins).toEqual(['gh']);
    expect(loaded.content).toContain('Use gh to manage repositories');
  });
});
